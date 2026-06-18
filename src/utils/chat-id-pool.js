'use strict'

/**
 * Chat ID Warmup Pool
 *
 * Pre-creates chat_ids for each available account and keeps them in an
 * in-memory queue. When a request arrives, it pops a pre-warmed chat_id
 * instead of waiting for the synchronous POST /api/v2/chats/new call
 * (which takes 500ms–6s depending on upstream load).
 *
 * Now uses HTTP/2 + cookies from browser login to bypass WAF.
 *
 * Configuration (env vars):
 *   CHAT_POOL_SIZE_PER_ACCOUNT  — target pool size per account (default: 2)
 *   CHAT_POOL_TTL_SECONDS       — chat_id TTL in seconds (default: 120)
 *   CHAT_POOL_REFILL_INTERVAL   — refill check interval in seconds (default: 60)
 *   CHAT_POOL_DEFAULT_MODEL     — model used for pre-warming (default: qwen3-235b-a22b)
 */

const { logger } = require('./logger')
const { http2Request } = require('./http2-client')

class ChatIdPool {
    constructor(options = {}) {
        this.targetPerAccount = parseInt(process.env.CHAT_POOL_SIZE_PER_ACCOUNT) || options.targetPerAccount || 2
        this.ttlMs = (parseInt(process.env.CHAT_POOL_TTL_SECONDS) || options.ttlSeconds || 120) * 1000
        this.refillIntervalMs = (parseInt(process.env.CHAT_POOL_REFILL_INTERVAL) || options.refillInterval || 60) * 1000
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
            this._stats.expired++
        }

        this._stats.misses++
        return null
    }

    /**
     * Remove a specific chat_id from the pool.
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
     * Flush all chat_ids for a given account.
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
     * One round of refill.
     * @private
     */
    async _refillOnce() {
        if (!this._accountManager) return

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
     * Pre-create one chat_id using HTTP/2 + cookies from browser login.
     * @private
     */
    async _prewarmOne(account) {
        const { token, email, cookies } = account
        if (!token || !email) return

        try {
            const { status, data } = await http2Request('POST', '/api/v2/chats/new', {
                title: 'warmup',
                models: [this.defaultModel],
                chat_mode: 'normal',
                chat_type: 't2t',
                timestamp: Date.now(),
            }, token, cookies || '', {
                timeout: 15000,
            })

            // Check if response is a captcha challenge disguised as 200
            const rawStr = typeof data === 'string' ? data : JSON.stringify(data || '')
            if (rawStr.includes('RGV587') || rawStr.includes('_____tmd_____') || rawStr.includes('FAIL_SYS_USER_VALIDATE')) {
                logger.warn(`[ChatIdPool] Prewarm hit captcha for ${email}, skipping`, 'WARMUP')
                this._stats.errors++
                return
            }

            const chatId = (status === 200 && data && data.data) ? data.data.id : null
            if (!chatId) {
                logger.warn(`[ChatIdPool] Prewarm got empty chatId for ${email} (status=${status})`, 'WARMUP')
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
            logger.warn(`[ChatIdPool] Prewarm failed for ${email}: ${error.message}`, 'WARMUP')
        }
    }
}

// Singleton instance
const chatIdPool = new ChatIdPool()

module.exports = { ChatIdPool, chatIdPool }
