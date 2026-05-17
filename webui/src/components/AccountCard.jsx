import { useState } from 'react'

export default function AccountCard({ account, onRefresh, onDelete, onToggleDisabled, onSetProxy, proxies = [] }) {
  const [refreshing, setRefreshing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [toggling, setToggling] = useState(false)
  // Per-card proxy editor state. Closed by default — operators rarely
  // change this so the row stays compact unless they ask for it.
  const [proxyEditOpen, setProxyEditOpen] = useState(false)
  const [pendingProxyUrl, setPendingProxyUrl] = useState(account.fixedProxyUrl || '')
  const [savingProxy, setSavingProxy] = useState(false)

  const isValid = account.isValid !== false
  const expiryTime = account.tokenExpiry || account.expiresAt
  const isExpiringSoon = expiryTime && (new Date(expiryTime) - Date.now()) < 3600000
  const hasToken = !!account.token
  const isDisabled = !!account.disabled
  // Login failed scenario: server kept the entry but token is empty.
  // lastLoginError is a unix-ms timestamp set by the backend on the last
  // failed login attempt.
  const loginFailed = !hasToken && account.lastLoginError
  // Disabled wins the visual presentation regardless of token validity —
  // the rotator skips disabled rows so calling them "valid" is misleading.
  const statusLabel = isDisabled
    ? '已禁用'
    : loginFailed
      ? '登录失败'
      : !hasToken
        ? '未登录'
        : isValid
          ? (isExpiringSoon ? '即将过期' : '有效')
          : '已过期'
  const statusClass = isDisabled
    ? 'bg-slate-500/15 text-slate-400 border border-slate-500/25'
    : (loginFailed || !hasToken)
      ? 'bg-red-500/10 text-red-400 border border-red-500/20'
      : isValid
        ? (isExpiringSoon ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20')
        : 'bg-red-500/10 text-red-400 border border-red-500/20'
  const dotClass = isDisabled
    ? 'bg-slate-500'
    : (loginFailed || !hasToken)
      ? 'bg-red-400'
      : isValid
        ? (isExpiringSoon ? 'bg-amber-400' : 'bg-emerald-400')
        : 'bg-red-400'

  // Proxy mode display. Default 'smart' when the field is missing on
  // legacy account records (pre-feature data.json).
  const proxyMode = account.proxyMode || 'smart'
  const proxyModeLabel = proxyMode === 'fixed' ? '固定代理'
    : proxyMode === 'none' ? '不走代理'
    : '智能代理'
  const proxyModeClass = proxyMode === 'fixed'
    ? 'bg-accent-primary/10 text-accent-glow border border-accent-primary/20'
    : proxyMode === 'none'
      ? 'bg-slate-500/10 text-slate-300 border border-slate-500/20'
      : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await onRefresh(account.email)
    } finally {
      setRefreshing(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`确定删除账号 ${account.email}？`)) return
    setDeleting(true)
    try {
      await onDelete(account.email)
    } finally {
      setDeleting(false)
    }
  }

  const handleToggleDisabled = async () => {
    if (!onToggleDisabled) return
    setToggling(true)
    try {
      await onToggleDisabled(account.email, !isDisabled)
    } finally {
      setToggling(false)
    }
  }

  // Apply a mode change. For 'smart' / 'none' we don't need a URL;
  // we send null and the server clears any stored fixedProxyUrl. For
  // 'fixed' we require pendingProxyUrl to be non-empty.
  const handleSetMode = async (mode) => {
    if (!onSetProxy) return
    let url = null
    if (mode === 'fixed') {
      url = (pendingProxyUrl || '').trim()
      if (!url) return // form will show validation; nothing to do here
    }
    setSavingProxy(true)
    try {
      await onSetProxy(account.email, mode, url)
      if (mode !== 'fixed') setProxyEditOpen(false)
    } finally {
      setSavingProxy(false)
    }
  }

  return (
    <div className={`glass-card p-4 hover:border-white/[0.12] transition-all duration-200 group ${isDisabled ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${dotClass}`} />
            <h4 className="text-sm font-medium text-slate-200 truncate">{account.email}</h4>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500 flex-wrap">
            <span className={`px-2 py-0.5 rounded-full ${statusClass}`}>{statusLabel}</span>
            {/* Proxy mode badge — clickable; opens the inline editor. */}
            <button
              onClick={() => setProxyEditOpen(v => !v)}
              className={`px-2 py-0.5 rounded-full transition-all hover:opacity-80 ${proxyModeClass}`}
              title="点击修改代理设置"
            >
              {proxyModeLabel}
              {proxyMode === 'fixed' && account.fixedProxyUrl && (
                <span className="ml-1 opacity-60 font-mono">
                  · {(() => {
                    try { return new URL(account.fixedProxyUrl).hostname } catch { return account.fixedProxyUrl }
                  })()}
                </span>
              )}
            </button>
            {expiryTime && hasToken && !isDisabled && (
              <span>过期: {new Date(expiryTime).toLocaleString()}</span>
            )}
            {loginFailed && !isDisabled && (
              <span title={new Date(account.lastLoginError).toLocaleString()}>
                上次登录失败: {new Date(account.lastLoginError).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {/* Refresh + disable buttons stay visible on rows that need
            attention (no token / login failed / disabled), hover-only
            otherwise. */}
        <div className={`flex items-center gap-1 transition-opacity ${
          (!hasToken || loginFailed || isDisabled) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}>
          {/* Disable / enable toggle */}
          {onToggleDisabled && (
            <button
              onClick={handleToggleDisabled}
              disabled={toggling}
              className={`p-1.5 rounded-lg transition-all disabled:opacity-50 ${
                isDisabled
                  ? 'text-emerald-400 hover:bg-emerald-500/10'
                  : 'text-slate-400 hover:text-amber-400 hover:bg-amber-500/10'
              }`}
              title={isDisabled ? '启用账号' : '禁用账号（保留密码，可恢复）'}
            >
              {isDisabled ? (
                // play icon (enable)
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                // pause icon (disable)
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing || isDisabled}
            className="p-1.5 rounded-lg text-slate-400 hover:text-accent-glow hover:bg-accent-primary/10 transition-all disabled:opacity-50"
            title={isDisabled ? '已禁用' : (loginFailed ? '重试登录' : '刷新 Token')}
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
            title="删除账号"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Inline proxy editor. Opens from the proxy badge above — three
          mode buttons + a URL field that's only meaningful for 'fixed'.
          For convenience we also show the existing pool entries as quick
          picks when 'fixed' is the selected target. */}
      {proxyEditOpen && onSetProxy && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] animate-fade-in">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-xs text-slate-500">代理模式:</span>
            <button
              onClick={() => handleSetMode('smart')}
              disabled={savingProxy}
              className={`text-xs px-2.5 py-1 rounded-full transition-all disabled:opacity-50 ${
                proxyMode === 'smart'
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'bg-white/[0.04] text-slate-400 border border-white/[0.08] hover:border-emerald-500/20 hover:text-emerald-400'
              }`}
              title="从代理池中随机选择可用代理"
            >
              智能
            </button>
            <button
              onClick={() => setPendingProxyUrl(account.fixedProxyUrl || pendingProxyUrl)}
              disabled={savingProxy}
              className={`text-xs px-2.5 py-1 rounded-full transition-all disabled:opacity-50 ${
                proxyMode === 'fixed'
                  ? 'bg-accent-primary/15 text-accent-glow border border-accent-primary/30'
                  : 'bg-white/[0.04] text-slate-400 border border-white/[0.08] hover:border-accent-primary/20 hover:text-accent-glow'
              }`}
              title="始终使用一个固定代理"
            >
              固定
            </button>
            <button
              onClick={() => handleSetMode('none')}
              disabled={savingProxy}
              className={`text-xs px-2.5 py-1 rounded-full transition-all disabled:opacity-50 ${
                proxyMode === 'none'
                  ? 'bg-slate-500/20 text-slate-200 border border-slate-500/40'
                  : 'bg-white/[0.04] text-slate-400 border border-white/[0.08] hover:border-slate-400/30 hover:text-slate-200'
              }`}
              title="此账号始终直连，不走任何代理"
            >
              直连
            </button>
            <button
              onClick={() => setProxyEditOpen(false)}
              className="ml-auto text-xs text-slate-500 hover:text-slate-300"
            >
              收起
            </button>
          </div>

          {/* Fixed-mode editor. Only meaningful when 'fixed' is the
              selected outcome, but we render it whenever the editor is
              open so the operator can pre-fill it before clicking
              "固定". */}
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={pendingProxyUrl}
              onChange={(e) => setPendingProxyUrl(e.target.value)}
              placeholder="socks5://1.2.3.4:1080  或  http://user:pass@host:port"
              className="input-field flex-1 text-xs py-1.5 font-mono"
              disabled={savingProxy}
            />
            <button
              onClick={() => handleSetMode('fixed')}
              disabled={savingProxy || !pendingProxyUrl.trim()}
              className="btn-primary text-xs py-1.5 px-3 disabled:opacity-50 whitespace-nowrap"
            >
              {savingProxy ? '保存中...' : '设为固定'}
            </button>
          </div>

          {/* Quick picks from the existing pool. Saves operator typing
              when the desired proxy is already in the pool. Only shown
              if there are entries. */}
          {Array.isArray(proxies) && proxies.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-500">从池中选:</span>
              {proxies.map(p => (
                <button
                  key={p.url}
                  onClick={() => setPendingProxyUrl(p.url)}
                  className="text-xs px-2 py-0.5 rounded font-mono text-slate-400 hover:text-accent-glow hover:bg-white/[0.04] border border-transparent hover:border-white/[0.08] transition-all"
                  title={p.url}
                >
                  {p.host || p.url}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
