const crypto = require('crypto')
const { jwtDecode } = require('jwt-decode')
const { logger } = require('./logger')

const isJson = (str) => {
  try {
    JSON.parse(str)
    return true
  } catch (error) {
    return false
  }
}

const sleep = async (ms) => {
  return await new Promise(resolve => setTimeout(resolve, ms))
}

const sha256Encrypt = (text) => {
  if (typeof text !== 'string') {
    logger.error('Input must be a string', 'TOOLS')
    throw new Error('Input must be a string')
  }
  const hash = crypto.createHash('sha256')
  hash.update(text, 'utf-8')
  return hash.digest('hex')
}

const JwtDecode = (token) => {
  try {
    const decoded = jwtDecode(token, { complete: true })
    return decoded
  } catch (error) {
    logger.error('Failed to decode JWT', 'JWT', '', error)
    return null
  }
}

/**
 * Generate UUID v4
 * @returns {string} UUID v4 string
 */
const generateUUID = () => {
  return crypto.randomUUID()
}

/**
 * Mask an API key for display.
 *
 * Always surfaces the last 3 characters so operators can tell distinct
 * keys apart in the usage table — the previous all-asterisks form for
 * short keys made same-length keys visually identical.
 *
 *   len ≤ 4   → fully masked (too short to safely show)
 *   5..10     → asterisks + last 3       e.g. 'sk-test' → '****est'
 *   ≥ 11      → first 4 + **** + last 4  e.g. 'sk-1234567890abcdef' → 'sk-1****cdef'
 *
 * @param {string} key
 * @returns {string}
 */
const maskApiKey = (key) => {
  if (!key) return ''
  const len = key.length
  if (len <= 4) return '*'.repeat(len)
  if (len <= 10) return '*'.repeat(len - 3) + key.slice(-3)
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

module.exports = {
  isJson,
  sleep,
  sha256Encrypt,
  JwtDecode,
  generateUUID,
  maskApiKey,
}
