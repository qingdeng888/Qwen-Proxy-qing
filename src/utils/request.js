const axios = require('axios')
const accountManager = require('./account.js')
const config = require('../config/index.js')
const { logger } = require('./logger')
const { getSsxmodItna, getSsxmodItna2 } = require('./ssxmod-manager')
const { getProxyAgent, getChatBaseUrl, buildAgentForUrl, getProxyHost } = require('./proxy-helper')
const usageTracker = require('./usage-tracker')
const { chatIdPool } = require('./chat-id-pool')

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
    return /timeout|ECONN|socket|ENETUNREACH|tunneling/.test(msg)
}

/**
 * Resolve the proxy decision for the current account. Returns the
 * three-mode object so callers can distinguish "no pool / no fixed url
 * → fall back to legacy single-proxy" from "operator explicitly chose
 * direct connection".
 *
 *   - mode='none'  → skip legacy fallback entirely (force direct)
 *   - mode='fixed' → use proxyUrl if set, else fall back to legacy
 *   - mode='smart' → pool binding if present, else fall back to legacy
 *
 * @param {string} email
 * @returns {Promise<{mode:'smart'|'fixed'|'none', proxyUrl:string|null}>}
 */
async function resolveAccountProxy(email) {
    if (!email) return { mode: 'smart', proxyUrl: null }
    if (typeof accountManager.getProxyDecisionForAccount === 'function') {
        return await accountManager.getProxyDecisionForAccount(email)
    }
    // Legacy path (account-manager older than this feature) — preserve
    // the old "string-or-null" contract by widening it here.
    if (!accountManager.proxyPool) return { mode: 'smart', proxyUrl: null }
    const url = await accountManager.getProxyForAccount(email)
    return { mode: 'smart', proxyUrl: url }
}

/**
 * Send chat request
 * Retries up to config.proxyMaxRetries times when the proxy looks dead.
 * Each retry asks the smart pool for a fresh binding.
 *
 * Side-effect: usageTracker.recordAccountAttempt is called on each
 * attempt, recordAccountFailure on per-attempt errors. Stream-level
 * success / token counts are NOT recorded here — the caller must
 * attach `usageTracker.attachStreamTracker(response, { apiKey, email })`
 * once it has the stream, since the upstream stream is consumed by the
 * caller and we don't want to double-instrument it.
 *
 * @param {Object} body - Request body
 * @returns {Promise<{status:boolean,response:Object|null,currentToken?:string,currentEmail?:string}>}
 *          On success: { status:true, response:stream, currentToken, currentEmail }.
 *          On failure: { status:false, response:null }.
 */
const sendChatRequest = async (body) => {
    // Wait for the (lazy, async) account-manager init before doing
    // anything else. Without this, on Vercel's per-request isolated
    // function instances, requests that arrive before _initialize()
    // finishes its first signin call see token === '' and bail out
    // with "Cannot get valid access token", even though the very next
    // request (a few hundred ms later, after signin completes) succeeds.
    if (typeof accountManager.ensureInitialized === 'function') {
        try { await accountManager.ensureInitialized() } catch { /* fall through */ }
    }

    const MAX_RETRIES = Math.max(1, config.proxyMaxRetries || 3)
    let lastError = null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // One rotator advance per attempt — picking a fresh account on
        // retry is desirable too (the original token might be the cause).
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

        // Bump per-account "totalRequests" counter for this attempt. A
        // single client request that retries N times will count as N
        // attempts on the rotated accounts — that's intentional, it
        // matches "what was actually asked of each upstream account".
        try { usageTracker.recordAccountAttempt({ email: currentEmail }) } catch { /* never block on stats */ }

        const proxyDecision = await resolveAccountProxy(currentEmail)
        const currentProxy = proxyDecision.proxyUrl

        try {
            const chatBaseUrl = getChatBaseUrl()

            const requestConfig = {
                headers: {
                    'Authorization': `Bearer ${currentToken}`,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
                    "Connection": "keep-alive",
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip, deflate, br, zstd",
                    "Content-Type": "application/json",
                    "Timezone": new Date().toUTCString(),
                    "sec-ch-ua": "\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\", \"Not/A)Brand\";v=\"99\"",
                    "source": "web",
                    "Version": "0.2.57",
                    "bx-v": "2.5.36",
                    "Origin": chatBaseUrl,
                    "Sec-Fetch-Site": "same-origin",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Dest": "empty",
                    "Referer": `${chatBaseUrl}/c/guest`,
                    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                    "Cookie": `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
                },
                responseType: 'stream',
                timeout: 60 * 1000,
            }

            // Agent selection rules:
            //   - mode='none'  → no agent, force direct (skip legacy fallback)
            //   - currentProxy set → build a per-URL agent
            //   - else (smart with no pool / fixed with no URL) → legacy
            //     single-proxy fallback (config.proxyUrl) if configured
            let agent = null
            if (proxyDecision.mode === 'none') {
                agent = null
            } else if (currentProxy) {
                agent = buildAgentForUrl(currentProxy)
            } else {
                agent = getProxyAgent()
            }
            if (agent) {
                requestConfig.httpAgent = agent
                requestConfig.httpsAgent = agent
                requestConfig.proxy = false
            }

            const chat_id = await generateChatID(currentToken, body.model, currentEmail, currentProxy, proxyDecision.mode)

            logger.network(`Sending chat request (attempt ${attempt}/${MAX_RETRIES}, proxy: ${getProxyHost(currentProxy)})`, 'REQUEST')
            const response = await axios.post(`${chatBaseUrl}/api/v2/chat/completions?chat_id=` + chat_id, {
                ...body,
                stream: true,
                chat_id: chat_id
            }, requestConfig)

            if (response.status === 200) {
                return {
                    currentToken: currentToken,
                    currentEmail: currentEmail,
                    status: true,
                    response: response.data
                }
            }
            lastError = new Error(`Request failed with status code ${response.status}`)
            try { usageTracker.recordAccountFailure({ email: currentEmail }) } catch { /* swallow */ }
        } catch (error) {
            lastError = error
            try { usageTracker.recordAccountFailure({ email: currentEmail }) } catch { /* swallow */ }
            logger.error(`Chat request failed (attempt ${attempt}/${MAX_RETRIES}, proxy: ${getProxyHost(currentProxy)}): ${error.message}`, 'REQUEST')

            // Only proxy-shaped errors are retryable. Auth errors, 4xx and
            // upstream-format failures should bail immediately so the
            // caller sees the real reason instead of "after 3 retries".
            // Smart mode rotates to a new proxy; fixed mode marks failed
            // but doesn't rebind (operator's intent is "always this proxy");
            // direct mode never reaches here.
            if (currentProxy && currentEmail && proxyDecision.mode === 'smart' && isProxyShapedError(error) && attempt < MAX_RETRIES) {
                logger.warn('Proxy-shaped failure — rotating proxy and retrying', 'PROXY')
                await accountManager.handleNetworkFailure(currentEmail, currentProxy)
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
 * Generate chat_id
 * @param {string} currentToken - Current token
 * @param {string} model - Model name
 * @param {string} [email] - Account email (for proxy lookup)
 * @param {string} [proxyUrl] - Proxy URL (overrides legacy single-proxy)
 * @param {'smart'|'fixed'|'none'} [proxyMode] - Account proxy mode; when
 *        'none' we skip the legacy single-proxy fallback that would
 *        otherwise kick in for null proxyUrl.
 * @returns {Promise<string|null>} Generated chat_id or null
 */
const generateChatID = async (currentToken, model, email = null, proxyUrl = null, proxyMode = 'smart') => {
    // Fast path: try the warmup pool first (avoids 500ms–6s /chats/new latency)
    if (email) {
        const pooled = chatIdPool.acquire(email)
        if (pooled) {
            return pooled
        }
    }

    try {
        const chatBaseUrl = getChatBaseUrl()

        const requestConfig = {
            headers: {
                'Authorization': `Bearer ${currentToken}`,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
                "Connection": "keep-alive",
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate, br, zstd",
                "Content-Type": "application/json",
                "Timezone": new Date().toUTCString(),
                "sec-ch-ua": "\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\", \"Not/A)Brand\";v=\"99\"",
                "source": "web",
                "Version": "0.2.57",
                "bx-v": "2.5.36",
                "Origin": chatBaseUrl,
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
                "Referer": `${chatBaseUrl}/c/guest`,
                "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
                "Cookie": `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
            }
        }

        let agent = null
        if (proxyMode === 'none') {
            agent = null
        } else if (proxyUrl) {
            agent = buildAgentForUrl(proxyUrl)
        } else {
            agent = getProxyAgent()
        }
        if (agent) {
            requestConfig.httpAgent = agent
            requestConfig.httpsAgent = agent
            requestConfig.proxy = false
        }

        const response_data = await axios.post(`${chatBaseUrl}/api/v2/chats/new`, {
            "title": "New Chat",
            "models": [model],
            "chat_mode": "local",
            "chat_type": "t2i",
            "timestamp": new Date().getTime()
        }, requestConfig)

        return response_data.data?.data?.id || null

    } catch (error) {
        logger.error('Failed to generate chat_id', 'CHAT', '', error.message)
        return null
    }
}

module.exports = {
    sendChatRequest,
    generateChatID
}
