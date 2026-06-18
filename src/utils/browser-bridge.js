/**
 * Browser Bridge — Persistent Playwright session for API requests
 * 
 * Routes ALL API requests through a headless browser where Alibaba's
 * security SDK (AWSC/x5sec) runs and adds anti-bot tokens to each request.
 * 
 * Uses page.exposeFunction() for reliable browser→Node.js streaming.
 * 
 * Environment variables:
 *   BROWSER_BRIDGE_ENABLED=true     — enable browser bridge (default: true)
 *   BROWSER_BRIDGE_TIMEOUT=60000    — max request timeout (default: 60s)
 *   BROWSER_BRIDGE_HEADLESS=true    — run headless (default: true)
 *   BROWSER_BRIDGE_MAX_SESSIONS=3   — max concurrent browser sessions
 */

'use strict'

const { logger } = require('./logger')
const { PassThrough } = require('stream')
const EventEmitter = require('events')

const QWEN_BASE_URL = 'https://chat.qwen.ai'
const BRIDGE_TIMEOUT = parseInt(process.env.BROWSER_BRIDGE_TIMEOUT) || 60000
const BRIDGE_HEADLESS = process.env.BROWSER_BRIDGE_HEADLESS !== 'false'
const MAX_SESSIONS = parseInt(process.env.BROWSER_BRIDGE_MAX_SESSIONS) || 3
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
        this._emitter = new EventEmitter()
        this._token = ''
    }

    /**
     * Initialize the browser session.
     */
    async initialize(token, options = {}) {
        if (this._initializing) return this._initializing
        this._initializing = this._doInit(token, options)
        try {
            await this._initializing
        } finally {
            this._initializing = null
        }
    }

    async _doInit(token, options = {}) {
        await this.close()
        this._token = token

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
            bypassCSP: true,
        })

        await this.context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        })

        this.page = await this.context.newPage()
        this.page.setDefaultTimeout(30000)
        this.page.setDefaultNavigationTimeout(60000)

        // Expose function for streaming chunks from browser → Node.js
        await this.page.exposeFunction('__bridgeChunk', (channelId, type, data) => {
            this._emitter.emit(`chunk:${channelId}`, { type, data })
        })

        // Navigate and set up auth
        await this.page.goto(`${QWEN_BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
        
        // Inject token
        await this.page.evaluate((t) => { localStorage.setItem('token', t) }, token)
        
        // Reload to let the site pick up the token
        await this.page.reload({ waitUntil: 'networkidle', timeout: 30000 })
        
        // Wait for security SDK to initialize
        await this.page.waitForTimeout(5000)

        this.ready = true
        this._lastActivity = Date.now()
        logger.info(`[BRIDGE] Browser session ready for ${this.email}`, 'BRIDGE')
    }

    isReady() {
        if (!this.ready || !this.browser || !this.page) return false
        try {
            // Quick check if browser is still connected
            return this.browser.isConnected()
        } catch {
            return false
        }
    }

    /**
     * JSON request through browser.
     */
    async fetchJSON(method, path, body = null, timeout = 15000) {
        if (!this.isReady()) throw new Error('Session not ready')
        this._lastActivity = Date.now()
        this._requestCount++

        const token = this._token

        const result = await this.page.evaluate(async ({ baseUrl, method, path, body, timeout, token }) => {
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), timeout)
            try {
                const opts = {
                    method,
                    credentials: 'include',
                    signal: ctrl.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/plain, */*',
                        'Authorization': `Bearer ${token}`,
                    },
                }
                if (body && (method === 'POST' || method === 'PUT')) {
                    opts.body = JSON.stringify(body)
                }
                const resp = await fetch(`${baseUrl}${path}`, opts)
                const text = await resp.text()
                let data
                try { data = JSON.parse(text) } catch { data = text }
                return { status: resp.status, data, error: null }
            } catch (err) {
                return { status: 0, data: null, error: err.message || 'fetch error' }
            } finally {
                clearTimeout(timer)
            }
        }, { baseUrl: QWEN_BASE_URL, method, path, body, timeout, token })

        if (result.error) throw new Error(`Bridge fetch: ${result.error}`)
        return { status: result.status, data: result.data }
    }

    /**
     * Streaming SSE request through browser.
     * Uses exposeFunction for reliable chunk relay.
     */
    async fetchStream(path, body, timeout = BRIDGE_TIMEOUT) {
        if (!this.isReady()) throw new Error('Session not ready')
        this._lastActivity = Date.now()
        this._requestCount++

        const token = this._token
        const channelId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const stream = new PassThrough()

        // Listen for chunks from browser via exposeFunction
        const onChunk = ({ type, data }) => {
            if (type === 'data') {
                stream.write(data)
            } else if (type === 'end') {
                stream.end()
                cleanup()
            } else if (type === 'error') {
                stream.destroy(new Error(data))
                cleanup()
            }
        }
        const cleanup = () => {
            this._emitter.removeListener(`chunk:${channelId}`, onChunk)
        }
        this._emitter.on(`chunk:${channelId}`, onChunk)

        // Safety timeout
        const safetyTimer = setTimeout(() => {
            cleanup()
            if (!stream.destroyed && !stream.writableEnded) {
                stream.destroy(new Error('Bridge stream timeout'))
            }
        }, timeout + 5000)
        stream.once('end', () => clearTimeout(safetyTimer))
        stream.once('error', () => clearTimeout(safetyTimer))

        // Start fetch inside browser
        const initResult = await this.page.evaluate(async ({ baseUrl, path, body, timeout, token, channelId }) => {
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), timeout)
            try {
                const resp = await fetch(`${baseUrl}${path}`, {
                    method: 'POST',
                    credentials: 'include',
                    signal: ctrl.signal,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'text/event-stream',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify(body),
                })

                const status = resp.status
                const contentType = resp.headers.get('content-type') || ''

                // Non-stream response (error/captcha) → send as single chunk
                if (!contentType.includes('event-stream') && !contentType.includes('octet-stream')) {
                    const text = await resp.text()
                    await window.__bridgeChunk(channelId, 'data', text)
                    await window.__bridgeChunk(channelId, 'end', '')
                    return { status, contentType, error: null }
                }

                // Stream response → relay chunks
                const reader = resp.body.getReader()
                const decoder = new TextDecoder()

                // Read in background (don't await the whole thing)
                ;(async () => {
                    try {
                        while (true) {
                            const { done, value } = await reader.read()
                            if (done) break
                            const text = decoder.decode(value, { stream: true })
                            await window.__bridgeChunk(channelId, 'data', text)
                        }
                        await window.__bridgeChunk(channelId, 'end', '')
                    } catch (err) {
                        await window.__bridgeChunk(channelId, 'error', err.message || 'stream read error')
                    }
                })()

                return { status, contentType, error: null }
            } catch (err) {
                await window.__bridgeChunk(channelId, 'error', err.message || 'fetch failed')
                return { status: 0, contentType: '', error: err.message }
            } finally {
                clearTimeout(timer)
            }
        }, { baseUrl: QWEN_BASE_URL, path, body, timeout, token, channelId })

        if (initResult.error) {
            cleanup()
            clearTimeout(safetyTimer)
            throw new Error(`Bridge stream init: ${initResult.error}`)
        }

        return {
            status: initResult.status,
            stream,
            headers: { 'content-type': initResult.contentType || 'text/event-stream' },
        }
    }

    async close() {
        this.ready = false
        if (this.browser) {
            try { await this.browser.close() } catch {}
            this.browser = null
            this.context = null
            this.page = null
        }
        this._emitter.removeAllListeners()
    }

    getInfo() {
        return {
            email: this.email,
            ready: this.ready,
            requestCount: this._requestCount,
            lastActivity: this._lastActivity,
        }
    }
}

/**
 * Browser Bridge Manager — manages browser sessions per account.
 */
class BrowserBridge {
    constructor() {
        this._sessions = new Map()
        this._enabled = BRIDGE_ENABLED
    }

    isAvailable() {
        if (!this._enabled) return false
        getPlaywright()
        return playwrightAvailable
    }

    async getSession(email, token, options = {}) {
        let session = this._sessions.get(email)
        if (session && session.isReady()) return session

        if (!session && this._sessions.size >= MAX_SESSIONS) {
            await this._evictOldest()
        }

        if (!session) {
            session = new BrowserSession(email)
            this._sessions.set(email, session)
        }

        await session.initialize(token, options)
        return session
    }

    async request(email, token, method, path, body = null, options = {}) {
        const session = await this.getSession(email, token, options)
        return await session.fetchJSON(method, path, body, options.timeout || 15000)
    }

    async stream(email, token, path, body, options = {}) {
        const session = await this.getSession(email, token, options)
        return await session.fetchStream(path, body, options.timeout || BRIDGE_TIMEOUT)
    }

    async closeSession(email) {
        const session = this._sessions.get(email)
        if (session) {
            await session.close()
            this._sessions.delete(email)
            logger.info(`[BRIDGE] Session closed: ${email}`, 'BRIDGE')
        }
    }

    async closeAll() {
        for (const [, session] of this._sessions) {
            await session.close().catch(() => {})
        }
        this._sessions.clear()
    }

    getStatus() {
        const sessions = []
        for (const [, session] of this._sessions) {
            sessions.push(session.getInfo())
        }
        return { enabled: this._enabled, available: this.isAvailable(), sessions }
    }

    async _evictOldest() {
        let oldestEmail = null
        let oldestTime = Infinity
        for (const [email, session] of this._sessions) {
            if (session._lastActivity < oldestTime) {
                oldestTime = session._lastActivity
                oldestEmail = email
            }
        }
        if (oldestEmail) await this.closeSession(oldestEmail)
    }
}

const browserBridge = new BrowserBridge()

process.on('SIGINT', () => { browserBridge.closeAll().catch(() => {}); process.exit(0) })
process.on('SIGTERM', () => { browserBridge.closeAll().catch(() => {}); process.exit(0) })

module.exports = { browserBridge, BrowserBridge, BrowserSession }
