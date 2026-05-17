'use strict'

/**
 * API Key Manager
 *
 * Owns the runtime-mutable API key list. The first key from API_KEY env
 * var is treated as the immutable admin / master key (its presence is
 * what gates the admin endpoints, including this manager itself), so it
 * cannot be deleted via the API. Any additional env keys are merged in
 * read-only too. Keys added via the Admin UI live alongside them and
 * are persisted via DataPersistence (file or redis backend).
 *
 * config.apiKeys is mutated in place so existing middleware
 * (apiKeyVerify / adminKeyVerify) just keeps working — no need to chase
 * down every usage and switch to a getter.
 */

const crypto = require('crypto')
const config = require('../config/index.js')
const DataPersistence = require('./data-persistence')
const { logger } = require('./logger')

class ApiKeyManager {
  constructor() {
    this.dataPersistence = new DataPersistence()
    // Snapshot of keys defined via the API_KEY env var. These are
    // considered "managed by the operator outside the UI" — listed as
    // read-only and not deletable. The first entry is the admin key.
    this.envKeys = [...(config.apiKeys || [])]
    this.adminKey = config.adminKey || null
    // Keys added via the UI; persisted.
    this.runtimeKeys = []
    this.initPromise = this._initialize()
  }

  async _initialize() {
    try {
      const persisted = await this.dataPersistence.loadApiKeys()
      this.runtimeKeys = Array.isArray(persisted) ? persisted.filter(Boolean) : []
      this._syncToConfig()
      logger.success(
        `ApiKeyManager initialized: ${this.envKeys.length} env key(s), ${this.runtimeKeys.length} runtime key(s)`,
        'APIKEY'
      )
    } catch (err) {
      logger.error('ApiKeyManager init failed', 'APIKEY', '', err)
    }
  }

  /**
   * Merge env + runtime keys into config.apiKeys (deduped, env first so
   * admin key stays at index 0). The middleware reads config.apiKeys
   * directly, so this is what makes new keys actually accepted.
   */
  _syncToConfig() {
    const seen = new Set()
    const merged = []
    for (const k of [...this.envKeys, ...this.runtimeKeys]) {
      if (!k || seen.has(k)) continue
      seen.add(k)
      merged.push(k)
    }
    config.apiKeys = merged
    // adminKey is always the first env key (or null if none configured).
    // We deliberately don't recompute it from runtimeKeys.
    config.adminKey = this.envKeys.length > 0 ? this.envKeys[0] : null
    this.adminKey = config.adminKey
  }

  /**
   * Snapshot for the admin UI. `source: 'env'` keys come from API_KEY
   * env (read-only); `source: 'runtime'` keys are user-added.
   */
  list() {
    const out = []
    for (const k of this.envKeys) {
      out.push({
        key: k,
        source: 'env',
        isAdmin: k === this.adminKey,
        deletable: false,
      })
    }
    for (const k of this.runtimeKeys) {
      // If somehow the env list also contains this key, skip — env wins.
      if (this.envKeys.includes(k)) continue
      out.push({
        key: k,
        source: 'runtime',
        isAdmin: false,
        deletable: true,
      })
    }
    return out
  }

  /**
   * Add a new runtime key. If `key` is empty, auto-generate one with a
   * `sk-` prefix. Returns the added key string or throws on conflict.
   */
  async addKey(key) {
    let value = (key || '').trim()
    if (!value) {
      value = 'sk-' + crypto.randomBytes(24).toString('hex')
    }
    if (value.length < 8) {
      throw new Error('API key must be at least 8 characters')
    }
    if (this.envKeys.includes(value) || this.runtimeKeys.includes(value)) {
      throw new Error('API key already exists')
    }
    this.runtimeKeys.push(value)
    this._syncToConfig()
    await this.dataPersistence.saveApiKeys(this.runtimeKeys)
    logger.info(`Added runtime API key (now ${this.runtimeKeys.length} runtime keys)`, 'APIKEY')
    return value
  }

  /**
   * Remove a runtime key. Refuses to remove env-managed keys (including
   * the admin key) — operator must edit API_KEY env var to remove those.
   */
  async removeKey(key) {
    const value = (key || '').trim()
    if (!value) {
      throw new Error('Missing key')
    }
    if (this.envKeys.includes(value)) {
      throw new Error('Cannot delete env-managed key. Edit API_KEY env var instead.')
    }
    const idx = this.runtimeKeys.indexOf(value)
    if (idx === -1) {
      throw new Error('Key not found')
    }
    this.runtimeKeys.splice(idx, 1)
    this._syncToConfig()
    await this.dataPersistence.saveApiKeys(this.runtimeKeys)
    logger.info(`Removed runtime API key (now ${this.runtimeKeys.length} runtime keys)`, 'APIKEY')
    return true
  }

  /**
   * Get the runtime keys for env-sync purposes. Used by vercel-sync to
   * push the combined list back to the Vercel API_KEY env var so the
   * keys survive cold starts.
   */
  getAllKeys() {
    // Returns env keys first (admin remains index 0), then runtime keys.
    // This is the same ordering used in _syncToConfig.
    const seen = new Set()
    const out = []
    for (const k of [...this.envKeys, ...this.runtimeKeys]) {
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(k)
    }
    return out
  }
}

// Singleton — one manager shared across routes/middleware.
const apiKeyManager = new ApiKeyManager()
module.exports = apiKeyManager
