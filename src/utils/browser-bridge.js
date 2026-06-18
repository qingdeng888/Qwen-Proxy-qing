/**
 * Browser Bridge — Persistent Playwright session for API requests
 * 
 * Keeps a headless Chromium browser running with an authenticated session
 * on chat.qwen.ai. All API requests are routed THROUGH the browser's
 * fetch() so that Alibaba's security SDK (AWSC/x5sec) can intercept
 * and add the dynamic anti-bot token to each request.
 * 
 * Architecture:
 *   Client → Express → BrowserBridge.fetch('/api/v2/chat/completions', {...})
 *                            ↓
 *              page.evaluate(() => fetch(...))  ← security SDK adds x5sec here
 *                            ↓
 *                      chat.qwen.ai (passes WAF)
 * 
 * Lifecycle:
 *   - Lazy-initialized on first request after login
 *   - Auto-reconnects if browser crashes or page navigates away
 *   - One bridge per account (email → BrowserSession)
 *   - Graceful shutdown on process exit
 * 
 * Environment variables:
 *   BROWSER_BRIDGE_ENABLED=true     — enable browser bridge (default: true)
 *   BROWSER_BRIDGE_TIMEOUT=60000    — max request timeout (default: 60s)
 *   BROWSER_BRIDGE_HEADLESS=true    — run headless (default: true)
 *   BROWSER_BRIDGE_MAX_SESSIONS=5   — max concurrent browser sessions
 */

'use strict'

const { logger } = require('./logger')
const { PassThrough } = require('stream')

const QWEN_BASE_URL = 'https://chat.qwen.ai'
const BRIDGE_TIMEOUT = parseInt(process.env.BROWSER_BRIDGE_TIMEOUT) || 60000
const BRIDGE_HEADLESS = process.env.BROWSER_BRIDGE_HEADLESS !== 'false'
const MAX_SESSIONS = parseInt(process.env.BROWSER_BRIDGE_MAX_SESSIONS) || 5
const BRIDGE_ENABLED = process.env.BROWSER_BRIDGE_ENABLED !== 'false'

let chromium = null
let playwrightAvailable = false

function getPlaywright() {
    if (chromium) return chromium
    try {
        const pw = require('playwright')
        chromium = pw.chromium
        playwrightAvailable = true
        return chromium
    } catch {
        playwrightAvailable = false
        return null
    }
}

/**
 * A persistent browser session for one account.
 * Handles login, page lifecycle, and fetch routing.
 */
class BrowserSession {
    constructor(email) {
        this.email = email
        this.browser = null
        this.context = null
        this.page = null
        this.ready = false
        this._initializing = null
        this._lastActivity = 0
        this._requestCount = 0
    }

    /**
     * Initialize or re-initialize the browser session.
     * @param {string} token - Auth token (stored in localStorage)
     * @param {object} [options] - Options
     * @param {string} [options.proxyUrl] - Proxy for browser
     */
    async initialize(token, options = {}) {
        if (this._initializing) return this._initializing
        this._initializing = this._doInitialize(token, options)
        try {
            await this._initializing
        } finally {
            this._initializing = null
        }
    }

    async _doInitialize(token, options = {}) {
        // Clean up any existing session
        await this.close()

        const pw = getPlaywright()
        if (!pw) throw new Error('Playwright not available')

        logger.info(`[BRIDGE] Initializing browser session for ${this.email}`, 'BRIDGE')

        const launchOptions = {
            headless: BRIDGE_HEADLESS,
            args: [
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
            ],
        }

        if (options.proxyUrl) {
            launchOptions.proxy = { server: options.proxyUrl }
        }

        this.browser = await pw.launch(launchOptions)

        this.context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            locale: 'zh-CN',
            viewport: { width: 1920, height: 1080 },
            extraHTTPHeaders: {
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            bypassCSP: true,
        })

        // Anti-detection
        await this.context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        })

        this.page = await this.context.newPage()
        this.page.setDefaultTimeout(30000)
        this.page.setDefaultNavigationTimeout(60000)

        // Navigate to chat.qwen.ai and inject token
        await this.page.goto(`${QWEN_BASE_URL}/`, {
            waitUntil: 'networkidle',
            timeout: 30000,
        })

        // Inject token into localStorage
        await this.page.evaluate((t) => {
            localStorage.setItem('token', t)
        }, token)

        // Reload to activate the token (site reads it from localStorage)
        await this.page.reload({ waitUntil: 'networkidle', timeout: 30000 })

        // Wait for security SDK to fully load
        await this.page.waitForTimeout(5000)

        // Verify we're logged in by checking if the page has auth state
        const isLoggedIn = await this.page.evaluate(() => {
            return !!localStorage.getItem('token')
        })

        if (!isLoggedIn) {
            throw new Error('Failed to establish authenticated session')
        }

        this.ready = true
        this._lastActivity = Date.now()
        logger.info(`[BRIDGE] Browser session ready for ${this.email}`, 'BRIDGE')
    }

    /**
     * Check if session is usable
     */
    isReady() {
        return this.ready && this.browser && !this.browser.isConnected?.() === false && this.page
    }

    /**
     * Make a JSON API request through the browser.
     * @param {string} method - HTTP method
     * @param {string} path - API path (e.g. '/api/v2/chats/new')
     * @param {object} [body] - Request body
     * @param {number} [timeout] - Timeout in ms
     * @returns {Promise<{status: number, data: any}>}
     */
    async fetchJSON(method, path, body = null, timeout = 15000) {
        if (!this.ready) throw new Error('Browser session not ready')

        this._lastActivity = Date.now()
        this._requestCount++

        const result = await this.page.evaluate(async ({ baseUrl, method, path, body, timeout }) => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), timeout)

            try {
                const options = {
                    method,
                    credentials: 'include',
                    signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                }

                if (body && (method === 'POST' || method === 'PUT')) {
                    options.body = JSON.stringify(body)
                }

                const resp = await fetch(`${baseUrl}${path}`, options)
                const text = await resp.text()

                let data
                try { data = JSON.parse(text) } catch { data = text }

                return { status: resp.status, data, error: null }
            } catch (err) {
                return { status: 0, data: null, error: err.message || 'fetch failed' }
            } finally {
                clearTimeout(timer)
            }
        }, { baseUrl: QWEN_BASE_URL, method, path, body, timeout })

        if (result.error) {
            throw new Error(`Browser fetch failed: ${result.error}`)
        }

        return { status: result.status, data: result.data }
    }

    /**
     * Make a streaming SSE request through the browser.
     * Returns a Node.js readable stream that receives chunks from the browser.
     * 
     * @param {string} path - API path
     * @param {object} body - Request body
     * @param {number} [timeout] - Timeout in ms
     * @returns {Promise<{status: number, stream: PassThrough}>}
     */
    async fetchStream(path, body, timeout = BRIDGE_TIMEOUT) {
        if (!this.ready) throw new Error('Browser session not ready')

        this._lastActivity = Date.now()
        this._requestCount++

        const stream = new PassThrough()

        // Use page.evaluate with a streaming approach:
        // We start the fetch, read the response body as chunks via ReadableStream,
        // and relay each chunk back to Node.js via a CDP event mechanism.
        
        // Create a unique channel ID for this stream
        const channelId = `stream_${Date.now()}_${Math.random().toString(36).slice(2)}`

        // Set up a listener in Node.js that receives chunks from the browser
        const chunkHandler = (msg) => {
            try {
                const text = msg.text()
                if (text.startsWith(`__STREAM_CHUNK__${channelId}:`)) {
                    const data = text.slice(`__STREAM_CHUNK__${channelId}:`.length)
                    if (data === '__END__') {
                        stream.end()
                        this.page.off('console', chunkHandler)
                    } else if (data.startsWith('__ERROR__:')) {
                        const errMsg = data.slice('__ERROR__:'.length)
                        stream.destroy(new Error(errMsg))
                        this.page.off('console', chunkHandler)
                    } else {
                        stream.write(data)
                    }
                }
            } catch {
                // Ignore parse errors
            }
        }

        this.page.on('console', chunkHandler)

        // Start the streaming fetch inside the browser
        // We use console.log to relay chunks back (it's the simplest cross-boundary mechanism)
        const statusPromise = this.page.evaluate(async ({ baseUrl, path, body, timeout, channelId }) => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), timeout)

            try {
                const resp = await fetch(`${baseUrl}${path}`, {
                    method: 'POST',
                    credentials: 'include',
                    signal: controller.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream',
                    },
                    body: JSON.stringify(body),
                })

                const status = resp.status
                const contentType = resp.headers.get('content-type') || ''

                // If not a stream response (captcha/error as JSON), read fully and send as one chunk
                if (contentType.includes('application/json') || !contentType.includes('event-stream')) {
                    const text = await resp.text()
                    console.log(`__STREAM_CHUNK__${channelId}:${text}`)
                    console.log(`__STREAM_CHUNK__${channelId}:__END__`)
                    return { status, isStream: false, contentType }
                }

                // Stream response — read chunks
                const reader = resp.body.getReader()
                const decoder = new TextDecoder()

                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    const text = decoder.decode(value, { stream: true })
                    console.log(`__STREAM_CHUNK__${channelId}:${text}`)
                }

                console.log(`__STREAM_CHUNK__${channelId}:__END__`)
                return { status, isStream: true, contentType }
            } catch (err) {
                console.log(`__STREAM_CHUNK__${channelId}:__ERROR__:${err.message || 'unknown error'}`)
                return { status: 0, isStream: false, error: err.message }
            } finally {
                clearTimeout(timer)
            }
        }, { baseUrl: QWEN_BASE_URL, path, body, timeout, channelId })

        // Wait for the initial status
        const result = await statusPromise

        if (result.error) {
            this.page.off('console', chunkHandler)
            throw new Error(`Browser stream failed: ${result.error}`)
        }

        return { status: result.status, stream, headers: { 'content-type': result.contentType || 'text/event-stream' } }
    }

    /**
     * Close the browser session
     */
    async close() {
        this.ready = false
        if (this.browser) {
            try { await this.browser.close() } catch {}
            this.browser = null
            this.context = null
            this.page = null
        }
    }

    /**
     * Get session info for debugging
     */
    getInfo() {
        return {
            email: this.email,
            ready: this.ready,
            requestCount: this._requestCount,
            lastActivity: this._lastActivity,
            uptime: this._lastActivity ? Date.now() - this._lastActivity : 0,
        }
    }
}

/**
 * Browser Bridge Manager
 * Manages multiple browser sessions (one per account)
 */
class BrowserBridge {
    constructor() {
        // Map<email, BrowserSession>
        this._sessions = new Map()
        this._enabled = BRIDGE_ENABLED
    }

    /**
     * Check if bridge is available
     */
    isAvailable() {
        if (!this._enabled) return false
        getPlaywright()
        return playwrightAvailable
    }

    /**
     * Get or create a browser session for an account.
     * Lazy-initializes on first use.
     * 
     * @param {string} email - Account email
     * @param {string} token - Auth token
     * @param {object} [options] - Options
     * @returns {Promise<BrowserSession>}
     */
    async getSession(email, token, options = {}) {
        let session = this._sessions.get(email)

        if (session && session.isReady()) {
            return session
        }

        // Check max sessions limit
        if (!session && this._sessions.size >= MAX_SESSIONS) {
            // Evict the oldest inactive session
            await this._evictOldest()
        }

        if (!session) {
            session = new BrowserSession(email)
            this._sessions.set(email, session)
        }

        // Initialize or re-initialize
        await session.initialize(token, options)
        return session
    }

    /**
     * Make a JSON request through the browser bridge
     * @param {string} email - Account email
     * @param {string} token - Auth token
     * @param {string} method - HTTP method
     * @param {string} path - API path
     * @param {object} [body] - Request body
     * @param {object} [options] - Options (proxyUrl, timeout)
     * @returns {Promise<{status: number, data: any}>}
     */
    async request(email, token, method, path, body = null, options = {}) {
        const session = await this.getSession(email, token, options)
        return await session.fetchJSON(method, path, body, options.timeout || 15000)
    }

    /**
     * Make a streaming request through the browser bridge
     * @param {string} email - Account email
     * @param {string} token - Auth token
     * @param {string} path - API path
     * @param {object} body - Request body
     * @param {object} [options] - Options
     * @returns {Promise<{status: number, stream: PassThrough, headers: object}>}
     */
    async stream(email, token, path, body, options = {}) {
        const session = await this.getSession(email, token, options)
        return await session.fetchStream(path, body, options.timeout || BRIDGE_TIMEOUT)
    }

    /**
     * Close a specific session
     * @param {string} email
     */
    async closeSession(email) {
        const session = this._sessions.get(email)
        if (session) {
            await session.close()
            this._sessions.delete(email)
            logger.info(`[BRIDGE] Session closed for ${email}`, 'BRIDGE')
        }
    }

    /**
     * Close all sessions (graceful shutdown)
     */
    async closeAll() {
        for (const [email, session] of this._sessions) {
            await session.close().catch(() => {})
        }
        this._sessions.clear()
        logger.info('[BRIDGE] All sessions closed', 'BRIDGE')
    }

    /**
     * Get status of all sessions
     */
    getStatus() {
        const sessions = []
        for (const [email, session] of this._sessions) {
            sessions.push(session.getInfo())
        }
        return { enabled: this._enabled, available: this.isAvailable(), sessions }
    }

    /**
     * Evict the least recently used session
     * @private
     */
    async _evictOldest() {
        let oldestEmail = null
        let oldestTime = Infinity

        for (const [email, session] of this._sessions) {
            if (session._lastActivity < oldestTime) {
                oldestTime = session._lastActivity
                oldestEmail = email
            }
        }

        if (oldestEmail) {
            await this.closeSession(oldestEmail)
            logger.info(`[BRIDGE] Evicted oldest session: ${oldestEmail}`, 'BRIDGE')
        }
    }
}

// Singleton
const browserBridge = new BrowserBridge()

// Graceful shutdown
process.on('exit', () => { browserBridge.closeAll().catch(() => {}) })
process.on('SIGINT', () => { browserBridge.closeAll().catch(() => {}); process.exit(0) })
process.on('SIGTERM', () => { browserBridge.closeAll().catch(() => {}); process.exit(0) })

module.exports = {
    browserBridge,
    BrowserBridge,
    BrowserSession,
}
