'use strict'

/**
 * Chat ID Warmup Pool
 *
 * Pre-creates chat_ids for each available account and keeps them in an
 * in-memory queue. When a request arrives, it pops a pre-warmed chat_id
 * instead of waiting for the synchronous POST /api/v2/chats/new call
 * (which takes 500ms–6s depending on upstream load).
 *
 * This solves the "idle → tool call broken" problem:
 * - After idle, connections/sessions go cold on the upstream side
 * - The first synchronous /chats/new call after idle often times out
 *   or returns a "degraded" chat_id that doesn't support tool calling
 * - The warmup pool keeps fresh chat_ids always ready, and the
 *   background refill loop keeps the upstream connection warm
 *
 * Inspired by qwen2API's ChatIdPool (Python asyncio version).
 * Adapted to Node.js with setInterval-based background loop.
 *
 * Configuration (env vars):
 *   CHAT_POOL_SIZE_PER_ACCOUNT  — target pool size per account (default: 3)
 *   CHAT_POOL_TTL_SECONDS       — chat_id TTL in seconds (default: 600 = 10min)
 *   CHAT_POOL_REFILL_INTERVAL   — refill check interval in seconds (default: 30)
 *   CHAT_POOL_DEFAULT_MODEL     — model used for pre-warming (default: qwen3-235b-a22b)
 */

const axios = require('axios')
const { logger } = require('./logger')
const { getSsxmodItna, getSsxmodItna2 } = require('./ssxmod-manager')
const { getProxyAgent, getChatBaseUrl } = require('./proxy-helper')

class ChatIdPool {
    constructor(options = {}) {
        this.targetPerAccount = parseInt(process.env.CHAT_POOL_SIZE_PER_ACCOUNT) || options.targetPerAccount || 3
        this.ttlMs = (parseInt(process.env.CHAT_POOL_TTL_SECONDS) || options.ttlSeconds || 600) * 1000
        this.refillIntervalMs = (parseInt(process.env.CHAT_POOL_REFILL_INTERVAL) || options.refillInterval || 30) * 1000
        this.defaultModel = process.env.CHAT_POOL_DEFAULT_MODEL || options.defaultModel || 'qwen3-235b-a22b'

        // Map<email, Array<{ chatId: string, createdAt: number }>>
        this._queues = new Map()
        this._refillTimer = null
        this._running = false
        this._stats = { hits: 0, misses: 0, created: 0, expired: 0, errors: 0 }
    }

    /**
     * Start the pool — initial fill + background refill loop.
     * Call this after accountManager is initialized.
     * @param {object} accountManager - The account manager instance
     */
    async start(accountManager) {
        if (this._running) return
        this._running = true
        this._accountManager = accountManager

        logger.info(`[ChatIdPool] Starting (target=${this.targetPerAccount}/account, TTL=${this.ttlMs / 1000}s, refill=${this.refillIntervalMs / 1000}s)`, 'WARMUP')

        // Initial fill (don't await — let it run in background so server starts fast)
        this._refillOnce().catch(err => {
            logger.error(`[ChatIdPool] Initial fill error: ${err.message}`, 'WARMUP')
        })

        // Background refill loop
        this._refillTimer = setInterval(() => {
            this._refillOnce().catch(err => {
                logger.error(`[ChatIdPool] Refill loop error: ${err.message}`, 'WARMUP')
            })
        }, this.refillIntervalMs)

        // Unref so it doesn't keep the process alive on shutdown
        if (this._refillTimer.unref) {
            this._refillTimer.unref()
        }
    }

    /**
     * Stop the pool — clear timers and queues.
     */
    stop() {
        this._running = false
        if (this._refillTimer) {
            clearInterval(this._refillTimer)
            this._refillTimer = null
        }
        this._queues.clear()
        logger.info('[ChatIdPool] Stopped', 'WARMUP')
    }

    /**
     * Try to acquire a pre-warmed chat_id for the given account.
     * Returns null if pool is empty or all entries expired (caller should
     * fall back to synchronous creation).
     * @param {string} email - Account email
     * @returns {string|null} chat_id or null
     */
    acquire(email) {
        if (!email) return null
        const queue = this._queues.get(email)
        if (!queue || queue.length === 0) {
            this._stats.misses++
            return null
        }

        const now = Date.now()
        while (queue.length > 0) {
            const entry = queue.shift()
            if (now - entry.createdAt < this.ttlMs) {
                this._stats.hits++
                logger.info(`[ChatIdPool] HIT email=${email} chatId=${entry.chatId} pool_remaining=${queue.length}`, 'WARMUP')
                return entry.chatId
            }
            // Expired — discard and try next
            this._stats.expired++
        }

        this._stats.misses++
        return null
    }

    /**
     * Remove a specific chat_id from the pool (e.g. after upstream error).
     * @param {string} email
     * @param {string} chatId
     */
    invalidate(email, chatId) {
        if (!email || !chatId) return
        const queue = this._queues.get(email)
        if (!queue) return
        const idx = queue.findIndex(e => e.chatId === chatId)
        if (idx >= 0) {
            queue.splice(idx, 1)
            logger.info(`[ChatIdPool] Invalidated email=${email} chatId=${chatId}`, 'WARMUP')
        }
    }

    /**
     * Flush all chat_ids for a given account (e.g. after auth failure).
     * @param {string} email
     */
    flushAccount(email) {
        if (!email) return
        const queue = this._queues.get(email)
        if (queue && queue.length > 0) {
            const count = queue.length
            queue.length = 0
            logger.info(`[ChatIdPool] Flushed ${count} entries for email=${email}`, 'WARMUP')
        }
    }

    /**
     * Get pool statistics.
     */
    getStats() {
        let totalSize = 0
        const perAccount = {}
        for (const [email, queue] of this._queues) {
            perAccount[email] = queue.length
            totalSize += queue.length
        }
        return {
            ...this._stats,
            totalSize,
            perAccount,
            targetPerAccount: this.targetPerAccount,
            ttlSeconds: this.ttlMs / 1000,
        }
    }

    // ─── Internal ──────────────────────────────────────────────────────

    /**
     * One round of refill: check each valid account, top up if below target.
     * @private
     */
    async _refillOnce() {
        if (!this._accountManager) return

        // Wait for account manager to be ready
        if (typeof this._accountManager.ensureInitialized === 'function') {
            try { await this._accountManager.ensureInitialized() } catch { return }
        }

        const accounts = this._accountManager.accountTokens || []
        const validAccounts = accounts.filter(acc => acc.token && !acc.disabled)

        for (const acc of validAccounts) {
            const email = acc.email
            if (!email) continue

            const queue = this._queues.get(email) || []
            this._queues.set(email, queue)

            // Prune expired entries first
            const now = Date.now()
            while (queue.length > 0 && now - queue[0].createdAt >= this.ttlMs) {
                queue.shift()
                this._stats.expired++
            }

            // Top up if below target (one per round per account to avoid burst)
            if (queue.length < this.targetPerAccount) {
                await this._prewarmOne(acc)
            }
        }
    }

    /**
     * Pre-create one chat_id for the given account and push to its queue.
     * @private
     */
    async _prewarmOne(account) {
        const { token, email } = account
        if (!token || !email) return

        try {
            const chatBaseUrl = getChatBaseUrl()
            const proxyAgent = getProxyAgent()

            const requestConfig = {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
                    'Connection': 'keep-alive',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Cookie': `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
                },
                timeout: 15000, // 15s timeout for prewarm (generous)
            }

            if (proxyAgent) {
                requestConfig.httpAgent = proxyAgent
                requestConfig.httpsAgent = proxyAgent
                requestConfig.proxy = false
            }

            const response = await axios.post(`${chatBaseUrl}/api/v2/chats/new`, {
                title: 'warmup',
                models: [this.defaultModel],
                chat_mode: 'normal',
                chat_type: 't2t',
                timestamp: Date.now(),
            }, requestConfig)

            const chatId = response.data?.data?.id
            if (!chatId) {
                logger.warn(`[ChatIdPool] Prewarm got empty chatId for ${email}`, 'WARMUP')
                this._stats.errors++
                return
            }

            const queue = this._queues.get(email) || []
            this._queues.set(email, queue)
            queue.push({ chatId, createdAt: Date.now() })
            this._stats.created++

            logger.info(`[ChatIdPool] Prewarmed email=${email} chatId=${chatId} pool_size=${queue.length}`, 'WARMUP')
        } catch (error) {
            this._stats.errors++
            const msg = error.response
                ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 100)}`
                : error.message
            logger.warn(`[ChatIdPool] Prewarm failed for ${email}: ${msg}`, 'WARMUP')
        }
    }
}

// Singleton instance
const chatIdPool = new ChatIdPool()

module.exports = { ChatIdPool, chatIdPool }
