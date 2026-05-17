const express = require('express')
const router = express.Router()
const usageTracker = require('../utils/usage-tracker')
const apiKeyManager = require('../utils/api-key-manager')
const accountManager = require('../utils/account.js')
const { adminKeyVerify } = require('../middlewares/authorization')
const { logger } = require('../utils/logger')

/**
 * GET /api/usage
 *
 * Returns the full usage snapshot:
 *   {
 *     apiKeys:  [{ id, keyMasked, source, isAdmin,
 *                  totalRequests, successRequests, failedRequests,
 *                  promptTokens, completionTokens, lastUsed }],
 *     accounts: [{ email, totalRequests, ... }],
 *     summary:  { ... }
 *   }
 *
 * The snapshot joins the live api-key list (from apiKeyManager) so each
 * row has a stable display label. Buckets for keys that no longer exist
 * are tagged source='orphan' so the operator can clean them up.
 */
router.get('/usage', adminKeyVerify, async (req, res) => {
  try {
    if (usageTracker.initPromise) await usageTracker.initPromise
    if (apiKeyManager.initPromise) await apiKeyManager.initPromise

    const knownKeys = apiKeyManager.list()
    const snap = usageTracker.snapshot(knownKeys)

    // Cross-reference accounts with the current roster so the UI can
    // mark "stats for an account that has been deleted".
    const liveEmails = new Set((accountManager.getAllAccountKeys() || []).map(a => a.email))
    const accounts = snap.accounts.map(a => ({
      ...a,
      exists: liveEmails.has(a.email),
    }))

    const sumOf = (rows) => rows.reduce((acc, r) => {
      acc.totalRequests += r.totalRequests || 0
      acc.successRequests += r.successRequests || 0
      acc.failedRequests += r.failedRequests || 0
      acc.promptTokens += r.promptTokens || 0
      acc.completionTokens += r.completionTokens || 0
      return acc
    }, { totalRequests: 0, successRequests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0 })

    const summary = {
      apiKeys: sumOf(snap.apiKeys),
      accounts: sumOf(accounts),
    }

    res.json({ apiKeys: snap.apiKeys, accounts, summary })
  } catch (err) {
    logger.error('Failed to load usage stats', 'USAGE', '', err)
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /api/usage/reset
 *
 * Body:
 *   { scope: 'all' }                  → wipe everything
 *   { scope: 'apikey', id }           → reset one api-key bucket by id (from snapshot)
 *   { scope: 'apikey', apiKey }       → reset by raw key value (alternative)
 *   { scope: 'account', email }       → reset one account bucket
 */
router.post('/usage/reset', adminKeyVerify, async (req, res) => {
  try {
    if (usageTracker.initPromise) await usageTracker.initPromise

    const body = req.body || {}
    const scope = body.scope || 'all'
    if (!['all', 'apikey', 'account'].includes(scope)) {
      return res.status(400).json({ error: 'Invalid scope' })
    }
    if (scope === 'apikey' && !body.id && !body.apiKey) {
      return res.status(400).json({ error: 'apikey scope requires id or apiKey' })
    }
    if (scope === 'account' && !body.email) {
      return res.status(400).json({ error: 'account scope requires email' })
    }

    await usageTracker.reset({
      scope,
      id: body.id || null,
      apiKey: body.apiKey || null,
      email: body.email || null,
    })

    res.json({ success: true })
  } catch (err) {
    logger.error('Failed to reset usage stats', 'USAGE', '', err)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
