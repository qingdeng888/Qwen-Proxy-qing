const axios = require('axios')
const accountManager = require('./account.js')
const config = require('../config/index.js')
const { logger } = require('./logger')
const { getProxyAgent, getChatBaseUrl, buildAgentForUrl, getProxyHost } = require('./proxy-helper')
const usageTracker = require('./usage-tracker')
const { chatIdPool } = require('./chat-id-pool')
const { requestJitter, accountRateLimiter, detectUpstreamBlock, deleteChatAfterUse } = require('./request-fingerprint')
const { http2Stream, http2Request } = require('./http2-client')

// Errors that look like the proxy is dead (TCP-level / DNS / handshake).
// Anything in this set on a proxied request triggers proxy failover.
const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
    'ENETUNREACH', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
])

function isProxyShapedError(err) {
    if (!err) return false
    if (NETWORK_ERROR_CODES.has(err.code)) return true
    const msg = String(err.message || '')
    return /timeout|ECONN|socket|ENETUNREACH|tunneling|WAF_BLOCKED/.test(msg)
}

/**
 * Resolve the proxy decision for the current account.
 */
async function resolveAccountProxy(email) {
    if (!email) return { mode: 'smart', proxyUrl: null }
    if (typeof accountManager.getProxyDecisionForAccount === 'function') {
        return await accountManager.getProxyDecisionForAccount(email)
    }
    if (!accountManager.proxyPool) return { mode: 'smart', proxyUrl: null }
    const url = await accountManager.getProxyForAccount(email)
    return { mode: 'smart', proxyUrl: url }
}

/**
 * Resolve the effective proxy URL for a request.
 * Returns null when direct connection is intended.
 */
function resolveEffectiveProxy(proxyDecision, currentProxy) {
    if (proxyDecision.mode === 'none') return null
    if (currentProxy) return currentProxy
    // Legacy fallback: config.proxyUrl
    return config.proxyUrl || null
}

/**
 * Send chat request using HTTP/2
 * 
 * Uses Node.js native http2 module for TLS fingerprint alignment with
 * real browsers. Includes cookies from Playwright browser login sessions.
 *
 * @param {Object} body - Request body
 * @returns {Promise<{status:boolean,response:Object|null,currentToken?:string,currentEmail?:string}>}
 */
const sendChatRequest = async (body) => {
    if (typeof accountManager.ensureInitialized === 'function') {
        try { await accountManager.ensureInitialized() } catch { /* fall through */ }
    }

    const MAX_RETRIES = Math.max(1, config.proxyMaxRetries || 3)
    let lastError = null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const accountInfo = accountManager.accountRotator
            && typeof accountManager.accountRotator.getNextAccountInfo === 'function'
            ? accountManager.accountRotator.getNextAccountInfo()
            : null
        const currentToken = accountInfo ? accountInfo.token : accountManager.getAccountToken()
        const currentEmail = accountInfo ? accountInfo.email : null

        if (!currentToken) {
            logger.error('Cannot get valid access token', 'TOKEN')
            return { status: false, response: null }
        }

        // Skip rate-limited accounts
        if (currentEmail && accountRateLimiter.isLimited(currentEmail)) {
            logger.warn(`Skipping rate-limited account: ${currentEmail}`, 'RATELIMIT')
            continue
        }

        // Anti-detection: random jitter before each request
        await requestJitter()

        try { usageTracker.recordAccountAttempt({ email: currentEmail }) } catch { /* never block on stats */ }

        const proxyDecision = await resolveAccountProxy(currentEmail)
        const currentProxy = proxyDecision.proxyUrl
        const effectiveProxy = resolveEffectiveProxy(proxyDecision, currentProxy)

        // Get cookies from browser login session
        const cookies = accountManager.getCookiesByEmail(currentEmail)

        try {
            const chat_id = await generateChatID(currentToken, body.model, currentEmail, currentProxy, proxyDecision.mode)

            logger.network(`Sending chat request via HTTP/2 (attempt ${attempt}/${MAX_RETRIES}, proxy: ${getProxyHost(effectiveProxy)})`, 'REQUEST')

            const path = `/api/v2/chat/completions?chat_id=${chat_id}`
            const payload = { ...body, stream: true, chat_id }

            const { status, stream, headers } = await http2Stream(path, payload, currentToken, cookies, {
                proxyUrl: effectiveProxy,
                timeout: 60000,
            })

            if (status === 200) {
                logger.info(`[DEBUG] HTTP/2 request succeeded, status=200, content-type=${headers['content-type']}`, 'REQUEST')

                // Clear rate limit on successful connection
                accountRateLimiter.clearLimit(currentEmail)

                // Schedule chat deletion after stream ends
                stream.once('end', () => {
                    http2Request('DELETE', `/api/v2/chats/${chat_id}`, null, currentToken, cookies, {
                        proxyUrl: effectiveProxy,
                        timeout: 10000,
                    }).catch(() => {})
                })

                return {
                    currentToken,
                    currentEmail,
                    status: true,
                    response: stream
                }
            }

            lastError = new Error(`HTTP/2 request failed with status ${status}`)
            try { usageTracker.recordAccountFailure({ email: currentEmail }) } catch { /* swallow */ }

        } catch (error) {
            lastError = error
            try { usageTracker.recordAccountFailure({ email: currentEmail }) } catch { /* swallow */ }
            logger.error(`Chat request failed (attempt ${attempt}/${MAX_RETRIES}, proxy: ${getProxyHost(effectiveProxy)}): ${error.message}`, 'REQUEST')

            // WAF blocks should rate-limit the account and retry
            if (error.message && error.message.includes('WAF_BLOCKED')) {
                accountRateLimiter.markLimited(currentEmail, 'waf_blocked')
                if (attempt < MAX_RETRIES) continue
                break
            }

            // Proxy-shaped errors are retryable in smart mode
            if (effectiveProxy && currentEmail && proxyDecision.mode === 'smart' && isProxyShapedError(error) && attempt < MAX_RETRIES) {
                logger.warn('Proxy-shaped failure — rotating proxy and retrying', 'PROXY')
                await accountManager.handleNetworkFailure(currentEmail, effectiveProxy)
                continue
            }
            break
        }
    }

    if (lastError) {
        logger.error(`Failed to send chat request: ${lastError.message}`, 'REQUEST', '', lastError)
    }
    return { status: false, response: null }
}

/**
 * Generate chat_id using HTTP/2
 * @param {string} currentToken - Current token
 * @param {string} model - Model name
 * @param {string} [email] - Account email
 * @param {string} [proxyUrl] - Proxy URL
 * @param {'smart'|'fixed'|'none'} [proxyMode] - Account proxy mode
 * @returns {Promise<string|null>} Generated chat_id or null
 */
const generateChatID = async (currentToken, model, email = null, proxyUrl = null, proxyMode = 'smart') => {
    // Fast path: try the warmup pool first
    if (email) {
        const pooled = chatIdPool.acquire(email)
        if (pooled) {
            return pooled
        }
    }

    try {
        const cookies = accountManager.getCookiesByEmail(email)
        let effectiveProxy = null
        if (proxyMode === 'none') {
            effectiveProxy = null
        } else if (proxyUrl) {
            effectiveProxy = proxyUrl
        } else {
            effectiveProxy = config.proxyUrl || null
        }

        const { status, data } = await http2Request('POST', '/api/v2/chats/new', {
            title: "New Chat",
            models: [model],
            chat_mode: "normal",
            chat_type: "t2t",
            timestamp: Date.now(),
        }, currentToken, cookies, {
            proxyUrl: effectiveProxy,
            timeout: 15000,
        })

        if (status === 200 && data && data.data && data.data.id) {
            return data.data.id
        }

        // Check for WAF/error
        if (status !== 200) {
            logger.warn(`generateChatID got status ${status}`, 'CHAT')
        }

        return null
    } catch (error) {
        logger.error(`Failed to generate chat_id: ${error.message}`, 'CHAT')
        return null
    }
}

module.exports = {
    sendChatRequest,
    generateChatID
}
