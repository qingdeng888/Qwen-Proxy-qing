import { useState, useEffect, useCallback } from 'react'
import { fetchAccounts, addAccount, deleteAccount, refreshAccount, refreshAllAccounts, setAccountDisabled, setAccountProxy, fetchProxies, addProxy, removeProxy, testProxy, fetchApiKeys, addApiKey, deleteApiKey } from '../utils/api'
import { useToast } from '../hooks/useToast'
import AccountCard from '../components/AccountCard'
import StatsCard from '../components/StatsCard'

export default function Admin() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAddSingle, setShowAddSingle] = useState(false)
  const [showAddBatch, setShowAddBatch] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [batchText, setBatchText] = useState('')
  const [refreshingAll, setRefreshingAll] = useState(false)
  // smart proxy pool state
  const [proxies, setProxies] = useState([])
  const [proxiesLoaded, setProxiesLoaded] = useState(false)
  const [newProxyUrl, setNewProxyUrl] = useState('')
  const [proxyBusy, setProxyBusy] = useState(false)
  // Per-proxy testing state: { [url]: { testing: bool, latencyMs?: number } }
  // testing flag drives the spinner on the test button; latencyMs is shown
  // briefly after a successful probe so the operator gets immediate feedback
  // even before the next proxy-list refresh repaints the status badge.
  const [proxyTest, setProxyTest] = useState({})
  // API keys state
  const [apiKeys, setApiKeys] = useState([])
  const [apiKeysLoaded, setApiKeysLoaded] = useState(false)
  const [showAddKey, setShowAddKey] = useState(false)
  const [newKeyValue, setNewKeyValue] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [revealKeys, setRevealKeys] = useState(false)
  // The key value just created — surfaced in a one-time banner so the
  // operator can copy it before it gets masked. Cleared on next add.
  const [lastCreatedKey, setLastCreatedKey] = useState('')
  const { toast } = useToast()

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchAccounts()
      setAccounts(Array.isArray(data) ? data : data.data || data.accounts || [])
    } catch (err) {
      toast.error('加载账号失败: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    loadAccounts()
    loadProxies()
    loadApiKeys()
  }, [loadAccounts])

  const loadProxies = useCallback(async () => {
    try {
      const list = await fetchProxies()
      setProxies(Array.isArray(list) ? list : [])
    } catch (err) {
      // 静默：当用户没用代理池时这条接口不算关键
      setProxies([])
    } finally {
      setProxiesLoaded(true)
    }
  }, [])

  const loadApiKeys = useCallback(async (reveal = false) => {
    try {
      const list = await fetchApiKeys(reveal)
      setApiKeys(Array.isArray(list) ? list : [])
    } catch (err) {
      // Non-admin keys can't see this list; silently degrade.
      setApiKeys([])
    } finally {
      setApiKeysLoaded(true)
    }
  }, [])

  const handleToggleReveal = async () => {
    const next = !revealKeys
    setRevealKeys(next)
    await loadApiKeys(next)
  }

  const handleAddKey = async (e) => {
    e.preventDefault()
    setKeyBusy(true)
    try {
      const res = await addApiKey(newKeyValue.trim())
      // Show the freshly minted key once so the operator can copy it
      // before refresh re-masks it.
      setLastCreatedKey(res.key || '')
      toast.success(newKeyValue.trim() ? '已添加 API Key' : '已生成新 API Key')
      setNewKeyValue('')
      setShowAddKey(false)
      await loadApiKeys(revealKeys)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setKeyBusy(false)
    }
  }

  const handleDeleteKey = async (item) => {
    if (!item.deletable) {
      toast.error('环境变量管理的 Key 无法在此删除')
      return
    }
    if (!confirm(`确定删除此 API Key？\n${item.keyMasked || item.key}`)) return
    try {
      // Server expects the raw key value. If we currently see the masked
      // form we re-fetch with reveal=1 to get the real one. (This still
      // requires admin auth on the server side.)
      let raw = item.key
      if (!revealKeys) {
        const list = await fetchApiKeys(true)
        const match = list.find(k => k.keyMasked === (item.keyMasked || item.key))
        if (!match) throw new Error('未能定位该 Key')
        raw = match.key
      }
      await deleteApiKey(raw)
      toast.success('已删除')
      await loadApiKeys(revealKeys)
    } catch (err) {
      toast.error(err.message)
    }
  }

  const copyToClipboard = async (value, label = 'Key') => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`已复制 ${label}`)
    } catch {
      toast.error('复制失败')
    }
  }

  const handleAddProxy = async (e) => {
    e.preventDefault()
    const url = newProxyUrl.trim()
    if (!url) return
    setProxyBusy(true)
    try {
      await addProxy(url)
      toast.success(`已添加 ${url}`)
      setNewProxyUrl('')
      await loadProxies()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setProxyBusy(false)
    }
  }

  const handleRemoveProxy = async (url) => {
    if (!confirm(`确定移除代理 ${url}？`)) return
    try {
      await removeProxy(url)
      toast.success(`已移除`)
      loadProxies()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const handleTestProxy = async (url) => {
    setProxyTest(s => ({ ...s, [url]: { testing: true } }))
    try {
      const result = await testProxy(url, 'qwen')
      setProxyTest(s => ({ ...s, [url]: { testing: false, ok: result.ok, latencyMs: result.latencyMs } }))
      if (result.ok) {
        toast.success(`代理可用 (${result.latencyMs}ms)`)
      } else {
        toast.error(`代理不可用: ${result.error || 'failed'}`)
      }
      // Refresh the list so the status badge picks up the new value the
      // server just persisted. The transient { ok, latencyMs } in
      // proxyTest stays so the operator sees the latency until they
      // navigate away.
      await loadProxies()
    } catch (err) {
      setProxyTest(s => ({ ...s, [url]: { testing: false } }))
      toast.error(err.message)
    }
  }

  const handleAddSingle = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    try {
      await addAccount(email.trim(), password.trim())
      toast.success(`已添加账号 ${email}`)
      setEmail('')
      setPassword('')
      setShowAddSingle(false)
      loadAccounts()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const handleAddBatch = async (e) => {
    e.preventDefault()
    const lines = batchText.trim().split('\n').filter(Boolean)
    let added = 0
    for (const line of lines) {
      const [em, pw] = line.split(':').map(s => s.trim())
      if (em && pw) {
        try {
          await addAccount(em, pw)
          added++
        } catch {
          // continue
        }
      }
    }
    toast.success(`已添加 ${added} 个账号`)
    setBatchText('')
    setShowAddBatch(false)
    loadAccounts()
  }

  const handleRefresh = async (em) => {
    try {
      await refreshAccount(em)
      toast.success(`已刷新 ${em}`)
      loadAccounts()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const handleDelete = async (em) => {
    try {
      await deleteAccount(em)
      toast.success(`已删除 ${em}`)
      loadAccounts()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const handleToggleDisabled = async (em, disabled) => {
    try {
      await setAccountDisabled(em, disabled)
      toast.success(`${disabled ? '已禁用' : '已启用'} ${em}`)
      loadAccounts()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const handleSetProxy = async (em, mode, proxyUrl) => {
    try {
      await setAccountProxy(em, mode, proxyUrl)
      const label = mode === 'fixed' ? `固定代理 ${proxyUrl}`
        : mode === 'none' ? '不走代理'
        : '智能代理'
      toast.success(`${em}: ${label}`)
      // Reload both accounts and proxies — the pool's assignedAccounts
      // counts shift when an account leaves smart mode, and the new
      // proxyMode/fixedProxyUrl fields come back via /getAllAccounts.
      await loadAccounts()
      await loadProxies()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const handleRefreshAll = async () => {
    setRefreshingAll(true)
    try {
      // Server defaults to force=true so every account is re-logged in,
      // not just ones whose tokens were going to expire within 24h
      // (which silently no-op'd on healthy tokens — looked broken).
      const result = await refreshAllAccounts()
      const refreshed = Number(result?.refreshed ?? result?.refreshedCount ?? 0)
      const total = Number(result?.total ?? refreshed)
      const failed = Number(result?.failed ?? Math.max(0, total - refreshed))
      if (total === 0) {
        toast.info?.('没有需要刷新的账号') || toast.success('没有需要刷新的账号')
      } else if (failed === 0) {
        toast.success(`已刷新 ${refreshed} 个账号`)
      } else {
        toast.error(`刷新完成：${refreshed} 个成功，${failed} 个失败（详见服务端日志）`)
      }
      loadAccounts()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRefreshingAll(false)
    }
  }

  // Stats
  const total = accounts.length
  const valid = accounts.filter(a => a.isValid !== false).length
  const expired = total - valid
  const expiringSoon = accounts.filter(a => {
    const exp = a.tokenExpiry || a.expiresAt
    return exp && (new Date(exp) - Date.now()) < 3600000 && (new Date(exp) - Date.now()) > 0
  }).length

  return (
    <div className="h-screen overflow-y-auto p-6 lg:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 animate-fade-in">
          <div>
            <h1 className="text-2xl font-display font-bold text-white">账号管理</h1>
            <p className="mt-1 text-sm text-slate-400">管理 Qwen AI 账号和 Token</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefreshAll}
              disabled={refreshingAll}
              className="btn-ghost text-sm flex items-center gap-2 disabled:opacity-50"
            >
              <svg className={`w-4 h-4 ${refreshingAll ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              刷新全部
            </button>
            <button
              onClick={() => { setShowAddSingle(true); setShowAddBatch(false) }}
              className="btn-primary text-sm flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              添加账号
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatsCard
            title="账号总数"
            value={total}
            color="accent"
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            }
          />
          <StatsCard
            title="有效"
            value={valid}
            color="emerald"
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
          <StatsCard
            title="即将过期"
            value={expiringSoon}
            color="amber"
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
          <StatsCard
            title="已过期"
            value={expired}
            color="red"
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            }
          />
        </div>

        {/* Add Single Account Modal */}
        {showAddSingle && (
          <div className="glass-card p-6 mb-6 animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">添加账号</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowAddSingle(false); setShowAddBatch(true) }}
                  className="text-xs text-accent-glow hover:underline"
                >
                  批量添加
                </button>
                <button onClick={() => setShowAddSingle(false)} className="text-slate-400 hover:text-white">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <form onSubmit={handleAddSingle} className="flex flex-col sm:flex-row gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="邮箱"
                className="input-field flex-1"
                autoFocus
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="密码"
                className="input-field flex-1"
              />
              <button type="submit" className="btn-primary whitespace-nowrap">
                添加
              </button>
            </form>
          </div>
        )}

        {/* Batch Add Modal */}
        {showAddBatch && (
          <div className="glass-card p-6 mb-6 animate-slide-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">批量添加账号</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowAddBatch(false); setShowAddSingle(true) }}
                  className="text-xs text-accent-glow hover:underline"
                >
                  单个添加
                </button>
                <button onClick={() => setShowAddBatch(false)} className="text-slate-400 hover:text-white">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <form onSubmit={handleAddBatch}>
              <textarea
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                placeholder="每行一个账号：邮箱:密码"
                rows={6}
                className="input-field font-mono text-sm mb-3"
                autoFocus
              />
              <button type="submit" className="btn-primary">
                全部添加
              </button>
            </form>
          </div>
        )}

        {/* Account list */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex items-center gap-3 text-slate-400">
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              加载中...
            </div>
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <p className="text-slate-400">暂无账号</p>
            <p className="text-sm text-slate-500 mt-1">添加账号以开始使用</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {accounts.map((account, i) => (
              <div key={account.email || i} className="animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                <AccountCard
                  account={account}
                  onRefresh={handleRefresh}
                  onDelete={handleDelete}
                  onToggleDisabled={handleToggleDisabled}
                  onSetProxy={handleSetProxy}
                  proxies={proxies}
                />
              </div>
            ))}
          </div>
        )}

        {/* Smart proxy pool — only renders the section once we've fetched
            at least once. The pool is optional; an empty list is fine. */}
        {proxiesLoaded && (
          <div className="mt-10 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-display font-semibold text-white">智能代理池</h2>
                <p className="text-xs text-slate-500 mt-0.5">SOCKS5 / HTTP / HTTPS 代理；账号绑定 + 故障转移 + 持久化</p>
              </div>
              <span className="text-xs text-slate-500">{proxies.length} 个代理</span>
            </div>

            {/* Add proxy form */}
            <form onSubmit={handleAddProxy} className="glass-card p-4 mb-4 flex items-center gap-2">
              <input
                type="text"
                value={newProxyUrl}
                onChange={(e) => setNewProxyUrl(e.target.value)}
                placeholder="socks5://1.2.3.4:1080  或  http://user:pass@host:port"
                className="input-field flex-1 text-sm py-2 font-mono"
                disabled={proxyBusy}
              />
              <button
                type="submit"
                disabled={proxyBusy || !newProxyUrl.trim()}
                className="btn-primary text-sm py-2 px-4 disabled:opacity-50"
              >
                {proxyBusy ? '添加中...' : '添加'}
              </button>
            </form>

            {/* Existing proxies */}
            {proxies.length === 0 ? (
              <div className="glass-card p-6 text-center text-sm text-slate-500">
                暂无代理。可通过 <code className="text-accent-glow font-mono">PROXIES</code> 环境变量批量初始化，或在上面输入框逐条添加。
              </div>
            ) : (
              <div className="space-y-2">
                {proxies.map((p) => {
                  const dotClass = p.status === 'available'
                    ? 'bg-emerald-400'
                    : p.status === 'failed'
                    ? 'bg-red-400'
                    : 'bg-slate-500'
                  const statusLabel = p.status === 'available'
                    ? '可用'
                    : p.status === 'failed'
                    ? '失败'
                    : '未测试'
                  const statusClass = p.status === 'available'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : p.status === 'failed'
                    ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                    : 'bg-slate-500/10 text-slate-400 border border-slate-500/20'
                  const tState = proxyTest[p.url] || {}
                  return (
                    <div key={p.url} className="glass-card p-3 flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
                      <code className="text-xs font-mono text-slate-300 flex-1 truncate" title={p.url}>
                        {p.host || p.url}
                      </code>
                      <span className={`px-2 py-0.5 rounded-full text-xs ${statusClass}`}>
                        {statusLabel}
                      </span>
                      {/* Latency from the most recent test stays until next navigation. */}
                      {tState.ok && Number.isFinite(tState.latencyMs) && (
                        <span className="text-xs text-emerald-400 hidden sm:inline">
                          {tState.latencyMs}ms
                        </span>
                      )}
                      <span className="text-xs text-slate-500 hidden sm:inline">
                        {p.assignedAccounts?.length || 0} 账号
                      </span>
                      <button
                        onClick={() => handleTestProxy(p.url)}
                        disabled={tState.testing}
                        className="p-1.5 rounded text-slate-400 hover:text-accent-glow hover:bg-accent-primary/10 transition-all disabled:opacity-50"
                        title="测试连通性 (走 Qwen 真实地址)"
                      >
                        <svg className={`w-4 h-4 ${tState.testing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          {tState.testing ? (
                            <>
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </>
                          ) : (
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          )}
                        </svg>
                      </button>
                      <button
                        onClick={() => handleRemoveProxy(p.url)}
                        className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
                        title="移除"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* API Key 管理 — runtime keys list with reveal toggle, add form,
            and delete. Env-managed keys (incl. admin) are listed with
            a lock icon and cannot be deleted from the UI. */}
        {apiKeysLoaded && (
          <div className="mt-10 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-display font-semibold text-white">API Key 管理</h2>
                <p className="text-xs text-slate-500 mt-0.5">控制访问代理服务的 Key；环境变量定义的 Key 只读，运行时新增的 Key 持久化保存</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleToggleReveal}
                  className="btn-ghost text-xs flex items-center gap-1.5"
                  title={revealKeys ? '隐藏明文' : '显示明文'}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    {revealKeys ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    )}
                  </svg>
                  {revealKeys ? '隐藏' : '显示'}
                </button>
                <button
                  onClick={() => setShowAddKey(v => !v)}
                  className="btn-primary text-xs flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  添加 Key
                </button>
              </div>
            </div>

            {/* One-time banner: shows the freshly minted raw key value
                so the operator can copy it. Subsequent loads will mask
                it unless they toggle reveal. */}
            {lastCreatedKey && (
              <div className="glass-card p-4 mb-4 border-l-2 border-l-emerald-500/40 animate-slide-up">
                <div className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-emerald-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white mb-1">新 Key 已创建</div>
                    <p className="text-xs text-slate-400 mb-2">请立刻复制并保存好，关闭后只能看到掩码形式。</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 rounded bg-black/40 text-xs font-mono text-emerald-300 break-all">
                        {lastCreatedKey}
                      </code>
                      <button
                        onClick={() => copyToClipboard(lastCreatedKey, '新 Key')}
                        className="btn-ghost text-xs whitespace-nowrap"
                      >
                        复制
                      </button>
                      <button
                        onClick={() => setLastCreatedKey('')}
                        className="text-slate-500 hover:text-slate-300"
                        title="关闭"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Add form. Empty input -> server auto-generates an sk-... key. */}
            {showAddKey && (
              <form onSubmit={handleAddKey} className="glass-card p-4 mb-4 flex items-center gap-2 animate-slide-up">
                <input
                  type="text"
                  value={newKeyValue}
                  onChange={(e) => setNewKeyValue(e.target.value)}
                  placeholder="自定义 Key (留空则自动生成 sk-... )"
                  className="input-field flex-1 text-sm py-2 font-mono"
                  disabled={keyBusy}
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={keyBusy}
                  className="btn-primary text-sm py-2 px-4 disabled:opacity-50 whitespace-nowrap"
                >
                  {keyBusy ? '处理中...' : (newKeyValue.trim() ? '添加' : '生成')}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowAddKey(false); setNewKeyValue('') }}
                  className="btn-ghost text-sm py-2 px-3"
                >
                  取消
                </button>
              </form>
            )}

            {/* Key list */}
            {apiKeys.length === 0 ? (
              <div className="glass-card p-6 text-center text-sm text-slate-500">
                暂无 API Key。可在 <code className="text-accent-glow font-mono">API_KEY</code> 环境变量中初始化，或点击上方"添加 Key"。
              </div>
            ) : (
              <div className="space-y-2">
                {apiKeys.map((item, idx) => {
                  const display = revealKeys ? item.key : (item.keyMasked || item.key)
                  const sourceLabel = item.source === 'env' ? '环境变量' : '运行时'
                  const sourceClass = item.source === 'env'
                    ? 'bg-slate-500/10 text-slate-300 border border-slate-500/20'
                    : 'bg-accent-primary/10 text-accent-glow border border-accent-primary/20'
                  return (
                    <div key={`${item.source}-${item.keyMasked}-${idx}`} className="glass-card p-3 flex items-center gap-3">
                      {item.isAdmin ? (
                        <svg className="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="管理员 Key">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 text-slate-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                        </svg>
                      )}
                      <code
                        className={`text-xs font-mono flex-1 truncate ${revealKeys ? 'text-emerald-300' : 'text-slate-300'}`}
                        title={display}
                      >
                        {display}
                      </code>
                      {item.isAdmin && (
                        <span className="px-2 py-0.5 rounded-full text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          管理员
                        </span>
                      )}
                      <span className={`px-2 py-0.5 rounded-full text-xs ${sourceClass}`}>
                        {sourceLabel}
                      </span>
                      {revealKeys && (
                        <button
                          onClick={() => copyToClipboard(item.key)}
                          className="p-1.5 rounded text-slate-400 hover:text-accent-glow hover:bg-white/[0.04] transition-all"
                          title="复制"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteKey(item)}
                        disabled={!item.deletable}
                        className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-slate-400 disabled:hover:bg-transparent"
                        title={item.deletable ? '删除' : '环境变量管理的 Key 不可在此删除'}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
