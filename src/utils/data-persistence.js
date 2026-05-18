const fs = require('fs').promises
const path = require('path')
const config = require('../config/index.js')
const { logger } = require('./logger')
const redisClient = require('./redis-client.js')

// Single key holding all persisted state in redis mode. Schema mirrors
// the file-mode data.json:
//   { accounts: [...], proxyBindings: {...}, proxyStatuses: {...} }
const REDIS_KEY = 'qwen2api:data'

/**
 * Data Persistence Manager
 * Handles account + smart-proxy storage. Three backends:
 *   - none  : env vars only (no persistence)
 *   - file  : data/data.json (best for self-host / Docker)
 *   - redis : Upstash Redis REST (best for Vercel / serverless — local
 *             disk doesn't survive cold starts there)
 */
class DataPersistence {
  constructor() {
    this.dataFilePath = path.join(__dirname, '../../data/data.json')

    // Loud warning when the configured mode is incompatible with the
    // runtime: serverless containers don't have persistent disk, so a
    // file-mode deploy on Vercel silently loses every refresh on cold
    // start. Suggest redis mode in that case.
    if (config.isServerless && config.dataSaveMode === 'file') {
      logger.warn('DATA_SAVE_MODE=file on a serverless platform — data will not persist across cold starts. Switch to DATA_SAVE_MODE=redis with Upstash for persistence.', 'DATA')
    }
    if (config.dataSaveMode === 'redis' && !redisClient.isConfigured()) {
      logger.warn('DATA_SAVE_MODE=redis but no Redis credentials found (set REDIS_URL+REDIS_TOKEN, or KV_REST_API_*, or UPSTASH_REDIS_REST_*) — falling back to in-memory.', 'DATA')
    }
    // Loud warning for the most common self-host misconfig: running on
    // a long-lived host (Docker / VPS / bare metal) with a /app/data
    // volume mounted, but DATA_SAVE_MODE left at the env-default
    // "none". Every saveAccount/saveProxy/etc returns false silently
    // and the operator wonders why data.json is empty after restart.
    if (config.dataSaveMode === 'none' && !config.isServerless) {
      logger.warn('DATA_SAVE_MODE=none on a non-serverless host — accounts, proxies, runtime API keys, and usage stats will all reset on restart. Set DATA_SAVE_MODE=file (and mount a volume for ./data) to persist them.', 'DATA')
    }
  }

  /**
   * Load all account data
   * @returns {Promise<Array>} Account list
   */
  async loadAccounts() {
    try {
      switch (config.dataSaveMode) {
        case 'file':
          return await this._loadFromFile()
        case 'redis':
          return await this._loadAccountsFromRedis()
        case 'none':
        default:
          return await this._loadFromEnv()
      }
    } catch (error) {
      logger.error('Failed to load account data', 'DATA', '', error)
      throw error
    }
  }

  /**
   * Save single account data
   * @param {string} email - Email
   * @param {Object} accountData - Account data
   * @returns {Promise<boolean>} Whether save was successful
   */
  async saveAccount(email, accountData) {
    try {
      switch (config.dataSaveMode) {
        case 'file':
          return await this._saveToFile(email, accountData)
        case 'redis':
          return await this._saveAccountToRedis(email, accountData)
        case 'none':
        default:
          // Environment variable mode does not support saving
          return false
      }
    } catch (error) {
      logger.error(`Failed to save account data (${email})`, 'DATA', '', error)
      return false
    }
  }

  /**
   * Batch save account data
   * @param {Array} accounts - Account list
   * @returns {Promise<boolean>} Whether save was successful
   */
  async saveAllAccounts(accounts) {
    try {
      switch (config.dataSaveMode) {
        case 'file':
          return await this._saveAllToFile(accounts)
        case 'redis':
          return await this._saveAllAccountsToRedis(accounts)
        case 'none':
        default:
          return false
      }
    } catch (error) {
      logger.error('Failed to batch save account data', 'DATA', '', error)
      return false
    }
  }

  /**
   * Load from file
   * @private
   */
  async _loadFromFile() {
    await this._ensureDataFileExists()

    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)

    return data.accounts || []
  }

  /**
   * Load from environment variables
   * @private
   */
  async _loadFromEnv() {
    if (!process.env.ACCOUNTS) {
      return []
    }

    const accountTokens = process.env.ACCOUNTS.split(',')
    const accounts = []

    for (const item of accountTokens) {
      const separatorIndex = item.indexOf(':')
      if (separatorIndex === -1) continue

      const email = item.slice(0, separatorIndex).trim()
      const password = item.slice(separatorIndex + 1).trim()

      if (email && password) {
        accounts.push({ email, password, token: null, expires: null })
      }
    }

    return accounts
  }

  /**
   * Save to file
   * @private
   */
  async _saveToFile(email, accountData) {
    await this._ensureDataFileExists()

    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)

    if (!data.accounts) {
      data.accounts = []
    }

    const existingIndex = data.accounts.findIndex(account => account.email === email)
    const updatedAccount = {
      email,
      password: accountData.password,
      token: accountData.token,
      expires: accountData.expires,
      // Preserve disabled flag across saves so single-account writes
      // don't clobber the operator's toggle.
      disabled: accountData.disabled === undefined
        ? (existingIndex !== -1 ? !!data.accounts[existingIndex].disabled : false)
        : !!accountData.disabled,
      // Per-account proxy mode: 'smart' (pool, default) | 'fixed' (always
      // use fixedProxyUrl) | 'none' (always go direct, ignore pool).
      // Same preserve-on-undefined rule as `disabled`.
      proxyMode: accountData.proxyMode === undefined
        ? (existingIndex !== -1 ? (data.accounts[existingIndex].proxyMode || 'smart') : 'smart')
        : (accountData.proxyMode || 'smart'),
      fixedProxyUrl: accountData.fixedProxyUrl === undefined
        ? (existingIndex !== -1 ? (data.accounts[existingIndex].fixedProxyUrl || null) : null)
        : (accountData.fixedProxyUrl || null),
    }

    if (existingIndex !== -1) {
      data.accounts[existingIndex] = updatedAccount
    } else {
      data.accounts.push(updatedAccount)
    }

    await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
    return true
  }

  /**
   * Batch save to file
   * @private
   */
  async _saveAllToFile(accounts) {
    await this._ensureDataFileExists()

    const data = {
      accounts: accounts.map(account => ({
        email: account.email,
        password: account.password,
        token: account.token,
        expires: account.expires,
        disabled: !!account.disabled,
        proxyMode: account.proxyMode || 'smart',
        fixedProxyUrl: account.fixedProxyUrl || null,
      }))
    }

    await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
    return true
  }

  /* -------------------- redis backend -------------------- */
  // The redis blob is one JSON document under REDIS_KEY containing
  // { accounts, proxyBindings, proxyStatuses }. Each save reads, mutates,
  // and rewrites the whole blob — fine for our scale (handful of
  // accounts + handful of proxies). For larger pools, switch to
  // HSET-shaped keys.

  async _readRedisBlob() {
    const data = await redisClient.getJSON(REDIS_KEY)
    if (!data || typeof data !== 'object') {
      return { accounts: [], proxyBindings: {}, proxyStatuses: {} }
    }
    if (!Array.isArray(data.accounts)) data.accounts = []
    if (!data.proxyBindings || typeof data.proxyBindings !== 'object') data.proxyBindings = {}
    if (!data.proxyStatuses || typeof data.proxyStatuses !== 'object') data.proxyStatuses = {}
    if (!data.usage || typeof data.usage !== 'object') data.usage = {}
    return data
  }

  async _writeRedisBlob(data) {
    return redisClient.setJSON(REDIS_KEY, data)
  }

  async _loadAccountsFromRedis() {
    // First-run on a fresh redis: seed with ACCOUNTS env so the operator
    // doesn't have to manually populate it. Subsequent runs honor what's
    // in redis (which may include refreshed tokens).
    const blob = await this._readRedisBlob()
    if (blob.accounts.length === 0) {
      const seeded = await this._loadFromEnv()
      if (seeded.length > 0) {
        blob.accounts = seeded
        await this._writeRedisBlob(blob)
      }
    }
    return blob.accounts
  }

  async _saveAccountToRedis(email, accountData) {
    const blob = await this._readRedisBlob()
    const idx = blob.accounts.findIndex(a => a.email === email)
    const prev = idx >= 0 ? blob.accounts[idx] : null
    const updated = {
      email,
      password: accountData.password,
      token: accountData.token,
      expires: accountData.expires,
      disabled: accountData.disabled === undefined
        ? !!(prev && prev.disabled)
        : !!accountData.disabled,
      proxyMode: accountData.proxyMode === undefined
        ? ((prev && prev.proxyMode) || 'smart')
        : (accountData.proxyMode || 'smart'),
      fixedProxyUrl: accountData.fixedProxyUrl === undefined
        ? ((prev && prev.fixedProxyUrl) || null)
        : (accountData.fixedProxyUrl || null),
    }
    if (idx >= 0) blob.accounts[idx] = updated
    else blob.accounts.push(updated)
    return this._writeRedisBlob(blob)
  }

  async _saveAllAccountsToRedis(accounts) {
    const blob = await this._readRedisBlob()
    blob.accounts = accounts.map(a => ({
      email: a.email,
      password: a.password,
      token: a.token,
      expires: a.expires,
      disabled: !!a.disabled,
      proxyMode: a.proxyMode || 'smart',
      fixedProxyUrl: a.fixedProxyUrl || null,
    }))
    return this._writeRedisBlob(blob)
  }

  /**
   * Ensure data file exists
   * @private
   */
  async _ensureDataFileExists() {
    try {
      await fs.access(this.dataFilePath)
    } catch (error) {
      logger.info('Data file does not exist, creating default...', 'FILE')

      const dirPath = path.dirname(this.dataFilePath)
      await fs.mkdir(dirPath, { recursive: true })

      const defaultData = { accounts: [], proxyBindings: {}, proxyStatuses: {} }
      await fs.writeFile(this.dataFilePath, JSON.stringify(defaultData, null, 2), 'utf-8')
      logger.success('Default data file created', 'FILE')
    }
  }

  /* -------------------- proxy persistence -------------------- */
  // proxyBindings: { [email]: proxyUrl } — which proxy is glued to which account
  // proxyStatuses: { [proxyUrl]: 'untested'|'available'|'failed' } — last-known
  // health of each proxy. Persisted in file or redis modes; ephemeral in none.

  async loadProxyBindings() {
    if (config.dataSaveMode === 'file') {
      try {
        await this._ensureDataFileExists()
        const data = JSON.parse(await fs.readFile(this.dataFilePath, 'utf-8'))
        return data.proxyBindings || {}
      } catch (error) {
        logger.error('Failed to load proxy bindings', 'DATA', '', error)
        return {}
      }
    }
    if (config.dataSaveMode === 'redis') {
      const blob = await this._readRedisBlob()
      return blob.proxyBindings || {}
    }
    return {}
  }

  async saveProxyBinding(email, proxyUrl) {
    if (config.dataSaveMode === 'file') {
      try {
        await this._ensureDataFileExists()
        const data = JSON.parse(await fs.readFile(this.dataFilePath, 'utf-8'))
        if (!data.proxyBindings) data.proxyBindings = {}
        if (proxyUrl == null) delete data.proxyBindings[email]
        else data.proxyBindings[email] = proxyUrl
        await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
        return true
      } catch (error) {
        logger.error(`Failed to save proxy binding (${email})`, 'DATA', '', error)
        return false
      }
    }
    if (config.dataSaveMode === 'redis') {
      const blob = await this._readRedisBlob()
      if (!blob.proxyBindings) blob.proxyBindings = {}
      if (proxyUrl == null) delete blob.proxyBindings[email]
      else blob.proxyBindings[email] = proxyUrl
      return this._writeRedisBlob(blob)
    }
    return false
  }

  async loadProxyStatuses() {
    if (config.dataSaveMode === 'file') {
      try {
        await this._ensureDataFileExists()
        const data = JSON.parse(await fs.readFile(this.dataFilePath, 'utf-8'))
        return data.proxyStatuses || {}
      } catch (error) {
        logger.error('Failed to load proxy statuses', 'DATA', '', error)
        return {}
      }
    }
    if (config.dataSaveMode === 'redis') {
      const blob = await this._readRedisBlob()
      return blob.proxyStatuses || {}
    }
    return {}
  }

  async saveProxyStatuses(statuses) {
    if (config.dataSaveMode === 'file') {
      try {
        await this._ensureDataFileExists()
        const data = JSON.parse(await fs.readFile(this.dataFilePath, 'utf-8'))
        data.proxyStatuses = statuses || {}
        await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
        return true
      } catch (error) {
        logger.error('Failed to save proxy statuses', 'DATA', '', error)
        return false
      }
    }
    if (config.dataSaveMode === 'redis') {
      const blob = await this._readRedisBlob()
      blob.proxyStatuses = statuses || {}
      return this._writeRedisBlob(blob)
    }
    return false
  }

  /* -------------------- api keys persistence -------------------- */
  // apiKeys persists the list of runtime-managed API keys (excluding the
  // admin/master key from API_KEY env var, which is always treated as
  // immutable). Stored as a flat string array.

  async loadApiKeys() {
    if (config.dataSaveMode === 'file') {
      try {
        await this._ensureDataFileExists()
        const data = JSON.parse(await fs.readFile(this.dataFilePath, 'utf-8'))
        return Array.isArray(data.apiKeys) ? data.apiKeys : []
      } catch (error) {
        logger.error('Failed to load api keys', 'DATA', '', error)
        return []
      }
    }
    if (config.dataSaveMode === 'redis') {
      const blob = await this._readRedisBlob()
      return Array.isArray(blob.apiKeys) ? blob.apiKeys : []
    }
    return []
  }

  async saveApiKeys(keys) {
    const list = Array.isArray(keys) ? [...new Set(keys.filter(Boolean))] : []
    if (config.dataSaveMode === 'file') {
      try {
        await this._ensureDataFileExists()
        const data = JSON.parse(await fs.readFile(this.dataFilePath, 'utf-8'))
        data.apiKeys = list
        await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
        return true
      } catch (error) {
        logger.error('Failed to save api keys', 'DATA', '', error)
        return false
      }
    }
    if (config.dataSaveMode === 'redis') {
      const blob = await this._readRedisBlob()
      blob.apiKeys = list
      return this._writeRedisBlob(blob)
    }
    return false
  }

  /* -------------------- usage stats persistence -------------------- */
  // The usage slice is one object: { apiKeys: { [keyHash]: counters },
  //                                   accounts: { [email]: counters } }
  // Counters: { totalRequests, successRequests, failedRequests,
  //             promptTokens, completionTokens, lastUsed }
  // The whole blob is loaded once at boot and saved with debounced writes
  // by UsageTracker — DataPersistence just owns the read/write primitives.

  async loadUsage() {
    if (config.dataSaveMode === 'file') {
      try {
        await this._ensureDataFileExists()
        const data = JSON.parse(await fs.readFile(this.dataFilePath, 'utf-8'))
        return (data.usage && typeof data.usage === 'object') ? data.usage : {}
      } catch (error) {
        logger.error('Failed to load usage stats', 'DATA', '', error)
        return {}
      }
    }
    if (config.dataSaveMode === 'redis') {
      const blob = await this._readRedisBlob()
      return (blob.usage && typeof blob.usage === 'object') ? blob.usage : {}
    }
    return {}
  }

  async saveUsage(usage) {
    const obj = (usage && typeof usage === 'object') ? usage : {}
    if (config.dataSaveMode === 'file') {
      try {
        await this._ensureDataFileExists()
        const data = JSON.parse(await fs.readFile(this.dataFilePath, 'utf-8'))
        data.usage = obj
        await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
        return true
      } catch (error) {
        logger.error('Failed to save usage stats', 'DATA', '', error)
        return false
      }
    }
    if (config.dataSaveMode === 'redis') {
      const blob = await this._readRedisBlob()
      blob.usage = obj
      return this._writeRedisBlob(blob)
    }
    return false
  }
}

module.exports = DataPersistence
