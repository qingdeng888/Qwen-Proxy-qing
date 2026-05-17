'use strict'

/**
 * UsageTracker — per-API-key and per-Qwen-account request/token counters.
 *
 * Tracks, for each (a) API key the caller authenticated with and
 * (b) Qwen account the proxy used upstream:
 *   - totalRequests      — every observed attempt
 *   - successRequests    — finished with HTTP 200 + completed stream/JSON
 *   - failedRequests     — totalRequests - successRequests on completion
 *   - promptTokens       — sum of usage.prompt_tokens reported by upstream
 *   - completionTokens   — sum of usage.completion_tokens
 *   - lastUsed           — last activity timestamp (ms epoch)
 *
 * Lifecycle of a single client request:
 *   1. recordRequestStart({ apiKey })           — at route entry, +1 totalRequests for the key
 *   2. recordAccountAttempt({ email })          — each retry inside sendChatRequest, +1 totalRequests for that account
 *   3. attachStreamTracker(stream, ctx)         — wraps the upstream SSE so promptTokens / completionTokens are accumulated as they stream by; on stream end calls recordSuccess for both apiKey + email
 *   4. recordFailure({ apiKey, email })         — final failure (no 200, or accumulator catch path)
 *
 * Persistence:
 *   - Counters live in an in-memory map first, are scheduled to flush
 *     every FLUSH_INTERVAL_MS via DataPersistence.saveUsage. Keeps the
 *     hot path off disk/redis and avoids amplifying writes on bursty
 *     traffic. Flushes also happen on graceful shutdown signals when
 *     possible.
 *   - On boot, loadUsage() rehydrates the map.
 *
 * API key normalization:
 *   The middlewares attach req.apiKey including a possible "Bearer "
 *   prefix. We normalize via normalizeApiKey() to the bare key; if the
 *   bare key is empty (auth-disabled / anonymous mode) we bucket under
 *   the special "(anonymous)" id so the dashboard still shows traffic.
 *   Only a hashed/short id is stored as the map key — the full raw key
 *   is never persisted.
 */

const crypto = require('crypto')
const DataPersistence = require('./data-persistence')
const { logger } = require('./logger')
const { createUsageObject } = require('./precise-tokenizer')
const { maskApiKey } = require('./tools')

const FLUSH_INTERVAL_MS = 30 * 1000
const ANON_ID = '(anonymous)'

// Truncate a SHA-256 of the api key — short enough for storage but
// collision-resistant enough at our scale. The full key never touches
// disk; the manager keeps an in-memory id ↔ key map so the admin
// endpoint can render the masked display string.
function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
}

function normalizeApiKey(raw) {
  if (!raw) return ''
  const s = String(raw)
  return s.startsWith('Bearer ') ? s.slice(7).trim() : s.trim()
}

function freshCounters() {
  return {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    lastUsed: 0,
  }
}

class UsageTracker {
  constructor() {
    this.dataPersistence = new DataPersistence()
    // { [keyHash]: counters } — in-memory hot path
    this.apiKeyStats = Object.create(null)
    // { [keyHash]: { keyMasked, raw } } — for display only; raw is kept
    // in process memory so the admin endpoint can dedupe against the
    // current api-key-manager list, but is NEVER persisted.
    this.apiKeyMeta = Object.create(null)
    // { [email]: counters }
    this.accountStats = Object.create(null)

    this._dirty = false
    this._flushTimer = null
    this.initPromise = this._initialize()
  }

  async _initialize() {
    try {
      const persisted = await this.dataPersistence.loadUsage()
      if (persisted && typeof persisted === 'object') {
        if (persisted.apiKeys && typeof persisted.apiKeys === 'object') {
          for (const [id, counters] of Object.entries(persisted.apiKeys)) {
            this.apiKeyStats[id] = this._sanitizeCounters(counters)
          }
        }
        // Migrate legacy storage that may have used masked-key strings
        // as the bucket id (older versions or hand-edited files).
        if (persisted.accounts && typeof persisted.accounts === 'object') {
          for (const [email, counters] of Object.entries(persisted.accounts)) {
            this.accountStats[email] = this._sanitizeCounters(counters)
          }
        }
      }
      this._scheduleFlush()
      logger.success(
        `UsageTracker initialized: ${Object.keys(this.apiKeyStats).length} key bucket(s), ${Object.keys(this.accountStats).length} account bucket(s)`,
        'USAGE'
      )
    } catch (err) {
      logger.error('UsageTracker init failed', 'USAGE', '', err)
    }
  }

  _sanitizeCounters(c) {
    const fresh = freshCounters()
    if (!c || typeof c !== 'object') return fresh
    for (const k of Object.keys(fresh)) {
      const v = Number(c[k])
      fresh[k] = Number.isFinite(v) && v >= 0 ? v : 0
    }
    return fresh
  }

  _scheduleFlush() {
    if (this._flushTimer) return
    this._flushTimer = setInterval(() => {
      if (this._dirty) {
        this.flush().catch(err => logger.error('UsageTracker flush failed', 'USAGE', '', err))
      }
    }, FLUSH_INTERVAL_MS)
    if (this._flushTimer.unref) this._flushTimer.unref()
  }

  /**
   * Flush in-memory counters to persistent storage. Idempotent.
   */
  async flush() {
    if (!this._dirty) return false
    const payload = {
      apiKeys: this.apiKeyStats,
      accounts: this.accountStats,
    }
    const ok = await this.dataPersistence.saveUsage(payload)
    if (ok) this._dirty = false
    return ok
  }

  _markDirty() {
    this._dirty = true
  }

  /* -------------------- bucket id resolution -------------------- */

  _apiKeyId(apiKey) {
    const norm = normalizeApiKey(apiKey)
    if (!norm) return ANON_ID
    const id = hashKey(norm)
    if (!this.apiKeyMeta[id]) {
      this.apiKeyMeta[id] = {
        keyMasked: maskApiKey(norm),
        raw: norm,
      }
    }
    return id
  }

  _ensureApiKeyBucket(id) {
    if (!this.apiKeyStats[id]) this.apiKeyStats[id] = freshCounters()
    return this.apiKeyStats[id]
  }

  _ensureAccountBucket(email) {
    if (!email) return null
    if (!this.accountStats[email]) this.accountStats[email] = freshCounters()
    return this.accountStats[email]
  }

  /* -------------------- recording: external API -------------------- */

  /**
   * Bump totalRequests for the API key bucket. Called once per client
   * request (on route entry, before account selection / retries).
   */
  recordRequestStart({ apiKey } = {}) {
    const id = this._apiKeyId(apiKey)
    const bucket = this._ensureApiKeyBucket(id)
    bucket.totalRequests += 1
    bucket.lastUsed = Date.now()
    this._markDirty()
  }

  /**
   * Bump totalRequests for the Qwen account bucket. Called once per
   * upstream attempt — a single client request that retries 3 accounts
   * will call this 3 times.
   */
  recordAccountAttempt({ email } = {}) {
    const bucket = this._ensureAccountBucket(email)
    if (!bucket) return
    bucket.totalRequests += 1
    bucket.lastUsed = Date.now()
    this._markDirty()
  }

  /**
   * Bump failedRequests for the Qwen account bucket — used by the
   * sendChatRequest retry loop when an upstream attempt errors out.
   * Stream-end success is recorded separately via recordSuccess().
   */
  recordAccountFailure({ email } = {}) {
    const bucket = this._ensureAccountBucket(email)
    if (!bucket) return
    bucket.failedRequests += 1
    bucket.lastUsed = Date.now()
    this._markDirty()
  }

  /**
   * Mark the end-to-end client request a success (the stream / JSON
   * response completed). Increments successRequests for the API key
   * AND for the upstream account that finally answered. Token counts
   * are added in too — passing the realized usage object.
   *
   * @param {{ apiKey, email, usage: { prompt_tokens, completion_tokens } }} ctx
   */
  recordSuccess(ctx) {
    const { apiKey, email, usage } = ctx || {}
    const now = Date.now()
    const promptTokens = usage && Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : 0
    const completionTokens = usage && Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : 0

    const keyId = this._apiKeyId(apiKey)
    const keyBucket = this._ensureApiKeyBucket(keyId)
    keyBucket.successRequests += 1
    keyBucket.promptTokens += promptTokens
    keyBucket.completionTokens += completionTokens
    keyBucket.lastUsed = now

    if (email) {
      const accBucket = this._ensureAccountBucket(email)
      if (accBucket) {
        accBucket.successRequests += 1
        accBucket.promptTokens += promptTokens
        accBucket.completionTokens += completionTokens
        accBucket.lastUsed = now
      }
    }
    this._markDirty()
  }

  /**
   * Mark the end-to-end client request a failure. Increments
   * failedRequests for the API key bucket; account-level failure is
   * recorded separately by recordAccountFailure during the retry loop.
   */
  recordFailure(ctx) {
    const { apiKey } = ctx || {}
    const keyId = this._apiKeyId(apiKey)
    const keyBucket = this._ensureApiKeyBucket(keyId)
    keyBucket.failedRequests += 1
    keyBucket.lastUsed = Date.now()
    this._markDirty()
  }

  /**
   * Wrap an upstream SSE stream so prompt_tokens / completion_tokens
   * are observed as they fly past, and recordSuccess / recordFailure
   * is called at the right time. We do NOT consume the stream — we
   * attach passive listeners. The downstream handler is still the
   * primary consumer; we just sniff alongside it.
   *
   * Two fallbacks for token counting, mirroring what the chat controller
   * already does for the user-facing `usage` chunk:
   *   1. If upstream Qwen sends a `usage` field in any SSE chunk, we
   *      take the latest snapshot.
   *   2. If upstream never sends `usage` (the common case for Qwen —
   *      that's why chat.js controller has its own createUsageObject
   *      fallback), we estimate from the original promptMessages and
   *      the accumulated answer text observed in `delta.content`.
   *
   * Returns the same stream for fluent chaining.
   *
   * @param {NodeJS.ReadableStream} stream — upstream SSE response
   * @param {{ apiKey, email, promptMessages? }} ctx
   *        promptMessages is the original OpenAI-format messages array
   *        (or string). Without it the prompt-side fallback estimate
   *        is 0; the response-side fallback still works either way.
   */
  attachStreamTracker(stream, ctx) {
    if (!stream || typeof stream.on !== 'function') return stream
    const tracker = this
    const decoder = new (require('util').TextDecoder)('utf-8')
    let buffer = ''
    let lastUsage = null
    // Accumulate the answer text we observe so we can estimate
    // completion_tokens when upstream doesn't ship a usage chunk.
    // We sniff `delta.content` (the answer phase) and
    // `delta.reasoning_content` (the thinking phase, when the user
    // enabled it via the -thinking suffix). Both contribute to the
    // upstream-reported completion_tokens in the controller's
    // estimator, so we count them the same way here.
    let completionText = ''
    let finished = false

    const onData = (chunk) => {
      try {
        buffer += decoder.decode(chunk, { stream: true })
        // SSE messages are separated by blank lines; scan only
        // complete `data: ...` events.
        const parts = buffer.split('\n')
        buffer = parts.pop() || ''
        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            if (parsed && parsed.usage) {
              // Upstream emits cumulative counters in the final usage
              // chunk. Keep the latest snapshot rather than summing.
              lastUsage = {
                prompt_tokens: Number(parsed.usage.prompt_tokens) || 0,
                completion_tokens: Number(parsed.usage.completion_tokens) || 0,
              }
            }
            // Sniff the visible response content for the fallback
            // estimator. Qwen wraps answer text under
            // choices[0].delta.content with phase='answer'; thinking
            // text shows up under .reasoning_content (when enabled)
            // OR under .content with phase='think'. Either way,
            // .content + .reasoning_content captures everything.
            const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta
            if (delta) {
              if (typeof delta.content === 'string') completionText += delta.content
              if (typeof delta.reasoning_content === 'string') completionText += delta.reasoning_content
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* defensive: never crash the stream */ }
    }

    const finalize = (ok) => {
      if (finished) return
      finished = true
      try {
        if (ok) {
          // Resolve usage with the same precedence the chat controller
          // uses for the response it sends back to the client:
          //   real upstream usage  >  estimated from text
          let resolvedUsage = lastUsage
          if (!resolvedUsage || (!resolvedUsage.prompt_tokens && !resolvedUsage.completion_tokens)) {
            try {
              const estimated = createUsageObject(
                ctx && ctx.promptMessages ? ctx.promptMessages : '',
                completionText,
                null
              )
              resolvedUsage = {
                prompt_tokens: estimated.prompt_tokens || 0,
                completion_tokens: estimated.completion_tokens || 0,
              }
            } catch {
              resolvedUsage = { prompt_tokens: 0, completion_tokens: 0 }
            }
          }
          tracker.recordSuccess({
            apiKey: ctx && ctx.apiKey,
            email: ctx && ctx.email,
            usage: resolvedUsage,
          })
        } else {
          tracker.recordFailure({ apiKey: ctx && ctx.apiKey })
          if (ctx && ctx.email) tracker.recordAccountFailure({ email: ctx.email })
        }
      } catch (err) {
        logger.error('UsageTracker finalize failed', 'USAGE', '', err)
      }
    }

    stream.on('data', onData)
    stream.on('end', () => finalize(true))
    stream.on('error', () => finalize(false))
    stream.on('close', () => {
      // 'close' may fire before 'end' on aborted client connections —
      // treat that as a partial success: the upstream stream fully
      // delivered up to whatever we already captured. If end already
      // fired we've already finalized. If error fired we marked failure.
      if (!finished) finalize(true)
    })

    return stream
  }

  /* -------------------- read API for admin -------------------- */

  /**
   * Build the admin-friendly snapshot of all buckets. Joins api-key-id
   * buckets with the live api-key-manager list so each row gets a
   * readable masked-key label, and surfaces any orphan buckets (keys
   * that have been deleted since but still have stats) so they're not
   * silently lost.
   *
   * @param {Array<{key:string,keyMasked:string,source:string,isAdmin:boolean}>} [knownKeys]
   *        Output of apiKeyManager.list() — passed in to keep this
   *        module decoupled from api-key-manager.
   */
  snapshot(knownKeys = []) {
    // Map from id → preferred label sourced from the live key list.
    const idToLabel = Object.create(null)
    for (const item of knownKeys) {
      if (!item || !item.key) continue
      idToLabel[hashKey(item.key)] = {
        keyMasked: item.keyMasked || maskApiKey(item.key),
        source: item.source,
        isAdmin: !!item.isAdmin,
      }
    }

    const apiKeys = []
    for (const [id, counters] of Object.entries(this.apiKeyStats)) {
      let label = null
      if (id === ANON_ID) {
        label = { keyMasked: '(无鉴权)', source: 'anonymous', isAdmin: false }
      } else if (idToLabel[id]) {
        label = idToLabel[id]
      } else if (this.apiKeyMeta[id]) {
        // Bucket exists for a key we've seen this process but isn't in
        // the manager (e.g. a runtime key created earlier and deleted).
        label = { keyMasked: this.apiKeyMeta[id].keyMasked, source: 'orphan', isAdmin: false }
      } else {
        label = { keyMasked: `(已删除 ${id.slice(0, 6)}…)`, source: 'orphan', isAdmin: false }
      }
      apiKeys.push({ id, ...label, ...counters })
    }
    // Sort: admin first, then anonymous, then by totalRequests desc
    apiKeys.sort((a, b) => {
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1
      if ((a.source === 'anonymous') !== (b.source === 'anonymous')) return a.source === 'anonymous' ? 1 : -1
      return (b.totalRequests || 0) - (a.totalRequests || 0)
    })

    const accounts = Object.entries(this.accountStats)
      .map(([email, counters]) => ({ email, ...counters }))
      .sort((a, b) => (b.totalRequests || 0) - (a.totalRequests || 0))

    return { apiKeys, accounts }
  }

  /* -------------------- mutation API for admin -------------------- */

  /**
   * Reset stats. Scope:
   *   - 'all'      — wipe everything
   *   - 'apikey'   — reset one API key bucket (by id from snapshot, OR by raw key)
   *   - 'account'  — reset one account bucket (by email)
   */
  async reset({ scope = 'all', id = null, email = null, apiKey = null } = {}) {
    if (scope === 'all') {
      this.apiKeyStats = Object.create(null)
      this.accountStats = Object.create(null)
    } else if (scope === 'apikey') {
      let target = id
      if (!target && apiKey) target = this._apiKeyId(apiKey)
      if (target && this.apiKeyStats[target]) {
        delete this.apiKeyStats[target]
      }
    } else if (scope === 'account') {
      if (email && this.accountStats[email]) {
        delete this.accountStats[email]
      }
    } else {
      throw new Error('Unknown reset scope: ' + scope)
    }
    this._markDirty()
    await this.flush()
    return true
  }
}

const usageTracker = new UsageTracker()
module.exports = usageTracker
