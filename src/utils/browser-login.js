/**
 * Browser Login Module
 * 
 * Uses Playwright headless Chromium to perform real browser login on chat.qwen.ai,
 * bypassing WAF/captcha challenges. Extracts token from localStorage and cookies
 * from the browser session.
 * 
 * Based on YuJunZhiXue/qwen2API's Playwright login approach.
 * 
 * Environment variables:
 *   BROWSER_LOGIN_ENABLED=true  — enable Playwright login (default: true)
 *   BROWSER_LOGIN_TIMEOUT=60000 — max ms to wait for login to complete
 *   BROWSER_HEADLESS=true       — run headless (default: true)
 */

const { logger } = require('./logger')

const QWEN_BASE_URL = 'https://chat.qwen.ai'
const LOGIN_TIMEOUT = parseInt(process.env.BROWSER_LOGIN_TIMEOUT) || 60000
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
 * Login to Qwen via headless browser and extract token + cookies
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
            ],
            timeout: LOGIN_TIMEOUT,
        }

        // Proxy support
        if (options.proxyUrl) {
            launchOptions.proxy = { server: options.proxyUrl }
        }

        browser = await pw.launch(launchOptions)

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0',
            locale: 'zh-CN',
            viewport: { width: 1365, height: 768 },
            extraHTTPHeaders: {
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
        })

        const page = await context.newPage()
        page.setDefaultTimeout(30000)
        page.setDefaultNavigationTimeout(60000)

        // Navigate to auth page
        await page.goto(`${QWEN_BASE_URL}/auth`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        })
        await sleep(2000)

        // Fill email
        const emailFilled = await fillFirst(page, [
            'input[placeholder*="Email"]',
            'input[placeholder*="email"]',
            'input[type="email"]',
            'input[name="email"]',
        ], email)
        if (!emailFilled) {
            await fillNthInput(page, 0, email)
        }

        // Fill password
        const passwordFilled = await fillFirst(page, [
            'input[type="password"]',
            'input[placeholder*="Password"]',
            'input[placeholder*="password"]',
        ], password)
        if (!passwordFilled) {
            await fillNthInput(page, 1, password)
        }

        // Click login button
        const clicked = await clickFirst(page, [
            'button:has-text("Log in")',
            'button:has-text("登录")',
            'button[type="submit"]:not([disabled])',
            'button[type="submit"]',
            'button:has-text("Continue")',
        ])
        if (!clicked) {
            // Fallback: press Enter on password field
            await page.press('input[type="password"]', 'Enter').catch(() => {})
        }

        // Wait for token to appear in localStorage
        const token = await waitForToken(page, LOGIN_TIMEOUT)

        if (!token) {
            logger.warn(`[BROWSER] Login failed for ${email}: token not found in localStorage`, 'AUTH')
            return { token: '', cookies: '', success: false, error: 'Token not found after login' }
        }

        // Extract cookies
        const cookies = await extractCookies(context)

        logger.info(`[BROWSER] Login succeeded for ${email} (cookies: ${cookies ? 'yes' : 'none'})`, 'AUTH')

        return { token, cookies, success: true }
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
    // For refresh, just do a full login again
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
            const token = await page.evaluate(() => localStorage.getItem('token'))
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

async function extractCookies(context) {
    try {
        const cookies = await context.cookies(QWEN_BASE_URL)
        const qwenCookies = cookies
            .filter(c => c.domain && (c.domain.includes('qwen') || c.domain.includes('aliyun')))
            .map(c => `${c.name}=${c.value}`)
        return qwenCookies.join('; ')
    } catch {
        return ''
    }
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
