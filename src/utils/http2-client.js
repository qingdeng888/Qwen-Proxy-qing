/**
 * Smart HTTP Client for upstream Qwen API requests
 * 
 * Dual-mode: tries HTTP/2 first (better anti-fingerprint), auto-falls back
 * to HTTP/1.1 (axios) when protocol errors occur. The fallback is sticky —
 * once HTTP/2 fails, subsequent requests use HTTP/1.1 until a periodic
 * probe re-enables it.
 * 
 * HTTP/2 benefits: TLS fingerprint closer to real browsers (Chrome uses h2).
 * HTTP/1.1 benefits: more reliable when the CDN/WAF interferes with h2 framing.
 * 
 * Features:
 *   - Automatic protocol fallback (h2 → h1.1)
 *   - Persistent HTTP/2 session with connection pooling
 *   - Automatic reconnection on session errors
 *   - Stream response support (for SSE chat completions)
 *   - JSON response support (for /chats/new, /models, etc.)
 *   - Cookie injection from browser login sessions
 *   - Proxy support (CONNECT tunneling for h2, proxy-agent for h1.1)
 * 
 * Environment variables:
 *   HTTP2_IDLE_TIMEOUT=30000       — idle timeout before closing session (ms)
 *   HTTP2_CONNECT_TIMEOUT=10000    — connection timeout (ms)
 *   FORCE_HTTP1=false              — force HTTP/1.1 mode (skip h2 entirely)
 */

'use strict'

const http2 = require('http2')
const { URL } = require('url')
const net = require('net')
const tls = require('tls')
const axios = require('axios')
const { PassThrough } = require('stream')
const { logger } = require('./logger')

const QWEN_BASE_URL = process.env.QWEN_CHAT_PROXY_URL || 'https://chat.qwen.ai'
const IDLE_TIMEOUT = parseInt(process.env.HTTP2_IDLE_TIMEOUT) || 30000
const CONNECT_TIMEOUT = parseInt(process.env.HTTP2_CONNECT_TIMEOUT) || 10000
const FORCE_HTTP1 = process.env.FORCE_HTTP1 === 'true'

// ─── Protocol Mode Tracker ──────────────────────────────────────────────────
// Tracks whether HTTP/2 works or we need to fall back to HTTP/1.1

let _protocolMode = FORCE_HTTP1 ? 'http1' : 'http2' // 'http2' | 'http1'
let _http2FailCount = 0
const HTTP2_FAIL_THRESHOLD = 2 // Switch to h1.1 after N consecutive h2 failures
const HTTP2_RETRY_INTERVAL = 5 * 60 * 1000 // Try h2 again after 5 min
let _http2RetryTimer = null

function switchToHttp1(reason) {
    if (_protocolMode === 'http1') return
    _protocolMode = 'http1'
    logger.warn(`[HTTP] Switching to HTTP/1.1 mode (reason: ${reason})`, 'HTTP')

    // Schedule periodic retry of HTTP/2
    if (!_http2RetryTimer) {
        _http2RetryTimer = setTimeout(() => {
            _http2RetryTimer = null
            _http2FailCount = 0
            _protocolMode = 'http2'
            logger.info('[HTTP] Re-enabling HTTP/2 mode (periodic retry)', 'HTTP')
        }, HTTP2_RETRY_INTERVAL)
    }
}

function recordHttp2Failure() {
    _http2FailCount++
    if (_http2FailCount >= HTTP2_FAIL_THRESHOLD) {
        switchToHttp1('consecutive protocol errors')
    }
}

function recordHttp2Success() {
    _http2FailCount = 0
}

/**
 * Standard request headers matching Chrome browser
 */
function buildHeaders(token, cookies, extraHeaders = {}) {
    const headers = {
        'authorization': `Bearer ${token}`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'accept': 'application/json, text/event-stream',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'content-type': 'application/json',
        'origin': QWEN_BASE_URL,
        'referer': `${QWEN_BASE_URL}/`,
        'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        ...extraHeaders,
    }

    // Include cookies from browser login if available
    if (cookies) {
        headers['cookie'] = cookies
    }

    return headers
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP/2 Implementation
// ═══════════════════════════════════════════════════════════════════════════════

class Http2SessionManager {
    constructor() {
        this._session = null
        this._connecting = null
        this._lastActivity = 0
        this._baseUrl = QWEN_BASE_URL
    }

    async getSession(proxyUrl = null) {
        if (this._session && !this._session.closed && !this._session.destroyed) {
            this._lastActivity = Date.now()
            return this._session
        }

        if (this._connecting) {
            return this._connecting
        }

        this._connecting = this._createSession(proxyUrl)
        try {
            this._session = await this._connecting
            this._lastActivity = Date.now()
            return this._session
        } finally {
            this._connecting = null
        }
    }

    async _createSession(proxyUrl) {
        const parsed = new URL(this._baseUrl)

        let socket = null
        if (proxyUrl) {
            socket = await this._connectViaProxy(proxyUrl, parsed.hostname, parseInt(parsed.port) || 443)
        }

        return new Promise((resolve, reject) => {
            const options = {
                rejectUnauthorized: true,
                settings: {
                    enablePush: false,
                },
            }

            if (socket) {
                options.createConnection = () => {
                    return tls.connect({
                        socket,
                        servername: parsed.hostname,
                        ALPNProtocols: ['h2'],
                    })
                }
            }

            const session = http2.connect(this._baseUrl, options)

            const timeout = setTimeout(() => {
                session.destroy()
                reject(new Error('HTTP/2 connection timeout'))
            }, CONNECT_TIMEOUT)

            session.on('connect', () => {
                clearTimeout(timeout)
                logger.info('[HTTP2] Session established', 'HTTP2')
                resolve(session)
            })

            session.on('error', (err) => {
                clearTimeout(timeout)
                logger.error(`[HTTP2] Session error: ${err.message}`, 'HTTP2')
                this._session = null
                reject(err)
            })

            session.on('close', () => {
                logger.info('[HTTP2] Session closed', 'HTTP2')
                this._session = null
            })

            session.on('goaway', (errorCode) => {
                logger.warn(`[HTTP2] Server sent GOAWAY (code=${errorCode})`, 'HTTP2')
                this._session = null
            })

            session.setTimeout(IDLE_TIMEOUT, () => {
                logger.info('[HTTP2] Session idle timeout, closing', 'HTTP2')
                session.close()
                this._session = null
            })
        })
    }

    _connectViaProxy(proxyUrl, targetHost, targetPort) {
        return new Promise((resolve, reject) => {
            const proxy = new URL(proxyUrl)
            const proxyHost = proxy.hostname
            const proxyPort = parseInt(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)

            const socket = net.connect(proxyPort, proxyHost, () => {
                const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`
                const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n` : ''
                socket.write(`${connectReq}${auth}\r\n`)
            })

            socket.once('data', (chunk) => {
                const response = chunk.toString()
                if (response.includes('200')) {
                    resolve(socket)
                } else {
                    socket.destroy()
                    reject(new Error(`Proxy CONNECT failed: ${response.split('\r\n')[0]}`))
                }
            })

            socket.on('error', (err) => {
                reject(new Error(`Proxy connection failed: ${err.message}`))
            })

            setTimeout(() => {
                socket.destroy()
                reject(new Error('Proxy CONNECT timeout'))
            }, CONNECT_TIMEOUT)
        })
    }

    close() {
        if (this._session && !this._session.closed) {
            this._session.close()
            this._session = null
        }
    }
}

const sessionManager = new Http2SessionManager()

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP/1.1 Implementation (axios fallback)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a proxy agent for axios based on the proxy URL scheme
 * @param {string} proxyUrl
 * @returns {object|null} Agent or null
 */
function buildAxiosProxyAgent(proxyUrl) {
    if (!proxyUrl) return null
    try {
        const url = new URL(proxyUrl)
        if (/^socks/.test(url.protocol)) {
            const { SocksProxyAgent } = require('socks-proxy-agent')
            return new SocksProxyAgent(proxyUrl)
        } else {
            const { HttpsProxyAgent } = require('https-proxy-agent')
            return new HttpsProxyAgent(proxyUrl)
        }
    } catch {
        return null
    }
}

/**
 * HTTP/1.1 JSON request via axios
 */
async function http1Request(method, path, body, token, cookies = '', options = {}) {
    const timeout = options.timeout || 15000
    const url = `${QWEN_BASE_URL}${path}`

    const headers = buildHeaders(token, cookies)
    // Remove HTTP/2 pseudo-headers for HTTP/1.1
    delete headers[':method']
    delete headers[':path']

    if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE') {
        delete headers['content-type']
    }

    const axiosConfig = {
        method: method.toLowerCase(),
        url,
        headers,
        timeout,
        validateStatus: () => true, // Don't throw on non-2xx
    }

    if (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT')) {
        axiosConfig.data = body
    }

    const agent = buildAxiosProxyAgent(options.proxyUrl)
    if (agent) {
        axiosConfig.httpsAgent = agent
        axiosConfig.proxy = false
    }

    const response = await axios(axiosConfig)

    return {
        status: response.status,
        data: response.data,
        headers: response.headers,
    }
}

/**
 * HTTP/1.1 streaming request via axios (for SSE)
 */
async function http1Stream(path, body, token, cookies = '', options = {}) {
    const timeout = options.timeout || 60000
    const url = `${QWEN_BASE_URL}${path}`

    const headers = buildHeaders(token, cookies, {
        'accept': 'text/event-stream',
    })
    delete headers[':method']
    delete headers[':path']

    const axiosConfig = {
        method: 'post',
        url,
        headers,
        data: body,
        timeout,
        responseType: 'stream',
        validateStatus: () => true,
    }

    const agent = buildAxiosProxyAgent(options.proxyUrl)
    if (agent) {
        axiosConfig.httpsAgent = agent
        axiosConfig.proxy = false
    }

    const response = await axios(axiosConfig)
    const status = response.status
    const contentType = response.headers['content-type'] || ''

    // Check for WAF HTML response
    if (contentType.includes('text/html')) {
        let body = ''
        response.data.on('data', (chunk) => { body += chunk.toString() })
        await new Promise((resolve) => response.data.on('end', resolve))
        throw new Error(`WAF_BLOCKED: upstream returned text/html (status=${status})`)
    }

    // Check for captcha/risk-control JSON response on streaming endpoint
    if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
        let bodyStr = ''
        response.data.on('data', (chunk) => { bodyStr += chunk.toString() })
        await new Promise((resolve) => response.data.on('end', resolve))
        if (bodyStr.includes('RGV587') || bodyStr.includes('_____tmd_____') || bodyStr.includes('FAIL_SYS_USER_VALIDATE') || bodyStr.includes('punish')) {
            throw new Error(`CAPTCHA_BLOCKED: upstream returned captcha challenge (status=${status}, body=${bodyStr.slice(0, 300)})`)
        }
        if (bodyStr.includes('too_many_requests') || bodyStr.includes('Too Many Requests')) {
            throw new Error(`RATE_LIMITED: upstream rate limit (status=${status})`)
        }
        throw new Error(`UPSTREAM_ERROR: unexpected JSON on stream endpoint (status=${status}, body=${bodyStr.slice(0, 200)})`)
    }

    return { status, stream: response.data, headers: response.headers }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP/2 request methods (internal, called when mode=http2)
// ═══════════════════════════════════════════════════════════════════════════════

async function _h2Request(method, path, body, token, cookies = '', options = {}) {
    const timeout = options.timeout || 15000

    let session
    try {
        session = await sessionManager.getSession(options.proxyUrl)
    } catch (err) {
        logger.warn(`[HTTP2] Session get failed, creating fresh: ${err.message}`, 'HTTP2')
        sessionManager.close()
        session = await sessionManager.getSession(options.proxyUrl)
    }

    return new Promise((resolve, reject) => {
        const headers = buildHeaders(token, cookies, {
            ':method': method.toUpperCase(),
            ':path': path,
        })

        if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE') {
            delete headers['content-type']
        }

        const req = session.request(headers)

        const timer = setTimeout(() => {
            req.close(http2.constants.NGHTTP2_CANCEL)
            reject(new Error(`HTTP/2 request timeout (${timeout}ms)`))
        }, timeout)

        let responseHeaders = {}
        let chunks = []

        req.on('response', (hdrs) => {
            responseHeaders = hdrs
        })

        req.on('data', (chunk) => {
            chunks.push(chunk)
        })

        req.on('end', () => {
            clearTimeout(timer)
            const raw = Buffer.concat(chunks).toString('utf-8')
            const status = responseHeaders[':status'] || 0

            let data = raw
            const contentType = responseHeaders['content-type'] || ''
            if (contentType.includes('application/json')) {
                try { data = JSON.parse(raw) } catch { data = raw }
            }

            resolve({ status, data, headers: responseHeaders })
        })

        req.on('error', (err) => {
            clearTimeout(timer)
            sessionManager.close()
            reject(err)
        })

        if (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT')) {
            const payload = typeof body === 'string' ? body : JSON.stringify(body)
            req.write(payload)
        }

        req.end()
    })
}

async function _h2Stream(path, body, token, cookies = '', options = {}) {
    const timeout = options.timeout || 60000

    let session
    try {
        session = await sessionManager.getSession(options.proxyUrl)
    } catch (err) {
        logger.warn(`[HTTP2] Session get failed for stream, creating fresh: ${err.message}`, 'HTTP2')
        sessionManager.close()
        session = await sessionManager.getSession(options.proxyUrl)
    }

    return new Promise((resolve, reject) => {
        const headers = buildHeaders(token, cookies, {
            ':method': 'POST',
            ':path': path,
            'accept': 'text/event-stream',
        })

        const req = session.request(headers)

        const timer = setTimeout(() => {
            req.close(http2.constants.NGHTTP2_CANCEL)
            reject(new Error(`HTTP/2 stream connection timeout (${timeout}ms)`))
        }, timeout)

        let resolved = false

        req.on('response', (hdrs) => {
            clearTimeout(timer)
            resolved = true

            const status = hdrs[':status'] || 0
            const contentType = hdrs['content-type'] || ''

            // Check for WAF HTML response
            if (contentType.includes('text/html')) {
                let body = ''
                req.on('data', (chunk) => { body += chunk.toString() })
                req.on('end', () => {
                    reject(new Error(`WAF_BLOCKED: upstream returned text/html (status=${status})`))
                })
                return
            }

            // Check for captcha/risk-control JSON response
            if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
                let body = ''
                req.on('data', (chunk) => { body += chunk.toString() })
                req.on('end', () => {
                    if (body.includes('RGV587') || body.includes('_____tmd_____') || body.includes('FAIL_SYS_USER_VALIDATE') || body.includes('punish')) {
                        reject(new Error(`CAPTCHA_BLOCKED: upstream returned captcha challenge (status=${status}, body=${body.slice(0, 300)})`))
                        return
                    }
                    if (body.includes('too_many_requests') || body.includes('Too Many Requests')) {
                        reject(new Error(`RATE_LIMITED: upstream rate limit (status=${status})`))
                        return
                    }
                    reject(new Error(`UPSTREAM_ERROR: unexpected JSON on stream endpoint (status=${status}, body=${body.slice(0, 200)})`))
                })
                return
            }

            resolve({ status, stream: req, headers: hdrs })
        })

        req.on('error', (err) => {
            clearTimeout(timer)
            if (!resolved) {
                sessionManager.close()
                reject(err)
            }
        })

        const payload = typeof body === 'string' ? body : JSON.stringify(body)
        req.write(payload)
        req.end()
    })
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API — smart dispatcher with automatic fallback
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Make a JSON request (for /chats/new, /models, /auth, etc.)
 * Tries HTTP/2 first, falls back to HTTP/1.1 on protocol errors.
 */
async function http2Request(method, path, body, token, cookies = '', options = {}) {
    // If already in HTTP/1.1 mode, skip HTTP/2 attempt
    if (_protocolMode === 'http1') {
        return await http1Request(method, path, body, token, cookies, options)
    }

    try {
        const result = await _h2Request(method, path, body, token, cookies, options)
        recordHttp2Success()
        return result
    } catch (err) {
        const isProtocolError = err.code === 'ERR_HTTP2_ERROR'
            || (err.message && err.message.includes('Protocol error'))
            || (err.message && err.message.includes('NGHTTP2'))
            || (err.message && err.message.includes('HTTP/2 connection'))

        if (isProtocolError) {
            recordHttp2Failure()
            logger.warn(`[HTTP] HTTP/2 failed (${err.message}), falling back to HTTP/1.1`, 'HTTP')
            sessionManager.close()
            return await http1Request(method, path, body, token, cookies, options)
        }

        // Non-protocol errors (WAF, captcha, timeout) — pass through as-is
        throw err
    }
}

/**
 * Make a streaming request (for /chat/completions SSE)
 * Tries HTTP/2 first, falls back to HTTP/1.1 on protocol errors.
 */
async function http2Stream(path, body, token, cookies = '', options = {}) {
    // If already in HTTP/1.1 mode, skip HTTP/2 attempt
    if (_protocolMode === 'http1') {
        return await http1Stream(path, body, token, cookies, options)
    }

    try {
        const result = await _h2Stream(path, body, token, cookies, options)
        recordHttp2Success()
        return result
    } catch (err) {
        const isProtocolError = err.code === 'ERR_HTTP2_ERROR'
            || (err.message && err.message.includes('Protocol error'))
            || (err.message && err.message.includes('NGHTTP2'))
            || (err.message && err.message.includes('HTTP/2 connection'))

        if (isProtocolError) {
            recordHttp2Failure()
            logger.warn(`[HTTP] HTTP/2 stream failed (${err.message}), falling back to HTTP/1.1`, 'HTTP')
            sessionManager.close()
            return await http1Stream(path, body, token, cookies, options)
        }

        // Non-protocol errors — pass through
        throw err
    }
}

/**
 * Close the HTTP/2 session manager (for graceful shutdown)
 */
function closeHttp2() {
    sessionManager.close()
}

/**
 * Get current protocol mode (for diagnostics)
 */
function getProtocolMode() {
    return _protocolMode
}

module.exports = {
    http2Request,
    http2Stream,
    closeHttp2,
    buildHeaders,
    Http2SessionManager,
    getProtocolMode,
}
