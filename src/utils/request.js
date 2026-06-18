const axios = require('axios')
const accountManager = require('./account.js')
const config = require('../config/index.js')
const { logger } = require('./logger')
const { getProxyAgent, getChatBaseUrl, buildAgentForUrl, getProxyHost } = require('./proxy-helper')
const usageTracker = require('./usage-tracker')
const { chatIdPool } = require('./chat-id-pool')
const { requestJitter, accountRateLimiter, detectUpstreamBlock, deleteChatAfterUse } = require('./request-fingerprint')
const { http2Stream, http2Request } = require('./http2-client')
const { getSsxmodItna, getSsxmodItna2 } = require('./ssxmod-manager')
const { browserBridge } = require('./browser-bridge')

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

// ─── Background Re-login Scheduler ─────────────────────────────────────────
// When captcha/WAF blocks an account, schedule a Playwright re-login to
// refresh the session's trust score. Uses a Set to avoid queueing
// duplicate re-logins for the same account.

const _pendingRelogins = new Set()

/**
 * Merge browser login cookies with ssxmod anti-bot cookies.
 * ssxmod_itna and ssxmod_itna2 are Aliyun's client-side tracking cookies
 * that help establish a "real browser" session fingerprint.
 * @param {string} browserCookies - Cookie string from Playwright login session
 * @returns {string} Combined cookie string
 */
function buildFullCookies(browserCookies) {
    const parts = []

    // Browser login cookies (session, auth, etc.)
    if (browserCookies) {
        parts.push(browserCookies)
    }

    // SSXMOD anti-bot cookies (refreshed every 15 min)
    const ssxmodItna = getSsxmodItna()
    const ssxmodItna2 = getSsxmodItna2()
    if (ssxmodItna) {
        parts.push(`ssxmod_itna=${ssxmodItna}`)
    }
    if (ssxmodItna2) {
        parts.push(`ssxmod_itna2=${ssxmodItna2}`)
    }

    return parts.filter(Boolean).join('; ')
}

/**
 * Schedule a background re-login for an account that hit captcha/WAF.
 * Non-blocking — fires and forgets. Limits concurrency to one per email.
 * 
 * After successful re-login:
 *   1. Clears the account's rate limit (so it can be used again)
 *   2. Forces HTTP/2 session reconnect (old session may be tainted)
 *   3. Refreshes ssxmod cookies (fresh fingerprint for the new session)
 * 
 * @param {string} email
 */
function scheduleBackgroundRelogin(email) {
    if (!email || _pendingRelogins.has(email)) return
    _pendingRelogins.add(email)

    // Delay slightly to not hammer upstream immediately after a block
    setTimeout(async () => {
        try {
            logger.info(`[RELOGIN] Background re-login starting for ${email}`, 'AUTH')
            const success = await accountManager.refreshAccountToken(email)
            if (success) {
                logger.success(`[RELOGIN] Background re-login succeeded for ${email}, session refreshed`, 'AUTH')
                // Clear rate limit since we have a fresh session
                accountRateLimiter.clearLimit(email)
                // Force HTTP/2 session reconnect — old session may be tainted
                // by the WAF/captcha response and carry a bad reputation
                const { closeHttp2 } = require('./http2-client')
                closeHttp2()
                logger.info(`[RELOGIN] HTTP/2 session reset for fresh connection`, 'AUTH')
                // Refresh ssxmod cookies to get a new fingerprint
                const { refreshCookies } = require('./ssxmod-manager')
                refreshCookies()
                logger.info(`[RELOGIN] SSXMOD cookies refreshed`, 'AUTH')
            } else {
                logger.warn(`[RELOGIN] Background re-login failed for ${email}`, 'AUTH')
            }
        } catch (err) {
            logger.error(`[RELOGIN] Background re-login error for ${email}: ${err.message}`, 'AUTH')
        } finally {
            _pendingRelogins.delete(email)
        }
    }, 5000 + Math.random() * 10000) // 5-15s random delay
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

// ─── Stream Peek Helpers ────────────────────────────────────────────────────
// Read the first chunk from a stream to detect captcha/risk-control responses
// before handing the stream to the response handler.

const { PassThrough } = require('stream')

/**
 * Peek at the first chunk of a stream to detect upstream blocks.
 * Waits up to `timeoutMs` for the first data event.
 * @param {stream.Readable} stream - The HTTP/2 response stream
 * @param {number} timeoutMs - Max time to wait for first chunk
 * @returns {Promise<{blocked: boolean, reason: string, chunk: Buffer|null}>}
 */
function peekFirstChunk(stream, timeoutMs = 3000) {
    return new Promise((resolve) => {
        let resolved = false
        const timer = setTimeout(() => {
            if (resolved) return
            resolved = true
            // No data received within timeout — likely slow but not blocked
            resolve({ blocked: false, reason: '', chunk: null })
        }, timeoutMs)

        stream.once('data', (chunk) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)

            const text = chunk.toString('utf-8')
            const blockCheck = detectUpstreamBlock(text)
            resolve({ blocked: blockCheck.blocked, reason: blockCheck.reason, chunk })
        })

        stream.once('end', () => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            // Stream ended immediately with no data — unusual but not blocked
            resolve({ blocked: false, reason: '', chunk: null })
        })

        stream.once('error', (err) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            resolve({ blocked: false, reason: '', chunk: null })
        })
    })
}

/**
 * Create a PassThrough stream that first emits the peeked chunk,
 * then pipes the rest of the original stream through.
 * @param {stream.Readable} originalStream - The original HTTP/2 stream
 * @param {Buffer|null} firstChunk - The peeked first chunk (or null if none)
 * @returns {stream.PassThrough}
 */
function createPeekedStream(originalStream, firstChunk) {
    const passthrough = new PassThrough()

    // Emit the first chunk immediately if we have one
    if (firstChunk) {
        passthrough.write(firstChunk)
    }

    // Pipe remaining data through
    originalStream.on('data', (chunk) => {
        passthrough.write(chunk)
    })
    originalStream.on('end', () => {
        passthrough.end()
    })
    originalStream.on('error', (err) => {
        passthrough.destroy(err)
    })

    return passthrough
}

/**
 * Send chat request via Browser Bridge (primary path when available).
 * Routes the request through a persistent Playwright browser session where
 * Alibaba's security SDK naturally generates x5sec for each request.
 * 
 * @param {Object} body - Request body
 * @param {string} currentToken - Auth token
 * @param {string} currentEmail - Account email
 * @returns {Promise<{status:boolean, response:Object|null, currentToken:string, currentEmail:string}|null>}
 *          Returns null if bridge is not available (caller should fall back)
 */
const sendChatRequestViaBridge = async (body, currentToken, currentEmail) => {
    if (!browserBridge.isAvailable()) return null

    try {
        // Step 1: Create chat_id via browser
        logger.info(`[BRIDGE] Creating chat_id for ${currentEmail}...`, 'BRIDGE')
        const chatResult = await browserBridge.request(currentEmail, currentToken, 'POST', '/api/v2/chats/new', {
            title: "New Chat",
            models: [body.model],
            chat_mode: "normal",
            chat_type: "t2t",
            timestamp: Date.now(),
        })

        // Check for captcha in chat creation response
        const chatRaw = typeof chatResult.data === 'string' ? chatResult.data : JSON.stringify(chatResult.data || '')
        if (chatRaw.includes('RGV587') || chatRaw.includes('_____tmd_____') || chatRaw.includes('FAIL_SYS_USER_VALIDATE')) {
            logger.error(`[BRIDGE] Chat creation hit captcha for ${currentEmail}`, 'BRIDGE')
            // Browser session is tainted — close and re-create on next use
            await browserBridge.closeSession(currentEmail)
            return null // Fall back to HTTP path
        }

        const chat_id = (chatResult.status === 200 && chatResult.data && chatResult.data.data)
            ? chatResult.data.data.id
            : null

        if (!chat_id) {
            logger.warn(`[BRIDGE] Failed to get chat_id via bridge for ${currentEmail} (status=${chatResult.status})`, 'BRIDGE')
            return null
        }

        logger.info(`[BRIDGE] Chat created: ${chat_id} for ${currentEmail}`, 'BRIDGE')

        // Step 2: Stream completion via browser
        const path = `/api/v2/chat/completions?chat_id=${chat_id}`
        const payload = { ...body, stream: true, chat_id }

        const { status, stream, headers } = await browserBridge.stream(
            currentEmail, currentToken, path, payload, { timeout: 60000 }
        )

        if (status === 200) {
            // Check first bytes for captcha (might still happen in stream response)
            const firstChunkCheck = await peekFirstChunk(stream, 3000)
            if (firstChunkCheck.blocked) {
                logger.error(`[BRIDGE] Stream first-chunk blocked for ${currentEmail}: ${firstChunkCheck.reason}`, 'BRIDGE')
                await browserBridge.closeSession(currentEmail)
                return null
            }

            const wrappedStream = firstChunkCheck.chunk ? createPeekedStream(stream, firstChunkCheck.chunk) : stream
            logger.info(`[BRIDGE] Stream started for ${currentEmail}`, 'BRIDGE')

            // Schedule chat deletion
            wrappedStream.once('end', () => {
                browserBridge.request(currentEmail, currentToken, 'DELETE', `/api/v2/chats/${chat_id}`)
                    .catch(() => {})
            })

            return {
                currentToken,
                currentEmail,
                status: true,
                response: wrappedStream,
            }
        }

        logger.warn(`[BRIDGE] Stream returned status ${status} for ${currentEmail}`, 'BRIDGE')
        return null

    } catch (error) {
        logger.error(`[BRIDGE] Request failed for ${currentEmail}: ${error.message}`, 'BRIDGE')
        // If it's a session error, close it for re-creation on next attempt
        if (error.message.includes('not ready') || error.message.includes('crashed') || error.message.includes('Target closed')) {
            await browserBridge.closeSession(currentEmail).catch(() => {})
        }
        return null
    }
}

/**
 * Send chat request using HTTP/2 (with HTTP/1.1 fallback)
 * 
 * Request strategy (in order):
 *   1. Browser Bridge (routes through persistent Playwright — has x5sec)
 *   2. HTTP/2 / HTTP/1.1 with cookies (fallback when bridge unavailable)
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

        // ─── Strategy 1: Browser Bridge (preferred — has x5sec) ─────────
        // Try routing through persistent browser session first.
        // The browser's security SDK adds x5sec to each request automatically.
        if (attempt === 1 && currentEmail && browserBridge.isAvailable()) {
            try {
                const bridgeResult = await sendChatRequestViaBridge(body, currentToken, currentEmail)
                if (bridgeResult && bridgeResult.status) {
                    accountRateLimiter.clearLimit(currentEmail)
                    return bridgeResult
                }
                // Bridge returned null — fall through to HTTP path
                logger.info('[BRIDGE] Browser bridge unavailable or failed, falling back to HTTP', 'REQUEST')
            } catch (bridgeErr) {
                logger.warn(`[BRIDGE] Error: ${bridgeErr.message}, falling back to HTTP`, 'REQUEST')
            }
        }

        // ─── Strategy 2: HTTP/2 + HTTP/1.1 fallback ─────────────────────
        // Anti-detection: random jitter before each request
        await requestJitter()

        try { usageTracker.recordAccountAttempt({ email: currentEmail }) } catch { /* never block on stats */ }

        const proxyDecision = await resolveAccountProxy(currentEmail)
        const currentProxy = proxyDecision.proxyUrl
        const effectiveProxy = resolveEffectiveProxy(proxyDecision, currentProxy)

        // Get cookies from browser login session + ssxmod anti-bot cookies
        const browserCookies = accountManager.getCookiesByEmail(currentEmail)
        const cookies = buildFullCookies(browserCookies)

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

                // Peek at first chunk to detect captcha that slipped through content-type check
                // (some captcha responses come as status=200 with event-stream content-type)
                const firstChunkCheck = await peekFirstChunk(stream, 3000)
                if (firstChunkCheck.blocked) {
                    logger.error(`[RISK-CONTROL] First-chunk captcha detected for ${currentEmail}: ${firstChunkCheck.reason}`, 'REQUEST')
                    accountRateLimiter.markLimited(currentEmail, firstChunkCheck.reason)
                    scheduleBackgroundRelogin(currentEmail)
                    stream.close ? stream.close() : stream.destroy ? stream.destroy() : null
                    if (attempt < MAX_RETRIES) continue
                    lastError = new Error(`CAPTCHA_BLOCKED: ${firstChunkCheck.reason}`)
                    break
                }

                // Clear rate limit on successful connection
                accountRateLimiter.clearLimit(currentEmail)

                // Schedule chat deletion after stream ends
                stream.once('end', () => {
                    http2Request('DELETE', `/api/v2/chats/${chat_id}`, null, currentToken, cookies, {
                        proxyUrl: effectiveProxy,
                        timeout: 10000,
                    }).catch(() => {})
                })

                // Return a wrapped stream that prepends the peeked first chunk
                const wrappedStream = createPeekedStream(stream, firstChunkCheck.chunk)

                return {
                    currentToken,
                    currentEmail,
                    status: true,
                    response: wrappedStream
                }
            }

            lastError = new Error(`HTTP/2 request failed with status ${status}`)
            try { usageTracker.recordAccountFailure({ email: currentEmail }) } catch { /* swallow */ }

        } catch (error) {
            lastError = error
            try { usageTracker.recordAccountFailure({ email: currentEmail }) } catch { /* swallow */ }
            logger.error(`Chat request failed (attempt ${attempt}/${MAX_RETRIES}, proxy: ${getProxyHost(effectiveProxy)}): ${error.message}`, 'REQUEST')

            // Captcha/risk-control blocks — rate-limit account and retry with different one
            if (error.message && error.message.includes('CAPTCHA_BLOCKED')) {
                accountRateLimiter.markLimited(currentEmail, 'captcha_challenge')
                logger.warn(`[RISK-CONTROL] Account ${currentEmail} hit captcha, cooling down and retrying with next account`, 'REQUEST')
                // Schedule background re-login to refresh session trust
                scheduleBackgroundRelogin(currentEmail)
                if (attempt < MAX_RETRIES) continue
                break
            }

            // Rate-limited by upstream — shorter cooldown, still retry
            if (error.message && error.message.includes('RATE_LIMITED')) {
                accountRateLimiter.markLimited(currentEmail, 'rate_limited')
                logger.warn(`[RATE-LIMIT] Account ${currentEmail} rate-limited upstream, retrying with next account`, 'REQUEST')
                if (attempt < MAX_RETRIES) continue
                break
            }

            // WAF blocks should rate-limit the account and retry
            if (error.message && error.message.includes('WAF_BLOCKED')) {
                accountRateLimiter.markLimited(currentEmail, 'waf_blocked')
                // Schedule background re-login for WAF blocks too
                scheduleBackgroundRelogin(currentEmail)
                if (attempt < MAX_RETRIES) continue
                break
            }

            // Generic upstream errors (unexpected JSON, etc.)
            if (error.message && error.message.includes('UPSTREAM_ERROR')) {
                logger.warn(`[UPSTREAM] Unexpected upstream response for ${currentEmail}, retrying`, 'REQUEST')
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
    // Include error context so the controller can return a specific message
    const errorReason = lastError && lastError.message
        ? (lastError.message.includes('CAPTCHA_BLOCKED') ? 'captcha_challenge'
            : lastError.message.includes('RATE_LIMITED') ? 'rate_limited'
            : lastError.message.includes('WAF_BLOCKED') ? 'waf_blocked'
            : lastError.message.includes('UPSTREAM_ERROR') ? 'upstream_error'
            : 'unknown')
        : 'unknown'
    return { status: false, response: null, errorReason, errorMessage: lastError ? lastError.message : '' }
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
        const browserCookies = accountManager.getCookiesByEmail(email)
        const cookies = buildFullCookies(browserCookies)
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

        // Check for captcha/WAF in response body
        const rawStr = typeof data === 'string' ? data : JSON.stringify(data || '')
        if (rawStr.includes('RGV587') || rawStr.includes('_____tmd_____') || rawStr.includes('FAIL_SYS_USER_VALIDATE')) {
            logger.warn(`generateChatID hit captcha for ${email}`, 'CHAT')
            accountRateLimiter.markLimited(email, 'captcha_in_chatid')
            scheduleBackgroundRelogin(email)
            return null
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
