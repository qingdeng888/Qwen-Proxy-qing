import { getApiKey } from './storage'
import { API_ENDPOINTS } from './constants'

function getHeaders() {
  const key = getApiKey()
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  }
}

export async function apiFetch(endpoint, options = {}) {
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      ...getHeaders(),
      ...options.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(error.error?.message || error.error || `Request failed: ${response.status}`)
  }

  return response.json()
}

export async function fetchModels() {
  const data = await apiFetch(API_ENDPOINTS.MODELS)
  return data.data || []
}

export async function verifyKey(key) {
  const response = await fetch(API_ENDPOINTS.VERIFY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  return response.ok
}

export async function fetchAccounts() {
  return apiFetch(API_ENDPOINTS.GET_ALL_ACCOUNTS)
}

export async function addAccount(email, password) {
  return apiFetch(API_ENDPOINTS.SET_ACCOUNT, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function deleteAccount(email) {
  return apiFetch(API_ENDPOINTS.DELETE_ACCOUNT, {
    method: 'DELETE',
    body: JSON.stringify({ email }),
  })
}

export async function refreshAccount(email) {
  return apiFetch(API_ENDPOINTS.REFRESH_ACCOUNT, {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function refreshAllAccounts() {
  return apiFetch(API_ENDPOINTS.REFRESH_ALL_ACCOUNTS, {
    method: 'POST',
  })
}

export async function setAccountDisabled(email, disabled) {
  return apiFetch('/api/disableAccount', {
    method: 'POST',
    body: JSON.stringify({ email, disabled }),
  })
}

/**
 * Manually push the current in-memory accounts / proxies / disabled list
 * to the Vercel project's env vars. Triggers a Vercel build as a side
 * effect (~60s startup), which is why we don't auto-sync on every
 * mutation.
 * @param {Array<'accounts'|'proxies'|'disabled'>|'all'} [scopes]
 */
export async function vercelSyncNow(scopes) {
  return apiFetch('/api/vercel/syncNow', {
    method: 'POST',
    body: JSON.stringify({ scopes: scopes || 'all' }),
  })
}

/* ----- api keys (runtime) ----- */

/**
 * Fetch the runtime API key list. By default the server returns masked
 * keys; pass `reveal=true` to fetch raw values (used by the operator
 * UI when they explicitly toggle visibility).
 */
export async function fetchApiKeys(reveal = false) {
  const url = reveal
    ? `${API_ENDPOINTS.API_KEYS}?reveal=1`
    : API_ENDPOINTS.API_KEYS
  const data = await apiFetch(url)
  return data.data || []
}

/**
 * Add a new runtime API key. If `key` is omitted/empty, server
 * auto-generates one with a `sk-` prefix and returns it.
 */
export async function addApiKey(key) {
  return apiFetch(API_ENDPOINTS.API_KEYS, {
    method: 'POST',
    body: JSON.stringify({ key: key || '' }),
  })
}

export async function deleteApiKey(key) {
  return apiFetch(API_ENDPOINTS.API_KEYS, {
    method: 'DELETE',
    body: JSON.stringify({ key }),
  })
}

/* ----- usage stats ----- */

/**
 * Fetch the full usage snapshot. Returns the parsed object directly
 * (not a wrapper), shape: { apiKeys: [...], accounts: [...], summary }.
 */
export async function fetchUsage() {
  return apiFetch(API_ENDPOINTS.USAGE)
}

/**
 * Reset usage counters. Scope:
 *   - 'all'                 → wipe everything
 *   - 'apikey' + { id }     → reset one bucket by snapshot id
 *   - 'account' + { email } → reset one account bucket
 */
export async function resetUsage(payload) {
  return apiFetch(API_ENDPOINTS.USAGE_RESET, {
    method: 'POST',
    body: JSON.stringify(payload || { scope: 'all' }),
  })
}

/* ----- smart proxy pool ----- */

export async function fetchProxies() {
  const data = await apiFetch('/api/proxy/status')
  return data.data || []
}

export async function addProxy(url) {
  return apiFetch('/api/proxy/add', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export async function removeProxy(url) {
  return apiFetch('/api/proxy', {
    method: 'DELETE',
    body: JSON.stringify({ url }),
  })
}

/**
 * Stream chat with support for reasoning_content (thinking) and content (answer)
 * @param {Array} messages
 * @param {string} model
 * @param {Function} onChunk - (content, type) where type is 'content' or 'reasoning'
 * @param {Function} onDone
 * @param {AbortSignal} signal
 * @param {Object} extraParams - additional params like enable_thinking, reasoning_effort
 */
export async function streamChat(messages, model, onChunk, onDone, signal, extraParams = {}) {
  const key = getApiKey()
  const response = await fetch(API_ENDPOINTS.CHAT_COMPLETIONS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...extraParams,
    }),
    signal,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(error.error?.message || error.error || `Request failed: ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') {
        onDone()
        return
      }
      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta
        if (!delta) continue
        if (delta.reasoning_content) {
          onChunk(delta.reasoning_content, 'reasoning')
        }
        if (delta.content) {
          onChunk(delta.content, 'content')
        }
      } catch {
        // skip malformed JSON
      }
    }
  }

  onDone()
}
