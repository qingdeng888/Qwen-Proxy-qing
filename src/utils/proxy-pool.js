'use strict'

const axios = require('axios')
const { logger } = require('./logger')
const { buildAgentForUrl, getProxyHost, getChatBaseUrl } = require('./proxy-helper')

/**
 * Smart proxy pool — port of the old branch's ProxyManager
 * (https://github.com/Git-think/Qwen-Proxy/tree/old).
 *
 * Responsibilities:
 *   - hold a deduped pool of proxy URLs (any of socks5/socks4/http/https)
 *   - per-proxy health: 'untested' | 'available' | 'failed'
 *   - per-account binding so each account stays on a stable IP
 *   - four-tier assignProxy priority:
 *        P1 verified-available + unused (exclusive)
 *        P2 untested (probe, possibly promote)
 *        P3 failed (re-probe, possibly recover)
 *        P4 verified-available + shared (least-loaded first)
 *   - persistence of statuses + bindings via the supplied DataPersistence
 *     instance (no-op on file-mode-disabled / serverless)
 *   - markProxyAsFailed: record-and-persist for the request layer
 *
 * The pool does NOT itself re-test proxies on a timer; failed proxies are
 * only re-tried lazily on the next assignProxy call that lands on them.
 */
class ProxyPool {
  constructor(dataPersistence, initialProxies = []) {
    /** @type {Map<string, {url:string, status:string, assignedAccounts:Set<string>}>} */
    this.proxies = new Map()
    /** @type {Map<string, string>} email -> proxyUrl */
    this.proxyAssignment = new Map()
    this.dataPersistence = dataPersistence

    for (const url of initialProxies) {
      if (!url || this.proxies.has(url)) continue
      this.proxies.set(url, { url, status: 'untested', assignedAccounts: new Set() })
    }
  }

  size() { return this.proxies.size }

  /**
   * Replay persisted statuses + bindings into the in-memory state.
   */
  async initialize(savedStatuses = {}, savedBindings = {}) {
    for (const [url, status] of Object.entries(savedStatuses)) {
      const p = this.proxies.get(url)
      if (p && ['untested', 'available', 'failed'].includes(status)) {
        p.status = status
      }
    }
    for (const [email, url] of Object.entries(savedBindings)) {
      const p = this.proxies.get(url)
      if (p) {
        this.proxyAssignment.set(email, url)
        p.assignedAccounts.add(email)
      }
    }
    logger.success(`Proxy pool initialized with ${this.proxies.size} entries`, 'PROXY')
  }

  /**
   * Probe a proxy through one of two target ladders, recording latency
   * and updating the cached `entry.status` field. Public surface used
   * by both internal selection (`assignProxy`) and the admin
   * `/api/proxy/test` endpoint.
   *
   *   target: 'generic' (default) — gstatic /generate_204 then cloudflare /trace.
   *           Cheap probes that just answer "can the proxy reach the
   *           internet?". Used during selection to avoid burdening Qwen.
   *   target: 'qwen'              — Qwen base URL (config.qwenChatProxyUrl).
   *           Used by the admin "test now" button so the operator sees
   *           "can this proxy reach the actual destination?". Any HTTP
   *           response (including 4xx) counts as success: TCP+TLS landed,
   *           which is the only thing the proxy is responsible for.
   *
   * Returns: { ok: boolean, status: 'available'|'failed', latencyMs: number, error?: string }
   * Side effects (always): writes entry.status, calls _persistStatuses.
   */
  async testProxy(url, { target = 'generic' } = {}) {
    const entry = this.proxies.get(url)
    if (!entry) return { ok: false, status: 'failed', latencyMs: 0, error: 'unknown_proxy' }
    const agent = buildAgentForUrl(url)
    if (!agent) {
      entry.status = 'failed'
      await this._persistStatuses()
      return { ok: false, status: 'failed', latencyMs: 0, error: 'invalid_url' }
    }

    const probes = target === 'qwen'
      ? [
          // Any 2xx/3xx/4xx means the proxy successfully tunneled the
          // request to Qwen. 5xx and network-level errors indicate the
          // proxy itself failed to deliver. validateStatus accepts the
          // wide range so we don't false-fail on Qwen's auth challenges.
          { url: getChatBaseUrl(), expect: 'any_lt_500' },
        ]
      : [
          { url: 'https://www.gstatic.com/generate_204', expect: [204] },
          { url: 'https://www.cloudflare.com/cdn-cgi/trace', expect: [200] },
        ]

    let lastError = ''
    for (const probe of probes) {
      const t0 = Date.now()
      try {
        const validateStatus = probe.expect === 'any_lt_500'
          ? (s) => s >= 200 && s < 500
          : (s) => probe.expect.includes(s)
        const res = await axios.get(probe.url, {
          httpAgent: agent,
          httpsAgent: agent,
          proxy: false,
          timeout: 8000,
          validateStatus,
        })
        const latencyMs = Date.now() - t0
        if (validateStatus(res.status)) {
          entry.status = 'available'
          await this._persistStatuses()
          logger.info(`Proxy ${getProxyHost(url)} OK via ${target} (${latencyMs}ms)`, 'PROXY')
          return { ok: true, status: 'available', latencyMs }
        }
      } catch (err) {
        lastError = err.code || err.message || 'unknown_error'
        // try next probe
      }
    }
    entry.status = 'failed'
    await this._persistStatuses()
    logger.warn(`Proxy ${getProxyHost(url)} failed all ${target} probes (${lastError})`, 'PROXY')
    return { ok: false, status: 'failed', latencyMs: 0, error: lastError || 'all_probes_failed' }
  }

  /**
   * Internal short-circuit alias kept for the assignProxy fast path.
   * Returns just the boolean — selection logic doesn't care about
   * latency.
   * @private
   */
  async _testProxy(url) {
    const result = await this.testProxy(url, { target: 'generic' })
    return result.ok
  }

  /**
   * Hand out a proxy to an account. Already-bound assignments are reused
   * unless forceNew is true. The four-tier priority below balances
   * exclusivity with discovery and recovery.
   *
   * Returns the proxyUrl on success, or null when no candidate works.
   */
  async assignProxy(email, forceNew = false) {
    if (this.proxies.size === 0) return null

    if (this.proxyAssignment.has(email) && !forceNew) {
      return this.proxyAssignment.get(email)
    }

    // Tear down old binding before searching for a replacement.
    if (this.proxyAssignment.has(email)) {
      const oldUrl = this.proxyAssignment.get(email)
      const oldEntry = this.proxies.get(oldUrl)
      if (oldEntry) oldEntry.assignedAccounts.delete(email)
      this.proxyAssignment.delete(email)
    }

    const all = [...this.proxies.values()]

    // P1: verified-available + unused (exclusive).
    const exclusive = all.filter(p => p.status === 'available' && p.assignedAccounts.size === 0)
    for (const p of this._shuffle(exclusive)) {
      if (await this._testProxy(p.url)) return this._bind(email, p)
    }

    // P2: untested (probe).
    const untested = all.filter(p => p.status === 'untested')
    for (const p of this._shuffle(untested)) {
      if (await this._testProxy(p.url)) return this._bind(email, p)
    }

    // P3: failed (re-probe; failures may have been transient).
    const failed = all.filter(p => p.status === 'failed')
    for (const p of this._shuffle(failed)) {
      if (await this._testProxy(p.url)) return this._bind(email, p)
    }

    // P4: verified-available + shared, least-loaded first.
    const shared = all
      .filter(p => p.status === 'available')
      .sort((a, b) => a.assignedAccounts.size - b.assignedAccounts.size)
    for (const p of shared) {
      if (await this._testProxy(p.url)) return this._bind(email, p)
    }

    logger.error(`No usable proxy for account ${email}`, 'PROXY')
    return null
  }

  _bind(email, entry) {
    this.proxyAssignment.set(email, entry.url)
    entry.assignedAccounts.add(email)
    if (this.dataPersistence && this.dataPersistence.saveProxyBinding) {
      // Fire-and-forget; persistence errors are logged inside the helper.
      this.dataPersistence.saveProxyBinding(email, entry.url).catch(() => {})
    }
    logger.info(`Bound ${email} -> ${getProxyHost(entry.url)}`, 'PROXY')
    return entry.url
  }

  getProxyForAccount(email) {
    return this.proxyAssignment.get(email) || null
  }

  /**
   * Mark a proxy as failed (typically called from the request layer after
   * a network error). The next assignProxy will skip it on P1 (still
   * available?) and fall through to P3 for a re-probe — failures don't
   * permanently remove a proxy from the pool.
   */
  async markProxyAsFailed(url) {
    const entry = this.proxies.get(url)
    if (!entry) return
    entry.status = 'failed'
    await this._persistStatuses()
    logger.warn(`Proxy ${getProxyHost(url)} marked failed`, 'PROXY')
  }

  /**
   * Tear down the smart-pool binding for an email. Used when the
   * operator switches the account out of `'smart'` mode (to `'fixed'`
   * or `'none'`) — the email should no longer count toward the pool's
   * shared-load accounting, and persistence should forget the binding
   * so it doesn't reappear on next cold start.
   *
   * Idempotent: returns false if the email had no binding.
   */
  async removeBinding(email) {
    const url = this.proxyAssignment.get(email)
    if (!url) return false
    const entry = this.proxies.get(url)
    if (entry) entry.assignedAccounts.delete(email)
    this.proxyAssignment.delete(email)
    if (this.dataPersistence && this.dataPersistence.saveProxyBinding) {
      try { await this.dataPersistence.saveProxyBinding(email, null) } catch { /* logged */ }
    }
    logger.info(`Cleared pool binding for ${email}`, 'PROXY')
    return true
  }

  /** @private */
  async _persistStatuses() {
    if (!this.dataPersistence || !this.dataPersistence.saveProxyStatuses) return
    const out = {}
    for (const [url, p] of this.proxies.entries()) out[url] = p.status
    try { await this.dataPersistence.saveProxyStatuses(out) } catch { /* logged inside */ }
  }

  /**
   * Add a new proxy at runtime (e.g. via admin API). Idempotent.
   */
  async addProxy(url) {
    if (!url || this.proxies.has(url)) return false
    this.proxies.set(url, { url, status: 'untested', assignedAccounts: new Set() })
    await this._persistStatuses()
    return true
  }

  /**
   * Remove a proxy. Any accounts bound to it are unbound and the binding
   * is cleared in persistence so they don't dangle.
   */
  async removeProxy(url) {
    const entry = this.proxies.get(url)
    if (!entry) return false
    for (const email of entry.assignedAccounts) {
      this.proxyAssignment.delete(email)
      if (this.dataPersistence && this.dataPersistence.saveProxyBinding) {
        try { await this.dataPersistence.saveProxyBinding(email, null) } catch { /* logged */ }
      }
    }
    this.proxies.delete(url)
    await this._persistStatuses()
    return true
  }

  /**
   * Snapshot for the admin UI — never includes embedded credentials in
   * the visible host (logs use getProxyHost too).
   */
  list() {
    return [...this.proxies.values()].map(p => ({
      url: p.url,
      host: getProxyHost(p.url),
      status: p.status,
      assignedAccounts: [...p.assignedAccounts],
    }))
  }

  /** @private */
  _shuffle(arr) {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
}

module.exports = ProxyPool
