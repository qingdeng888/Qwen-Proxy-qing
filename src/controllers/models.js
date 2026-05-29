const { getLatestModels } = require('../models/models-map.js')
const config = require('../config/index.js')

/**
 * Build public model data
 * @param {object} model - Original model info
 * @param {string} suffix - Variant suffix
 * @returns {object} Public model info
 */
const buildPublicModelData = (model, suffix = '') => {
    const modelData = JSON.parse(JSON.stringify(model))
    const upstreamModelID = String(model?.id || '')
    const displayModelID = String(model?.name || model?.id || '')

    // Force lowercase for compatibility with clients that don't support uppercase model names
    modelData.id = `${displayModelID}${suffix}`.toLowerCase()
    modelData.name = `${upstreamModelID}${suffix}`.toLowerCase()
    modelData.upstream_id = upstreamModelID
    modelData.display_name = displayModelID

    // Keep nested info.id / info.name in sync with the public id/name so
    // clients that look at either field see the same suffix-aware value.
    // The original upstream id (without suffix) is preserved in upstream_id.
    if (modelData.info && typeof modelData.info === 'object') {
        modelData.info.id = modelData.id
        modelData.info.name = modelData.name
    }

    return modelData
}

const handleGetModels = async (req, res) => {
    const models = []

    const ModelsMap = await getLatestModels()

    for (const model of ModelsMap) {
        models.push(buildPublicModelData(model))

        if (config.simpleModelMap) {
            continue
        }

        // Compatible with both old (abilities) and new (capabilities) API structures
        const meta = model?.info?.meta || {}
        const caps = meta.capabilities || {}
        const abilities = meta.abilities || {}
        const chatTypes = meta.chat_type || []

        const isThinking = !!(caps.thinking || abilities.thinking)
        const isSearch = !!(caps.search || chatTypes.includes('search'))
        const isImage = chatTypes.includes('t2i')
        const isVideo = chatTypes.includes('t2v')
        const isImageEdit = chatTypes.includes('image_edit')
        const isDeepResearch = chatTypes.includes('deep_research')
        const isWebDev = chatTypes.includes('web_dev')
        const isSlides = chatTypes.includes('slides')

        if (isThinking) {
            models.push(buildPublicModelData(model, '-thinking'))
        }

        if (isSearch) {
            models.push(buildPublicModelData(model, '-search'))
        }

        if (isThinking && isSearch) {
            models.push(buildPublicModelData(model, '-thinking-search'))
        }

        if (isImage) {
            models.push(buildPublicModelData(model, '-image'))
        }

        if (isVideo) {
            models.push(buildPublicModelData(model, '-video'))
        }

        if (isImageEdit) {
            models.push(buildPublicModelData(model, '-image-edit'))
        }

        if (isDeepResearch) {
            models.push(buildPublicModelData(model, '-deep-research'))
        }

        if (isWebDev) {
            models.push(buildPublicModelData(model, '-webdev'))
        }

        if (isSlides) {
            models.push(buildPublicModelData(model, '-slides'))
        }
    }

    res.json({
        "object": "list",
        "data": models
    })
}

module.exports = {
    handleGetModels
}
