const config = require('../config/index.js')
const DataPersistence = require('./data-persistence')
const TokenManager = require('./token-manager')
const AccountRotator = require('./account-rotator')
const ProxyPool = require('./proxy-pool')
const { getProxyHost } = require('./proxy-helper')
const { logger } = require('./logger')

/**
 * Account Manager
 * Unified management of accounts, tokens, and rotation
 */
class Account {
    constructor() {
        this.dataPersistence = new DataPersistence()
        this.tokenManager = new TokenManager()
        this.accountRotator = new AccountRotator()
        // Smart proxy pool. Stays null when no proxies are configured —
        // request layer treats that as "direct connection" same as before.
        this.proxyPool = null

        this.accountTokens = []
        this.isInitialized = false
        this.initPromise = null

        // Initialize
        this.initPromise = this._initialize()
    }

    /**
     * Async initialization
     * @private
     */
    async _initialize() {
        try {
            // Bring up the proxy pool BEFORE loading accounts. Bindings
            // persist across restarts in file mode, so we want them in
            // place when we attach proxies to account objects below.
            await this._initializeProxyPool()

            await this.loadAccountTokens()

            // Apply the operator-managed disabled list. config.disabledAccounts
            // is the union of DISABLED_ACCOUNTS env + whatever was already
            // persisted on the account row (file/redis preserve the flag).
            // Operator can toggle via POST /api/disableAccount; the helper
            // also pushes the list back to a Vercel env var for persistence
            // on serverless deploys without redis.
            if (Array.isArray(config.disabledAccounts) && config.disabledAccounts.length > 0) {
                const envDisabled = new Set(config.disabledAccounts.map(s => String(s).trim().toLowerCase()))
                for (const acc of this.accountTokens) {
                    if (envDisabled.has(String(acc.email || '').toLowerCase())) {
                        acc.disabled = true
                    }
                }
            }

            // Best-effort: ensure every account has a bound proxy when a
            // pool is configured. Existing bindings are reused; new
            // accounts get one assigned on first use of the pool.
            if (this.proxyPool && this.proxyPool.size() > 0) {
                for (const acc of this.accountTokens) {
                    const bound = this.proxyPool.getProxyForAccount(acc.email)
                    if (bound) {
                        acc.proxy = bound
                    } else {
                        // Defer assignment to first request to avoid
                        // probing all proxies on cold start.
                        acc.proxy = null
                    }
                }
            }

            // Set up periodic token refresh
            if (config.autoRefresh && !config.isServerless) {
                this.refreshInterval = setInterval(
                    () => this.autoRefreshTokens(),
                    (config.autoRefreshInterval || 21600) * 1000
                )
            }

            this.isInitialized = true
            logger.success(`Account manager initialized, loaded ${this.accountTokens.length} accounts`, 'ACCOUNT')
        } catch (error) {
            this.isInitialized = false
            logger.error('Account manager initialization failed', 'ACCOUNT', '', error)
        }
    }

    /**
     * Build the proxy pool from env (config.proxies) merged with file-mode
     * persisted statuses. Persisted-only entries are honored too — the
     * operator may have manually edited data.json. Dedupe is by URL string.
     * @private
     */
    async _initializeProxyPool() {
        try {
            const savedStatuses = await this.dataPersistence.loadProxyStatuses()
            const fileProxies = Object.keys(savedStatuses)
            const merged = [...new Set([...(config.proxies || []), ...fileProxies])]
            if (merged.length === 0) {
                logger.info('No proxy pool configured (PROXIES / PROXY_URL empty)', 'PROXY')
                return
            }
            this.proxyPool = new ProxyPool(this.dataPersistence, merged)
            const savedBindings = await this.dataPersistence.loadProxyBindings()
            // Make sure every URL has a status entry — newcomers default
            // to 'untested' so they're discoverable on first assignProxy.
            const newStatuses = { ...savedStatuses }
            for (const u of merged) {
                if (!newStatuses[u]) newStatuses[u] = 'untested'
            }
            await this.proxyPool.initialize(newStatuses, savedBindings)
            await this.dataPersistence.saveProxyStatuses(newStatuses)
        } catch (error) {
            logger.error('Failed to initialize proxy pool', 'PROXY', '', error)
            this.proxyPool = null
        }
    }

    /**
     * Ensure initialization is complete (for lazy init in serverless)
     */
    async ensureInitialized() {
        if (this.isInitialized) return
        if (this.initPromise) {
            await this.initPromise
        }
    }

    /**
     * Load account token data
     * @returns {Promise<void>}
     */
    async loadAccountTokens() {
        try {
            this.accountTokens = await this.dataPersistence.loadAccounts()

            // For env var mode, login to get tokens
            if (config.dataSaveMode === 'none' && this.accountTokens.length > 0) {
                await this._loginEnvironmentAccounts()
            }

            // Validate and clean invalid tokens
            await this._validateAndCleanTokens()

            // Update account rotator
            this.accountRotator.setAccounts(this.accountTokens)

            logger.success(`Successfully loaded ${this.accountTokens.length} accounts`, 'ACCOUNT')
        } catch (error) {
            logger.error('Failed to load account tokens', 'ACCOUNT', '', error)
            this.accountTokens = []
            this.accountRotator.setAccounts(this.accountTokens)
            throw error
        }
    }

    /**
     * Login environment variable accounts
     * @private
     */
    async _loginEnvironmentAccounts() {
        const concurrency = config.batchLoginConcurrency || 5
        const accounts = this.accountTokens.filter(acc => !acc.token && acc.email && acc.password)

        // Process in batches
        for (let i = 0; i < accounts.length; i += concurrency) {
            const batch = accounts.slice(i, i + concurrency)
            const loginPromises = batch.map(async (account) => {
                const token = await this.tokenManager.login(account.email, account.password)
                if (token) {
                    const decoded = this.tokenManager.validateToken(token)
                    if (decoded) {
                        account.token = token
                        account.expires = decoded.exp
                    }
                }
                return account
            })
            await Promise.all(loginPromises)
        }
    }

    /**
     * Validate tokens and try to recover invalid ones, but ALWAYS keep
     * accounts in the list. A failed login (transient network blip, 5xx,
     * captcha) leaves account.token empty + expires=0; the admin UI can
     * see those entries and trigger /api/refreshAccount to retry. This
     * prevents the account list from silently shrinking on transient
     * errors — the previous behavior dropped failed entries entirely.
     * @private
     */
    async _validateAndCleanTokens() {
        for (const account of this.accountTokens) {
            if (account.token && this.tokenManager.validateToken(account.token)) {
                continue
            }
            if (!account.email || !account.password) {
                // No credentials available — leave as-is so the operator
                // can at least see the orphaned entry and act on it.
                continue
            }
            logger.info(`Token invalid, attempting re-login: ${account.email}`, 'TOKEN')
            const newToken = await this.tokenManager.login(account.email, account.password)
            if (newToken) {
                const decoded = this.tokenManager.validateToken(newToken)
                if (decoded) {
                    account.token = newToken
                    account.expires = decoded.exp
                    delete account.lastLoginError
                    continue
                }
            }
            // Login failed — KEEP the entry but mark token empty so the
            // rotator skips it. Frontend can show "未登录" and call
            // /api/refreshAccount to retry on demand.
            account.token = ''
            account.expires = 0
            account.lastLoginError = Date.now()
        }
    }

    /**
     * Refresh account tokens.
     *
     * Two callers, two intents:
     *   - The internal 6h timer wants to be cheap: only re-login the
     *     accounts whose tokens will expire within `thresholdHours`.
     *     Default 24h. Avoids hammering the upstream signin endpoint
     *     when most tokens are still healthy.
     *   - The "Refresh all" button in the admin UI wants every account
     *     re-logged in, regardless of remaining validity. Operators
     *     hit it specifically to force a known-good state — silently
     *     no-oping because tokens "still have 200h left" was confusing
     *     and looked like a broken button.
     *
     * `force=true` skips the threshold filter and refreshes every
     * account that has both email + password. Disabled accounts are
     * still skipped to honor the operator's intent.
     *
     * @param {number}  thresholdHours - Expiry threshold (hours), ignored when force=true
     * @param {boolean} force          - Refresh all accounts regardless of expiry
     * @returns {Promise<{refreshed:number, total:number}>}
     */
    async autoRefreshTokens(thresholdHours = 24, force = false) {
        if (!this.isInitialized) {
            logger.warn('Account manager not yet initialized, skipping auto-refresh', 'TOKEN')
            return { refreshed: 0, total: 0 }
        }

        logger.info(`Starting token refresh (force=${force}, threshold=${thresholdHours}h)...`, 'TOKEN')

        const candidates = this.accountTokens.filter(a => a.email && a.password && !a.disabled)
        const needsRefresh = force
            ? candidates
            : candidates.filter(account =>
                this.tokenManager.isTokenExpiringSoon(account.token, thresholdHours)
            )

        if (needsRefresh.length === 0) {
            logger.info('No tokens need refreshing', 'TOKEN')
            return { refreshed: 0, total: 0 }
        }

        logger.info(`Refreshing ${needsRefresh.length} account(s)`, 'TOKEN')

        let successCount = 0

        for (const account of needsRefresh) {
            try {
                const updatedAccount = await this.tokenManager.refreshToken(account)
                if (updatedAccount) {
                    const index = this.accountTokens.findIndex(acc => acc.email === account.email)
                    if (index !== -1) {
                        this.accountTokens[index] = updatedAccount
                    }

                    await this.dataPersistence.saveAccount(account.email, {
                        password: updatedAccount.password,
                        token: updatedAccount.token,
                        expires: updatedAccount.expires
                    })

                    this.accountRotator.resetFailures(account.email)
                    successCount++
                } else {
                    this.accountRotator.recordFailure(account.email)
                }
            } catch (error) {
                this.accountRotator.recordFailure(account.email)
                logger.error(`Error refreshing account ${account.email}`, 'TOKEN', '', error)
            }

            await this._delay(1000)
        }

        this.accountRotator.setAccounts(this.accountTokens)
        logger.success(`Token refresh complete: ${successCount}/${needsRefresh.length} succeeded`, 'TOKEN')
        return { refreshed: successCount, total: needsRefresh.length }
    }

    /**
     * Get available account token
     * @returns {string|null} Account token or null
     */
    getAccountToken() {
        if (!this.isInitialized) {
            logger.warn('Account manager not yet initialized', 'ACCOUNT')
            return null
        }

        if (this.accountTokens.length === 0) {
            logger.error('No available account tokens', 'ACCOUNT')
            return null
        }

        const token = this.accountRotator.getNextToken()
        if (!token) {
            logger.error('All account tokens unavailable', 'ACCOUNT')
        }

        return token
    }

    /**
     * Get token by email
     * @param {string} email - Email address
     * @returns {string|null} Account token or null
     */
    getTokenByEmail(email) {
        return this.accountRotator.getTokenByEmail(email)
    }

    /**
     * Generate Markdown table from web search info
     * @param {Array} websites - Website info array
     * @param {string} mode - Mode ('table' or 'text')
     * @returns {Promise<string>} Markdown string
     */
    async generateMarkdownTable(websites, mode) {
        if (!Array.isArray(websites) || websites.length === 0) {
            return ''
        }

        let markdown = ''
        if (mode === 'table') {
            markdown += '| **#** | **URL** | **Source** |\n'
            markdown += '|:---|:---|:---|\n'
        }

        const DEFAULT_TITLE = 'Unknown'
        const DEFAULT_URL = '#'
        const DEFAULT_HOSTNAME = 'Unknown'

        websites.forEach((site, index) => {
            const { title, url, hostname } = site
            const urlCell = `[${title || DEFAULT_TITLE}](${url || DEFAULT_URL})`
            const hostnameCell = hostname || DEFAULT_HOSTNAME
            if (mode === 'table') {
                markdown += `| ${index + 1} | ${urlCell} | ${hostnameCell} |\n`
            } else {
                markdown += `[${index + 1}] ${urlCell} | Source: ${hostnameCell}\n`
            }
        })

        return markdown
    }

    /**
     * Get all account info
     * @returns {Array} Account list
     */
    getAllAccountKeys() {
        return this.accountTokens
    }

    /**
     * Login (delegates to TokenManager)
     * @param {string} email - Email
     * @param {string} password - Password
     * @returns {Promise<string|null>} Token or null
     */
    async login(email, password) {
        return await this.tokenManager.login(email, password)
    }

    /**
     * Add account with existing token
     * @param {string} email - Email
     * @param {string} password - Password
     * @param {string} token - Token
     * @param {number} expires - Expiry timestamp
     * @returns {Promise<boolean>} Whether add was successful
     */
    async addAccountWithToken(email, password, token, expires) {
        try {
            const existingAccount = this.accountTokens.find(acc => acc.email === email)
            if (existingAccount) {
                logger.warn(`Account ${email} already exists`, 'ACCOUNT')
                return false
            }

            const newAccount = { email, password, token, expires }
            this.accountTokens.push(newAccount)

            const saved = await this.dataPersistence.saveAccount(email, newAccount)
            if (!saved && config.dataSaveMode !== 'none') {
                this.accountTokens.pop()
                this.accountRotator.setAccounts(this.accountTokens)
                return false
            }

            this.accountRotator.setAccounts(this.accountTokens)
            logger.success(`Account added: ${email}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`Failed to add account (${email})`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * Refresh single account token
     * @param {string} email - Email address
     * @returns {Promise<boolean>} Whether refresh was successful
     */
    async refreshAccountToken(email) {
        const account = this.accountTokens.find(acc => acc.email === email)
        if (!account) {
            logger.error(`Account not found: ${email}`, 'ACCOUNT')
            return false
        }

        const updatedAccount = await this.tokenManager.refreshToken(account)
        if (updatedAccount) {
            const index = this.accountTokens.findIndex(acc => acc.email === email)
            if (index !== -1) {
                this.accountTokens[index] = updatedAccount
            }

            await this.dataPersistence.saveAccount(email, {
                password: updatedAccount.password,
                token: updatedAccount.token,
                expires: updatedAccount.expires
            })

            this.accountRotator.resetFailures(email)
            return true
        }

        return false
    }

    /**
     * Delete account
     * @param {string} email - Email address
     * @returns {boolean} Whether delete was successful
     */
    deleteAccount(email) {
        const index = this.accountTokens.findIndex(t => t.email === email)
        if (index !== -1) {
            this.accountTokens.splice(index, 1)
            this.accountRotator.setAccounts(this.accountTokens)
            return true
        }
        return false
    }

    /**
     * Toggle the disabled flag on an account. Disabled accounts stay in
     * the list (so the toggle is reversible without losing credentials)
     * but the rotator skips them. Persists the new state to file/redis
     * when those modes are active.
     * @param {string} email
     * @param {boolean} disabled
     * @returns {Promise<boolean>}
     */
    async setAccountDisabled(email, disabled) {
        const account = this.accountTokens.find(t => t.email === email)
        if (!account) return false
        account.disabled = !!disabled
        // Persist for file / redis modes; none mode is in-memory only.
        try {
            await this.dataPersistence.saveAccount(email, {
                password: account.password,
                token: account.token,
                expires: account.expires,
                disabled: !!disabled,
            })
        } catch { /* logged inside */ }
        // Refresh rotator's view so the next pick honors the new flag.
        this.accountRotator.setAccounts(this.accountTokens)
        return true
    }

    /**
     * Snapshot of currently-disabled emails (for env-var sync).
     * @returns {string[]}
     */
    getDisabledEmails() {
        return this.accountTokens.filter(a => a.disabled).map(a => a.email)
    }

    /**
     * Get health statistics
     * @returns {Object} Health stats
     */
    getHealthStats() {
        const tokenStats = this.tokenManager.getTokenHealthStats(this.accountTokens)
        const rotatorStats = this.accountRotator.getStats()

        return {
            accounts: tokenStats,
            rotation: rotatorStats,
            initialized: this.isInitialized
        }
    }

    /**
     * Record account failure
     * @param {string} email - Email address
     */
    recordAccountFailure(email) {
        this.accountRotator.recordFailure(email)
    }

    /**
     * Reset account failures
     * @param {string} email - Email address
     */
    resetAccountFailures(email) {
        this.accountRotator.resetFailures(email)
    }

    /** @private */
    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Cleanup resources
     */
    destroy() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval)
            this.refreshInterval = null
        }
        this.accountRotator.reset()
        logger.info('Account manager resources cleaned up', 'ACCOUNT')
    }

    /**
     * Resolve the proxy decision for an account based on its mode:
     *   - 'none'  → { mode: 'none', proxyUrl: null }            never use a proxy, including legacy single-proxy
     *   - 'fixed' → { mode: 'fixed', proxyUrl: <fixedProxyUrl> } always use this exact proxy (or null if not set)
     *   - 'smart' → { mode: 'smart', proxyUrl: <pool binding> } current behavior; lazily binds if needed
     *
     * Default for accounts without an explicit mode: 'smart', matching
     * pre-feature behavior.
     *
     * Caller (request.js) reads `mode` to decide whether to fall back to
     * the legacy single-proxy (`getProxyAgent()`) on a null proxyUrl —
     * 'smart' with no pool / 'fixed' with no fixedProxyUrl falls through
     * to legacy; 'none' explicitly does not.
     *
     * @param {string} email
     * @returns {Promise<{mode:'smart'|'fixed'|'none', proxyUrl:string|null}>}
     */
    async getProxyDecisionForAccount(email) {
        const acc = this.accountTokens.find(a => a.email === email)
        const mode = (acc && acc.proxyMode) || 'smart'

        if (mode === 'none') {
            return { mode: 'none', proxyUrl: null }
        }

        if (mode === 'fixed') {
            const url = (acc && acc.fixedProxyUrl) || null
            return { mode: 'fixed', proxyUrl: url }
        }

        // 'smart' (default): use the pool's lazy assignment.
        if (!this.proxyPool || this.proxyPool.size() === 0) {
            return { mode: 'smart', proxyUrl: null }
        }
        const bound = this.proxyPool.getProxyForAccount(email)
        if (bound) return { mode: 'smart', proxyUrl: bound }
        const assigned = await this.proxyPool.assignProxy(email)
        if (assigned && acc) acc.proxy = assigned
        return { mode: 'smart', proxyUrl: assigned || null }
    }

    /**
     * Lookup the proxy URL bound to an account, lazily assigning one on
     * first use so cold start doesn't probe every proxy upfront.
     * Returns null when no pool is configured (callers treat as direct).
     *
     * Legacy thin-wrapper around getProxyDecisionForAccount; kept so
     * older callers that don't care about the mode keep working.
     * @param {string} email
     */
    async getProxyForAccount(email) {
        const decision = await this.getProxyDecisionForAccount(email)
        return decision.proxyUrl
    }

    /**
     * Set per-account proxy mode + optional fixed URL. Validates:
     *   - mode ∈ {'smart','fixed','none'}
     *   - mode==='fixed' requires a non-empty proxyUrl that
     *     buildAgentForUrl can parse (otherwise the request layer would
     *     silently fall back to legacy getProxyAgent on every call)
     *   - 'smart'/'none' clear fixedProxyUrl
     *
     * Side-effects:
     *   - Persists the new fields via saveAccount.
     *   - When transitioning OUT of 'smart' (to 'fixed' or 'none') the
     *     existing pool binding is torn down so the email no longer
     *     consumes a slot on a pool member.
     *   - Refreshes the account rotator's snapshot.
     *
     * @param {string} email
     * @param {'smart'|'fixed'|'none'} mode
     * @param {string|null} fixedProxyUrl  required iff mode==='fixed'
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    async setAccountProxy(email, mode, fixedProxyUrl) {
        if (!['smart', 'fixed', 'none'].includes(mode)) {
            return { ok: false, error: 'Invalid mode' }
        }
        const account = this.accountTokens.find(t => t.email === email)
        if (!account) return { ok: false, error: 'Account not found' }

        let url = null
        if (mode === 'fixed') {
            url = (fixedProxyUrl || '').trim()
            if (!url) return { ok: false, error: 'fixed mode requires proxyUrl' }
            // Validate parseable. buildAgentForUrl returns null for
            // unknown schemes / malformed URLs.
            const { buildAgentForUrl: build } = require('./proxy-helper')
            if (!build(url)) return { ok: false, error: 'Unsupported or malformed proxy URL' }
        }

        const wasSmart = (account.proxyMode || 'smart') === 'smart'
        account.proxyMode = mode
        account.fixedProxyUrl = url

        try {
            await this.dataPersistence.saveAccount(email, {
                password: account.password,
                token: account.token,
                expires: account.expires,
                disabled: !!account.disabled,
                proxyMode: mode,
                fixedProxyUrl: url,
            })
        } catch { /* logged inside */ }

        // If we're leaving 'smart' mode, hand back any pool binding so
        // the email doesn't keep consuming a slot on a pool member.
        if (wasSmart && mode !== 'smart' && this.proxyPool) {
            try { await this.proxyPool.removeBinding(email) } catch { /* logged inside */ }
            account.proxy = null
        }

        this.accountRotator.setAccounts(this.accountTokens)
        logger.info(`Account ${email} proxy mode -> ${mode}${url ? ` (${getProxyHost(url)})` : ''}`, 'PROXY')
        return { ok: true }
    }

    /**
     * Mark the current proxy as failed and rebind the account to a new
     * one. Called from request.js when an upstream call dies with a
     * proxy-shaped network error. The pool may re-test the failed entry
     * later — this is not a permanent eviction.
     *
     * Mode-aware:
     *   - 'smart': mark failed + rebind via pool (current behavior)
     *   - 'fixed': mark failed but do NOT rebind — the operator pinned
     *     this proxy on purpose; rotating defeats the intent. Caller
     *     gets null and the next attempt will fail on the same proxy
     *     (which is what surfaces the misconfiguration to the operator).
     *   - 'none': should never reach here (no proxy was used) but be
     *     defensive: just no-op.
     *
     * @param {string} email
     * @param {string} proxyUrl
     */
    async handleNetworkFailure(email, proxyUrl) {
        if (!this.proxyPool) return null
        const acc = this.accountTokens.find(a => a.email === email)
        const mode = (acc && acc.proxyMode) || 'smart'
        if (mode === 'none') return null

        logger.info(`Network failure on ${email} via ${getProxyHost(proxyUrl)} (mode=${mode})`, 'PROXY')
        await this.proxyPool.markProxyAsFailed(proxyUrl)
        if (mode !== 'smart') {
            // Fixed-mode: don't pick a different proxy; the operator's
            // intent is "always this one". Caller will see no fallback
            // and surface the failure.
            return null
        }
        const next = await this.proxyPool.assignProxy(email, true)
        if (next) {
            if (acc) acc.proxy = next
            logger.success(`Re-bound ${email} -> ${getProxyHost(next)}`, 'PROXY')
        } else {
            logger.error(`No fallback proxy available for ${email}`, 'PROXY')
        }
        return next
    }

    /**
     * Snapshot of the proxy pool for the admin UI.
     * @returns {Array}
     */
    getProxyStatus() {
        return this.proxyPool ? this.proxyPool.list() : []
    }

    /**
     * Add a proxy URL to the smart pool. If the pool isn't constructed
     * yet (no PROXIES / PROXY_URL env var, no persisted entries) we
     * lazily create an empty one so the operator can grow the pool from
     * the admin UI on a fresh deploy.
     *
     * Without this lazy path the UI's "Add proxy" form 400s with
     * "Proxy pool not initialized" on every fresh self-hosted deploy
     * — chicken-and-egg, since the only way to seed the pool was env
     * vars.
     *
     * Idempotent: returns false when the URL is already in the pool.
     * @param {string} url
     * @returns {Promise<boolean>}
     */
    async addProxyToPool(url) {
        if (!this.proxyPool) {
            // Empty constructor; persisted statuses are written
            // incrementally by ProxyPool itself as we add. No
            // initialize() call needed — there's nothing to replay.
            this.proxyPool = new ProxyPool(this.dataPersistence, [])
            logger.info('Proxy pool lazily created on first runtime add', 'PROXY')
        }
        return await this.proxyPool.addProxy(url)
    }
}

const accountManager = new Account()

process.on('exit', () => {
    if (accountManager) {
        accountManager.destroy()
    }
})

process.on('SIGINT', () => {
    if (accountManager) {
        accountManager.destroy()
    }
    process.exit(0)
})

module.exports = accountManager
