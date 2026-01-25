import pg from 'pg';

const { Pool } = pg;

// Store active connection pools by session
const connectionPools = new Map();

/**
 * Create a new PostgreSQL connection pool
 * @param {string} sessionId - Unique session identifier
 * @param {object} config - Database configuration
 * @param {string} config.host - Database host
 * @param {number} config.port - Database port
 * @param {string} config.database - Database name
 * @param {string} config.user - Database user
 * @param {string} config.password - Database password
 * @returns {pg.Pool} PostgreSQL pool instance
 */
export function createPool(sessionId, config) {
  // Close existing pool if any
  if (connectionPools.has(sessionId)) {
    connectionPools.get(sessionId).end();
  }

  const pool = new Pool({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  connectionPools.set(sessionId, pool);
  return pool;
}

/**
 * Get existing pool for a session
 * @param {string} sessionId - Unique session identifier
 * @returns {pg.Pool|null} PostgreSQL pool instance or null
 */
export function getPool(sessionId) {
  return connectionPools.get(sessionId) || null;
}

/**
 * Test database connection
 * @param {object} config - Database configuration
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testConnection(config) {
  const pool = new Pool({
    host: config.host,
    port: config.port || 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    await pool.end();
    return { success: true, message: 'Connection successful' };
  } catch (error) {
    await pool.end();
    return { success: false, message: error.message };
  }
}

/**
 * Close pool for a session
 * @param {string} sessionId - Unique session identifier
 */
export async function closePool(sessionId) {
  if (connectionPools.has(sessionId)) {
    await connectionPools.get(sessionId).end();
    connectionPools.delete(sessionId);
  }
}
