/**
 * HTTP/2 Client for upstream Qwen API requests
 * 
 * Replaces axios with Node.js native http2 module for upstream calls.
 * HTTP/2 is critical for bypassing Aliyun WAF — the WAF uses TLS/HTTP
 * protocol fingerprinting to distinguish real browsers (HTTP/2) from
 * scripts (HTTP/1.1 via axios/fetch).
 * 
 * Features:
 *   - Persistent HTTP/2 session with connection pooling
 *   - Automatic reconnection on session errors
 *   - Stream response support (for SSE chat completions)
 *   - JSON response support (for /chats/new, /models, etc.)
 *   - Cookie injection from browser login sessions
 *   - Proxy support via CONNECT tunneling
 * 
 * Environment variables:
 *   HTTP2_IDLE_TIMEOUT=30000       — idle timeout before closing session (ms)
 *   HTTP2_CONNECT_TIMEOUT=10000    — connection timeout (ms)
 *   HTTP2_MAX_SESSIONS=5           — max concurrent sessions
 */

'use strict'

const http2 = require('http2')
const { URL } = require('url')
const net = require('net')
const tls = require('tls')
const { logger } = require('./logger')

const QWEN_BASE_URL = process.env.QWEN_CHAT_PROXY_URL || 'https://chat.qwen.ai'
const IDLE_TIMEOUT = parseInt(process.env.HTTP2_IDLE_TIMEOUT) || 30000
const CONNECT_TIMEOUT = parseInt(process.env.HTTP2_CONNECT_TIMEOUT) || 10000

/**
 * Standard request headers matching qwen2API's approach
 */
function buildHeaders(token, cookies, extraHeaders = {}) {
    const headers = {
        ':method': 'POST',
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

/**
 * HTTP/2 Session Manager
 * Maintains a persistent HTTP/2 connection to the upstream server
 */
class Http2SessionManager {
    constructor() {
        this._session = null
        this._connecting = null
        this._lastActivity = 0
        this._baseUrl = QWEN_BASE_URL
    }

    /**
     * Get or create an HTTP/2 session
     * @param {string} [proxyUrl] - Optional proxy URL for CONNECT tunneling
     * @returns {Promise<http2.ClientHttp2Session>}
     */
    async getSession(proxyUrl = null) {
        // Reuse existing session if still alive
        if (this._session && !this._session.closed && !this._session.destroyed) {
            this._lastActivity = Date.now()
            return this._session
        }

        // Avoid duplicate connection attempts
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

    /**
     * Create a new HTTP/2 session
     * @private
     */
    async _createSession(proxyUrl) {
        const parsed = new URL(this._baseUrl)

        let socket = null
        if (proxyUrl) {
            socket = await this._connectViaProxy(proxyUrl, parsed.hostname, parseInt(parsed.port) || 443)
        }

        return new Promise((resolve, reject) => {
            const options = {
                rejectUnauthorized: true,
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

            session.on('goaway', () => {
                logger.warn('[HTTP2] Server sent GOAWAY', 'HTTP2')
                this._session = null
            })

            // Auto-close idle sessions
            session.setTimeout(IDLE_TIMEOUT, () => {
                logger.info('[HTTP2] Session idle timeout, closing', 'HTTP2')
                session.close()
                this._session = null
            })
        })
    }

    /**
     * CONNECT tunneling through HTTP proxy for HTTP/2
     * @private
     */
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

    /**
     * Close the session
     */
    close() {
        if (this._session && !this._session.closed) {
            this._session.close()
            this._session = null
        }
    }
}

// Singleton session manager
const sessionManager = new Http2SessionManager()

/**
 * Make an HTTP/2 JSON request (for /chats/new, /models, /auth, etc.)
 * 
 * @param {string} method - HTTP method (GET, POST, DELETE)
 * @param {string} path - Request path (e.g. '/api/v2/chats/new')
 * @param {object} [body] - JSON body (for POST/PUT)
 * @param {string} token - Auth token
 * @param {string} [cookies] - Cookie string from browser login
 * @param {object} [options] - Extra options
 * @param {string} [options.proxyUrl] - Proxy URL
 * @param {number} [options.timeout] - Request timeout in ms (default: 15000)
 * @returns {Promise<{status: number, data: any, headers: object}>}
 */
async function http2Request(method, path, body, token, cookies = '', options = {}) {
    const timeout = options.timeout || 15000

    let session
    try {
        session = await sessionManager.getSession(options.proxyUrl)
    } catch (err) {
        // Fallback: try without session reuse
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
            sessionManager.close() // Force reconnect on next call
            reject(err)
        })

        // Send body
        if (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT')) {
            const payload = typeof body === 'string' ? body : JSON.stringify(body)
            req.write(payload)
        }

        req.end()
    })
}

/**
 * Make an HTTP/2 streaming request (for /chat/completions SSE)
 * Returns a readable stream of the response body.
 * 
 * @param {string} path - Request path
 * @param {object} body - JSON body
 * @param {string} token - Auth token
 * @param {string} [cookies] - Cookie string from browser login
 * @param {object} [options] - Extra options
 * @param {string} [options.proxyUrl] - Proxy URL
 * @param {number} [options.timeout] - Connection timeout in ms (default: 60000)
 * @returns {Promise<{status: number, stream: http2.ClientHttp2Stream, headers: object}>}
 */
async function http2Stream(path, body, token, cookies = '', options = {}) {
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

            // Check for captcha/risk-control JSON response on streaming endpoint
            // Normal streaming returns text/event-stream; if we get application/json
            // it's almost always a captcha challenge or error response
            if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
                let body = ''
                req.on('data', (chunk) => { body += chunk.toString() })
                req.on('end', () => {
                    // Detect RGV587 captcha challenge
                    if (body.includes('RGV587') || body.includes('_____tmd_____') || body.includes('FAIL_SYS_USER_VALIDATE') || body.includes('punish')) {
                        reject(new Error(`CAPTCHA_BLOCKED: upstream returned captcha challenge (status=${status}, body=${body.slice(0, 300)})`))
                        return
                    }
                    // Detect rate limit
                    if (body.includes('too_many_requests') || body.includes('Too Many Requests')) {
                        reject(new Error(`RATE_LIMITED: upstream rate limit (status=${status})`))
                        return
                    }
                    // Other JSON error — still not a valid stream
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

        // Send body
        const payload = typeof body === 'string' ? body : JSON.stringify(body)
        req.write(payload)
        req.end()
    })
}

/**
 * Close the HTTP/2 session manager (for graceful shutdown)
 */
function closeHttp2() {
    sessionManager.close()
}

module.exports = {
    http2Request,
    http2Stream,
    closeHttp2,
    buildHeaders,
    Http2SessionManager,
}
