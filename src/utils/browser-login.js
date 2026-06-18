/**
 * Browser Login Module
 * 
 * Uses Playwright headless Chromium to perform real browser login on chat.qwen.ai,
 * bypassing WAF/captcha challenges. After login, navigates to the chat page and
 * waits for Alibaba's security SDK (AWSC/x5sec) to generate anti-bot cookies.
 * 
 * Key insight: login alone is not enough. The WAF checks for cookies generated
 * by client-side security JavaScript that runs AFTER login, on the main chat page.
 * Without these cookies (especially x5sec/cna), subsequent API calls trigger captcha.
 * 
 * Flow:
 *   1. Navigate to /auth → fill credentials → submit
 *   2. Wait for token in localStorage (login success)
 *   3. Navigate to main chat page (loads security SDK)
 *   4. Wait for security scripts to initialize + generate cookies
 *   5. Make a test API call FROM the browser (triggers x5sec generation)
 *   6. Intercept the request to capture full cookie + header set
 *   7. Return token + complete cookie string (includes x5sec, cna, etc.)
 * 
 * Environment variables:
 *   BROWSER_LOGIN_ENABLED=true  — enable Playwright login (default: true)
 *   BROWSER_LOGIN_TIMEOUT=90000 — max ms to wait for login to complete
 *   BROWSER_HEADLESS=true       — run headless (default: true)
 */

const { logger } = require('./logger')

const QWEN_BASE_URL = 'https://chat.qwen.ai'
const LOGIN_TIMEOUT = parseInt(process.env.BROWSER_LOGIN_TIMEOUT) || 90000
const BROWSER_HEADLESS = process.env.BROWSER_HEADLESS !== 'false'

let chromium = null
let playwrightAvailable = false

// Lazy-load playwright to avoid crash if not installed
function getPlaywright() {
    if (chromium) return chromium
    try {
        const pw = require('playwright')
        chromium = pw.chromium
        playwrightAvailable = true
        return chromium
    } catch (e) {
        logger.error('Playwright not available. Run: npm install playwright && npx playwright install chromium', 'BROWSER')
        playwrightAvailable = false
        return null
    }
}

/**
 * Check if Playwright browser login is available
 */
function isBrowserLoginAvailable() {
    if (process.env.BROWSER_LOGIN_ENABLED === 'false') return false
    getPlaywright()
    return playwrightAvailable
}

/**
 * Login to Qwen via headless browser and extract token + full cookies
 * (including x5sec anti-bot cookies from Alibaba's security SDK)
 * 
 * @param {string} email - Account email
 * @param {string} password - Account password
 * @param {object} [options] - Optional settings
 * @param {string} [options.proxyUrl] - Proxy URL for browser (socks5://... or http://...)
 * @returns {Promise<{token: string, cookies: string, success: boolean, error?: string}>}
 */
async function browserLogin(email, password, options = {}) {
    const pw = getPlaywright()
    if (!pw) {
        return { token: '', cookies: '', success: false, error: 'Playwright not available' }
    }

    let browser = null
    try {
        logger.info(`[BROWSER] Starting browser login for ${email}`, 'AUTH')

        const launchOptions = {
            headless: BROWSER_HEADLESS,
            args: [
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-extensions',
            ],
            timeout: LOGIN_TIMEOUT,
        }

        // Proxy support
        if (options.proxyUrl) {
            launchOptions.proxy = { server: options.proxyUrl }
        }

        browser = await pw.launch(launchOptions)

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            locale: 'zh-CN',
            viewport: { width: 1920, height: 1080 },
            extraHTTPHeaders: {
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            // Bypass automation detection
            bypassCSP: true,
        })

        // Remove navigator.webdriver flag to avoid detection
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
            // Override permissions query
            const originalQuery = window.navigator.permissions.query
            window.navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(parameters)
        })

        const page = await context.newPage()
        page.setDefaultTimeout(30000)
        page.setDefaultNavigationTimeout(60000)

        // ─── Step 1: Login ────────────────────────────────────────────────
        await page.goto(`${QWEN_BASE_URL}/`, {
            waitUntil: 'networkidle',
            timeout: 30000,
        })
        await sleep(2000)

        // Check if already redirected to auth or need to navigate there
        const currentUrl = page.url()
        if (!currentUrl.includes('/auth')) {
            await page.goto(`${QWEN_BASE_URL}/auth`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            })
            await sleep(2000)
        }

        // Fill email
        const emailFilled = await fillFirst(page, [
            'input[placeholder*="Email"]',
            'input[placeholder*="email"]',
            'input[placeholder*="邮箱"]',
            'input[type="email"]',
            'input[name="email"]',
        ], email)
        if (!emailFilled) {
            await fillNthInput(page, 0, email)
        }
        await sleep(500)

        // Fill password
        const passwordFilled = await fillFirst(page, [
            'input[type="password"]',
            'input[placeholder*="Password"]',
            'input[placeholder*="password"]',
            'input[placeholder*="密码"]',
        ], password)
        if (!passwordFilled) {
            await fillNthInput(page, 1, password)
        }
        await sleep(500)

        // Click login button
        const clicked = await clickFirst(page, [
            'button:has-text("Log in")',
            'button:has-text("登录")',
            'button[type="submit"]:not([disabled])',
            'button[type="submit"]',
            'button:has-text("Continue")',
            'button:has-text("继续")',
        ])
        if (!clicked) {
            await page.press('input[type="password"]', 'Enter').catch(() => {})
        }

        // Wait for token to appear in localStorage
        const token = await waitForToken(page, LOGIN_TIMEOUT)
        if (!token) {
            logger.warn(`[BROWSER] Login failed for ${email}: token not found in localStorage`, 'AUTH')
            return { token: '', cookies: '', success: false, error: 'Token not found after login' }
        }

        logger.info(`[BROWSER] Token obtained for ${email}, waiting for security SDK...`, 'AUTH')

        // ─── Step 2: Navigate to main page & wait for security SDK ────────
        // After login, the page should redirect to /. If not, navigate manually.
        const afterLoginUrl = page.url()
        if (afterLoginUrl.includes('/auth')) {
            await page.goto(`${QWEN_BASE_URL}/`, {
                waitUntil: 'networkidle',
                timeout: 30000,
            }).catch(() => {})
        } else {
            // Already on main page, wait for network to settle
            await page.waitForLoadState('networkidle').catch(() => {})
        }

        // Wait for security scripts to execute and generate cookies
        // The Alibaba AWSC SDK typically takes 2-5 seconds to initialize
        await sleep(5000)

        // ─── Step 3: Make a test API call to trigger x5sec generation ─────
        // The x5sec cookie is often only generated on the FIRST API call
        // from a new session. We make a lightweight call (/api/v2/chats)
        // from within the browser to trigger this.
        let interceptedCookies = ''
        
        try {
            // Set up network interception to capture the cookies/headers
            // the browser actually sends on API requests
            interceptedCookies = await page.evaluate(async (baseUrl) => {
                try {
                    const resp = await fetch(`${baseUrl}/api/v2/chats?page=1&page_size=1`, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json',
                        },
                    })
                    // We don't care about the response, we just want the cookies to be set
                    await resp.text().catch(() => {})
                } catch {
                    // Fetch might fail but cookies will still be generated
                }
                // Return document.cookie which has all accessible cookies
                return document.cookie || ''
            }, QWEN_BASE_URL)
        } catch {
            // Non-critical — we still try to get cookies from context
        }

        // Wait a bit more for any async cookie updates
        await sleep(2000)

        // ─── Step 4: Extract ALL cookies ──────────────────────────────────
        // Get cookies from the browser context (includes httpOnly cookies
        // that document.cookie can't see)
        const allCookies = await extractAllCookies(context)
        
        // Merge with document.cookie (might have additional non-httpOnly ones)
        const mergedCookies = mergeCookies(allCookies, interceptedCookies)

        logger.info(`[BROWSER] Login + security init complete for ${email} (cookies: ${mergedCookies.length > 0 ? mergedCookies.split(';').length + ' items' : 'none'})`, 'AUTH')

        // Log cookie names for debugging (not values)
        const cookieNames = mergedCookies.split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
        logger.info(`[BROWSER] Cookie names: ${cookieNames.join(', ')}`, 'AUTH')

        return { token, cookies: mergedCookies, success: true }
    } catch (error) {
        logger.error(`[BROWSER] Login error for ${email}: ${error.message}`, 'AUTH')
        return { token: '', cookies: '', success: false, error: error.message }
    } finally {
        if (browser) {
            await browser.close().catch(() => {})
        }
    }
}

/**
 * Refresh token using browser (navigate to site with existing session)
 * Useful when token expires but cookies might still be valid
 * 
 * @param {string} email - Account email
 * @param {string} password - Account password
 * @param {object} [options] - Optional settings
 * @returns {Promise<{token: string, cookies: string, success: boolean, error?: string}>}
 */
async function browserRefreshToken(email, password, options = {}) {
    return browserLogin(email, password, options)
}

// ─── Helper Functions ────────────────────────────────────────────────────────

async function fillFirst(page, selectors, value) {
    for (const selector of selectors) {
        try {
            await page.waitForSelector(selector, { timeout: 5000 })
            await page.fill(selector, value, { timeout: 5000 })
            return true
        } catch {
            continue
        }
    }
    return false
}

async function clickFirst(page, selectors) {
    for (const selector of selectors) {
        try {
            await page.click(selector, { timeout: 5000, force: true })
            return true
        } catch {
            continue
        }
    }
    return false
}

async function fillNthInput(page, index, value) {
    try {
        await page.evaluate(([idx, val]) => {
            const inputs = Array.from(document.querySelectorAll('input'))
            const el = inputs[idx]
            if (!el) return false
            el.focus()
            el.value = val
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
        }, [index, value])
        return true
    } catch {
        return false
    }
}

async function waitForToken(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const token = await page.evaluate(() => {
                // Try multiple storage locations
                return localStorage.getItem('token')
                    || localStorage.getItem('access_token')
                    || sessionStorage.getItem('token')
                    || ''
            })
            if (token && token.trim()) {
                return token.trim()
            }
        } catch {
            // page might not be ready yet
        }
        await sleep(1000)
    }
    return ''
}

/**
 * Extract ALL cookies from the browser context (no domain filtering).
 * Includes httpOnly cookies that document.cookie can't access.
 * 
 * @param {BrowserContext} context
 * @returns {Promise<string>} Full cookie string
 */
async function extractAllCookies(context) {
    try {
        // Get cookies for all relevant URLs
        const urls = [
            QWEN_BASE_URL,
            'https://qwen.ai',
            'https://aliyun.com',
            'https://taobao.com',   // Alibaba's tracking often uses taobao domain
            'https://mmstat.com',   // Alibaba analytics
        ]

        const allCookies = []
        const seen = new Set()

        for (const url of urls) {
            try {
                const cookies = await context.cookies(url)
                for (const c of cookies) {
                    const key = `${c.name}=${c.value}`
                    if (!seen.has(c.name)) {
                        seen.add(c.name)
                        allCookies.push(key)
                    }
                }
            } catch {
                // Some URLs might not have cookies, that's fine
            }
        }

        return allCookies.join('; ')
    } catch {
        return ''
    }
}

/**
 * Merge cookies from browser context and document.cookie.
 * Deduplicates by cookie name, preferring the context version (httpOnly-aware).
 * 
 * @param {string} contextCookies - From browser context API
 * @param {string} documentCookies - From document.cookie in page
 * @returns {string} Merged cookie string
 */
function mergeCookies(contextCookies, documentCookies) {
    const cookieMap = new Map()

    // Parse context cookies first (higher priority - includes httpOnly)
    if (contextCookies) {
        for (const pair of contextCookies.split(';')) {
            const trimmed = pair.trim()
            if (!trimmed) continue
            const eqIdx = trimmed.indexOf('=')
            if (eqIdx === -1) continue
            const name = trimmed.substring(0, eqIdx).trim()
            const value = trimmed.substring(eqIdx + 1).trim()
            if (name) cookieMap.set(name, value)
        }
    }

    // Add document.cookie entries (only if not already present)
    if (documentCookies) {
        for (const pair of documentCookies.split(';')) {
            const trimmed = pair.trim()
            if (!trimmed) continue
            const eqIdx = trimmed.indexOf('=')
            if (eqIdx === -1) continue
            const name = trimmed.substring(0, eqIdx).trim()
            const value = trimmed.substring(eqIdx + 1).trim()
            if (name && !cookieMap.has(name)) {
                cookieMap.set(name, value)
            }
        }
    }

    // Build the final cookie string
    const parts = []
    for (const [name, value] of cookieMap) {
        parts.push(`${name}=${value}`)
    }
    return parts.join('; ')
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
    browserLogin,
    browserRefreshToken,
    isBrowserLoginAvailable,
    QWEN_BASE_URL,
}
