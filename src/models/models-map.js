const accountManager = require('../utils/account.js')
const { logger } = require('../utils/logger')
const { http2Request } = require('../utils/http2-client')

let cachedModels = null
let cacheTime = 0
let fetchPromise = null
const CACHE_TTL = 30 * 60 * 1000 // 30 minutes

const getLatestModels = async (force = false) => {
    // If cached, not forcing refresh, and cache is still fresh, return cache
    if (cachedModels && !force && (Date.now() - cacheTime < CACHE_TTL)) {
        return cachedModels
    }

    // If already fetching, return current promise
    if (fetchPromise) {
        return fetchPromise
    }

    const token = accountManager.getAccountToken()
    // Get cookies from the first valid account for the models request
    const accounts = accountManager.accountTokens || []
    const firstValid = accounts.find(a => a.token && !a.disabled)
    const cookies = (firstValid && firstValid.cookies) || ''

    fetchPromise = http2Request('GET', '/api/models', null, token, cookies, {
        timeout: 15000,
    }).then(({ status, data }) => {
        if (status === 200 && data && data.data) {
            cachedModels = data.data
            cacheTime = Date.now()
        } else {
            logger.warn(`[MODELS] Failed to fetch models, status=${status}`, 'MODELS')
            if (cachedModels) return cachedModels
            cachedModels = []
        }
        fetchPromise = null
        return cachedModels
    }).catch(error => {
        logger.error(`Error fetching latest models: ${error.message}`, 'MODELS')
        fetchPromise = null
        // If we have stale cache, return it rather than empty
        if (cachedModels) return cachedModels
        return []
    })

    return fetchPromise
}

/**
 * Clear model cache (useful when accounts change or for manual refresh)
 */
const clearModelCache = () => {
    cachedModels = null
    cacheTime = 0
}

/**
 * Get default model by chat type
 * @param {string} chatType - Chat type
 * @returns {Promise<string|null>} Default model ID
 */
const getDefaultModelByChatType = async (chatType) => {
    const models = await getLatestModels()
    const matchedModel = models.find(model => model?.info?.meta?.chat_type?.includes(chatType))
    return matchedModel?.id?.toLowerCase() || null
}

module.exports = {
    getLatestModels,
    getDefaultModelByChatType,
    clearModelCache
}
