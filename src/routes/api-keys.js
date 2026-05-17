const express = require('express')
const router = express.Router()
const apiKeyManager = require('../utils/api-key-manager')
const { adminKeyVerify } = require('../middlewares/authorization')
const { logger } = require('../utils/logger')

/**
 * Mask a key for display: keep the first 6 and last 4 chars, replace
 * the middle with '****'. Short keys (< 12 chars) are fully masked.
 */
function maskKey(key) {
  if (!key) return ''
  if (key.length <= 12) return '*'.repeat(key.length)
  return `${key.slice(0, 6)}****${key.slice(-4)}`
}

/**
 * GET /api/apiKeys
 * Returns the list of API keys with metadata. Default response masks
 * the actual key values; pass `?reveal=1` to return the raw values
 * (for the operator-only Admin UI when they explicitly toggle visibility).
 */
router.get('/apiKeys', adminKeyVerify, async (req, res) => {
  try {
    // Wait for init to finish so first request after a cold start
    // returns the persisted keys, not just env keys.
    if (apiKeyManager.initPromise) await apiKeyManager.initPromise
    const reveal = req.query.reveal === '1' || req.query.reveal === 'true'
    const list = apiKeyManager.list().map(item => ({
      key: reveal ? item.key : maskKey(item.key),
      keyMasked: maskKey(item.key),
      source: item.source,
      isAdmin: item.isAdmin,
      deletable: item.deletable,
    }))
    res.json({ total: list.length, data: list })
  } catch (err) {
    logger.error('Failed to list API keys', 'APIKEY', '', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/apiKeys
 * Body: { key?: string }
 * If `key` is omitted or empty, the server auto-generates a `sk-...`
 * key. Returns the full key value once on creation so the operator
 * can copy it; subsequent GETs return only the masked form unless
 * reveal=1 is passed.
 */
router.post('/apiKeys', adminKeyVerify, async (req, res) => {
  try {
    if (apiKeyManager.initPromise) await apiKeyManager.initPromise
    const { key } = req.body || {}
    const created = await apiKeyManager.addKey(key)
    res.json({ success: true, key: created, keyMasked: maskKey(created) })
  } catch (err) {
    const msg = err.message || 'Failed to add key'
    const status = /already exists|at least/.test(msg) ? 400 : 500
    if (status === 500) logger.error('Failed to add API key', 'APIKEY', '', err)
    res.status(status).json({ error: msg })
  }
})

/**
 * DELETE /api/apiKeys
 * Body: { key: string }
 * Refuses to delete env-managed keys (including the admin key) — the
 * operator must edit the API_KEY env var to remove those.
 */
router.delete('/apiKeys', adminKeyVerify, async (req, res) => {
  try {
    if (apiKeyManager.initPromise) await apiKeyManager.initPromise
    const { key } = req.body || {}
    if (!key) return res.status(400).json({ error: 'Missing key' })
    await apiKeyManager.removeKey(key)
    res.json({ success: true })
  } catch (err) {
    const msg = err.message || 'Failed to remove key'
    const status = /Cannot delete|not found|Missing/.test(msg) ? 400 : 500
    if (status === 500) logger.error('Failed to remove API key', 'APIKEY', '', err)
    res.status(status).json({ error: msg })
  }
})

module.exports = router
