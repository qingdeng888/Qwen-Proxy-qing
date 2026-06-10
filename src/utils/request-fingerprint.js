/**
 * Request Fingerprint Manager
 * 
 * Anti-risk-control optimizations inspired by YuJunZhiXue/qwen2API:
 * 1. Request jitter - randomize timing between requests
 * 2. Per-account rate limiting with exponential backoff
 * 3. Minimal clean headers (no extra fingerprint markers)
 * 4. Chat deletion after use (reduce account footprint)
 * 5. Account cooldown on upstream errors
 */

const { logger } = require('./logger')

// ─── Request Jitter ─────────────────────────────────────────────────────────
// Add random delay before requests to avoid burst patterns that trigger detection

const REQUEST_JITTER_MIN_MS = parseInt(process.env.REQUEST_JITTER_MIN_MS) || 50
const REQUEST_JITTER_MAX_MS = parseInt(process.env.REQUEST_JITTER_MAX_MS) || 300

/**
 * Sleep for a random duration between min and max ms
 */
const requestJitter = () => {
    if (REQUEST_JITTER_MAX_MS <= 0) return Promise.resolve()
    const delay = REQUEST_JITTER_MIN_MS + Math.floor(Math.random() * (REQUEST_JITTER_MAX_MS - REQUEST_JITTER_MIN_MS + 1))
    return new Promise(resolve => setTimeout(resolve, delay))
}

// ─── Account Rate Limit Tracker ─────────────────────────────────────────────
// Track per-account rate limits with exponential backoff

const RATE_LIMIT_BASE_COOLDOWN = parseInt(process.env.RATE_LIMIT_BASE_COOLDOWN) || 600 // 10 min
const RATE_LIMIT_MAX_COOLDOWN = parseInt(process.env.RATE_LIMIT_MAX_COOLDOWN) || 3600  // 1 hour

class AccountRateLimiter {
    constructor() {
        // Map<email, { until: number, strikes: number, lastError: string }>
        this._limits = new Map()
    }

    /**
     * Check if account is currently rate-limited
     * @param {string} email
     * @returns {boolean}
     */
    isLimited(email) {
        if (!email) return false
        const record = this._limits.get(email)
        if (!record) return false
        if (Date.now() > record.until) {
            this._limits.delete(email)
            return false
        }
        return true
    }

    /**
     * Mark account as rate-limited with exponential backoff
     * @param {string} email
     * @param {string} reason
     */
    markLimited(email, reason = '') {
        if (!email) return
        const existing = this._limits.get(email) || { strikes: 0 }
        const strikes = existing.strikes + 1
        let cooldown = RATE_LIMIT_BASE_COOLDOWN * 1000
        for (let i = 1; i < strikes; i++) {
            cooldown *= 2
            if (cooldown >= RATE_LIMIT_MAX_COOLDOWN * 1000) {
                cooldown = RATE_LIMIT_MAX_COOLDOWN * 1000
                break
            }
        }
        this._limits.set(email, {
            until: Date.now() + cooldown,
            strikes,
            lastError: reason
        })
        logger.warn(`Account ${email} rate-limited for ${cooldown / 1000}s (strike ${strikes}): ${reason}`, 'RATELIMIT')
    }

    /**
     * Clear rate limit on successful request
     * @param {string} email
     */
    clearLimit(email) {
        if (email) this._limits.delete(email)
    }

    /**
     * Get status for all tracked accounts
     */
    getStatus() {
        const now = Date.now()
        const status = {}
        for (const [email, record] of this._limits) {
            if (now < record.until) {
                status[email] = {
                    remainingSeconds: Math.ceil((record.until - now) / 1000),
                    strikes: record.strikes,
                    lastError: record.lastError
                }
            }
        }
        return status
    }
}

// ─── Upstream Error Detection ───────────────────────────────────────────────
// Detect rate-limit and captcha responses from upstream

/**
 * Check if upstream response indicates a captcha/risk-control block
 * @param {string} rawChunk - Raw response text
 * @returns {{ blocked: boolean, reason: string }}
 */
const detectUpstreamBlock = (rawChunk) => {
    if (!rawChunk) return { blocked: false, reason: '' }

    // Detect RGV587 captcha challenge
    if (rawChunk.includes('RGV587') || rawChunk.includes('_____tmd_____') || rawChunk.includes('punish')) {
        return { blocked: true, reason: 'captcha_challenge' }
    }

    // Detect rate limit
    if (rawChunk.includes('429') || rawChunk.includes('Too Many Requests') || rawChunk.includes('too_many_requests')) {
        return { blocked: true, reason: 'rate_limited' }
    }

    // Detect auth failure
    if (rawChunk.includes('unauthorized') || rawChunk.includes('Unauthorized') || rawChunk.includes('token expired')) {
        return { blocked: true, reason: 'auth_failure' }
    }

    return { blocked: false, reason: '' }
}

// ─── Chat Cleanup ───────────────────────────────────────────────────────────
// Delete chats after use to reduce account footprint (like qwen2API does)

const DELETE_CHAT_AFTER_USE = process.env.DELETE_CHAT_AFTER_USE !== 'false' // default: true

/**
 * Delete a chat session from upstream (fire-and-forget)
 * @param {object} axios - Axios instance
 * @param {string} chatBaseUrl - Base URL
 * @param {string} token - Auth token
 * @param {string} chatId - Chat ID to delete
 */
const deleteChatAfterUse = async (axios, chatBaseUrl, token, chatId) => {
    if (!DELETE_CHAT_AFTER_USE || !chatId || !token) return

    try {
        await axios.delete(`${chatBaseUrl}/api/v2/chats/${chatId}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Origin': chatBaseUrl,
                'Referer': `${chatBaseUrl}/`,
            },
            timeout: 10000,
        })
    } catch (e) {
        // Fire and forget - don't block on delete failures
        logger.debug(`Chat delete failed (chat_id=${chatId}): ${e.message}`, 'CLEANUP')
    }
}

// Singleton instance
const accountRateLimiter = new AccountRateLimiter()

module.exports = {
    requestJitter,
    accountRateLimiter,
    detectUpstreamBlock,
    deleteChatAfterUse,
    DELETE_CHAT_AFTER_USE,
    REQUEST_JITTER_MIN_MS,
    REQUEST_JITTER_MAX_MS,
}
