import crypto from 'crypto';

// Encryption key - should be 32 bytes for AES-256
// In production, this MUST be set via environment variable
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-32-byte-encryption-key!!'; // 32 chars

/**
 * Encrypt a string using AES-256-CBC
 * @param {string} text - Plain text to encrypt
 * @returns {string} Encrypted string (iv:encrypted format)
 */
export function encrypt(text) {
  if (!text) return text;
  
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(ENCRYPTION_KEY, 'utf8').slice(0, 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a string encrypted with encrypt()
 * @param {string} text - Encrypted string (iv:encrypted format)
 * @returns {string} Decrypted plain text
 */
export function decrypt(text) {
  if (!text || !text.includes(':')) return text;
  
  try {
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = Buffer.from(ENCRYPTION_KEY, 'utf8').slice(0, 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('[ENCRYPTION] Decryption failed:', error.message);
    return null;
  }
}

/**
 * Mask a value for display (e.g., "postgres" → "pos***es")
 * @param {string} value - Value to mask
 * @returns {string} Masked value
 */
export function maskValue(value) {
  if (!value || value.length < 4) return '***';
  
  if (value.length <= 6) {
    return value.slice(0, 2) + '***';
  }
  
  return value.slice(0, 3) + '***' + value.slice(-2);
}

/**
 * Encrypt database config fields
 * @param {object} config - DB config with plain text values
 * @returns {object} Config with encrypted sensitive fields
 */
export function encryptDbConfig(config) {
  return {
    host: encrypt(config.host),
    port: config.port || 5432,
    database: config.database, // Not encrypted - needed for display
    user: encrypt(config.user),
    password: encrypt(config.password)
  };
}

/**
 * Decrypt database config fields
 * @param {object} config - DB config with encrypted values
 * @returns {object} Config with decrypted values
 */
export function decryptDbConfig(config) {
  return {
    host: decrypt(config.host),
    port: config.port,
    database: config.database,
    user: decrypt(config.user),
    password: decrypt(config.password)
  };
}
