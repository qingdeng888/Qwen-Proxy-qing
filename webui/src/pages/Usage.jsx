import { useState, useEffect, useCallback } from 'react'
import { fetchUsage, resetUsage } from '../utils/api'
import { useToast } from '../hooks/useToast'

/**
 * Usage stats page — per-API-key + per-Qwen-account counters.
 *
 * Numbers are aggregated server-side by usage-tracker.js and refreshed
 * by re-fetching the full snapshot. Token counts come from the upstream
 * `usage` chunks when available; Qwen typically omits them so the
 * tracker falls back to a character-based estimator (same one the
 * chat controller uses for the user-facing usage payload), counted
 * over both `delta.content` (answer) and `delta.reasoning_content`
 * (thinking). Very-short cancellations may still show 0.
 */
export default function Usage() {
  const [usage, setUsage] = useState({ apiKeys: [], accounts: [], summary: null })
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const { toast } = useToast()

  const loadUsage = useCallback(async () => {
    setRefreshing(true)
    try {
      const data = await fetchUsage()
      setUsage({
        apiKeys: Array.isArray(data?.apiKeys) ? data.apiKeys : [],
        accounts: Array.isArray(data?.accounts) ? data.accounts : [],
        summary: data?.summary || null,
      })
    } catch (err) {
      // Non-admin keys can't see this; silently degrade.
      setUsage({ apiKeys: [], accounts: [], summary: null })
    } finally {
      setLoaded(true)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadUsage()
  }, [loadUsage])

  const handleReset = async (payload, label) => {
    if (!confirm(`确定重置 ${label} 的统计数据？此操作不可撤销。`)) return
    try {
      await resetUsage(payload)
      toast.success(`已重置 ${label}`)
      await loadUsage()
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <div className="h-screen overflow-y-auto p-6 lg:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 animate-fade-in">
          <div>
            <h1 className="text-2xl font-display font-bold text-white">用量统计</h1>
            <p className="mt-1 text-sm text-slate-400">按 API Key 与 Qwen 账号分桶；统计请求成败、输入 / 输出 token</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadUsage}
              disabled={refreshing}
              className="btn-ghost text-sm flex items-center gap-2 disabled:opacity-50"
              title="刷新"
            >
              <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              刷新
            </button>
            <button
              onClick={() => handleReset({ scope: 'all' }, '全部统计')}
              className="btn-ghost text-sm flex items-center gap-2 hover:text-red-400"
              title="清空全部统计"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              清空全部
            </button>
          </div>
        </div>

        {!loaded ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex items-center gap-3 text-slate-400">
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              加载中...
            </div>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            {usage.summary && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                <div className="glass-card p-4">
                  <div className="text-xs text-slate-500">总请求</div>
                  <div className="text-2xl font-semibold text-white mt-1 tabular-nums">
                    {(usage.summary.apiKeys?.totalRequests ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="glass-card p-4">
                  <div className="text-xs text-slate-500">成功</div>
                  <div className="text-2xl font-semibold text-emerald-400 mt-1 tabular-nums">
                    {(usage.summary.apiKeys?.successRequests ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="glass-card p-4">
                  <div className="text-xs text-slate-500">输入 token</div>
                  <div className="text-2xl font-semibold text-white mt-1 tabular-nums">
                    {(usage.summary.apiKeys?.promptTokens ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="glass-card p-4">
                  <div className="text-xs text-slate-500">输出 token</div>
                  <div className="text-2xl font-semibold text-white mt-1 tabular-nums">
                    {(usage.summary.apiKeys?.completionTokens ?? 0).toLocaleString()}
                  </div>
                </div>
              </div>
            )}

            {/* Per API Key table */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-display font-semibold text-white">按 API Key</h2>
                <span className="text-xs text-slate-500">{usage.apiKeys.length} 项</span>
              </div>
              {usage.apiKeys.length === 0 ? (
                <div className="glass-card p-8 text-center text-sm text-slate-500">
                  暂无用量数据。当有客户端调用时此处会自动累计。
                </div>
              ) : (
                <div className="glass-card overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-white/[0.06]">
                        <th className="px-3 py-2.5 font-medium">Key</th>
                        <th className="px-3 py-2.5 font-medium text-right">总请求</th>
                        <th className="px-3 py-2.5 font-medium text-right">成功</th>
                        <th className="px-3 py-2.5 font-medium text-right">失败</th>
                        <th className="px-3 py-2.5 font-medium text-right">输入 tokens</th>
                        <th className="px-3 py-2.5 font-medium text-right">输出 tokens</th>
                        <th className="px-3 py-2.5 font-medium">最近</th>
                        <th className="px-3 py-2.5 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.apiKeys.map((row) => {
                        const sourceLabel =
                          row.source === 'env' ? '环境变量'
                          : row.source === 'runtime' ? '运行时'
                          : row.source === 'anonymous' ? '无鉴权'
                          : '已删除'
                        const sourceClass =
                          row.source === 'orphan' ? 'text-slate-500'
                          : row.source === 'anonymous' ? 'text-amber-400'
                          : 'text-slate-300'
                        return (
                          <tr key={row.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                            <td className="px-3 py-2 font-mono text-slate-200">
                              <div className="flex items-center gap-2">
                                {row.isAdmin && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                    管理员
                                  </span>
                                )}
                                <span>{row.keyMasked}</span>
                                <span className={`text-[10px] ${sourceClass}`}>· {sourceLabel}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{(row.totalRequests || 0).toLocaleString()}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{(row.successRequests || 0).toLocaleString()}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-red-400">{(row.failedRequests || 0).toLocaleString()}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{(row.promptTokens || 0).toLocaleString()}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{(row.completionTokens || 0).toLocaleString()}</td>
                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                              {row.lastUsed ? new Date(row.lastUsed).toLocaleString('zh-CN', { hour12: false }) : '—'}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button
                                onClick={() => handleReset({ scope: 'apikey', id: row.id }, row.keyMasked)}
                                className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                                title="重置该 Key 统计"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Per Qwen account table */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-display font-semibold text-white">按 Qwen 账号</h2>
                <span className="text-xs text-slate-500">{usage.accounts.length} 项</span>
              </div>
              {usage.accounts.length === 0 ? (
                <div className="glass-card p-8 text-center text-sm text-slate-500">
                  暂无账号用量。当代理路由到具体账号时此处会自动累计。
                </div>
              ) : (
                <div className="glass-card overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b border-white/[0.06]">
                        <th className="px-3 py-2.5 font-medium">账号</th>
                        <th className="px-3 py-2.5 font-medium text-right">总请求</th>
                        <th className="px-3 py-2.5 font-medium text-right">成功</th>
                        <th className="px-3 py-2.5 font-medium text-right">失败</th>
                        <th className="px-3 py-2.5 font-medium text-right">输入 tokens</th>
                        <th className="px-3 py-2.5 font-medium text-right">输出 tokens</th>
                        <th className="px-3 py-2.5 font-medium">最近</th>
                        <th className="px-3 py-2.5 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.accounts.map((row) => (
                        <tr key={row.email} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02]">
                          <td className="px-3 py-2 font-mono text-slate-200">
                            <div className="flex items-center gap-2">
                              <span className="truncate" title={row.email}>{row.email}</span>
                              {row.exists === false && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-500/10 text-slate-500 border border-slate-500/20">
                                  已删除
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{(row.totalRequests || 0).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{(row.successRequests || 0).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-red-400">{(row.failedRequests || 0).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{(row.promptTokens || 0).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{(row.completionTokens || 0).toLocaleString()}</td>
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                            {row.lastUsed ? new Date(row.lastUsed).toLocaleString('zh-CN', { hour12: false }) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => handleReset({ scope: 'account', email: row.email }, row.email)}
                              className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
                              title="重置该账号统计"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
