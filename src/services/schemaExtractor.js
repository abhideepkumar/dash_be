import { getPool } from '../config/db.js';

/**
 * Get all user tables from PostgreSQL
 * @param {string} sessionId - Session identifier
 * @returns {Promise<string[]>} Array of table names
 */
export async function getAllTables(sessionId) {
  const pool = getPool(sessionId);
  if (!pool) throw new Error('No database connection for this session');

  const query = `
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `;

  const result = await pool.query(query);
  return result.rows.map(row => row.table_name);
}

/**
 * Get raw schema for ALL tables in a single pass to avoid N+1 queries
 * @param {string} sessionId - Session identifier
 * @param {function} onProgress - Progress callback (not used for per-table anymore, but kept for signature)
 * @returns {Promise<Array>} Array of table schemas
 */
export async function getFullSchema(sessionId, onProgress = null) {
  const pool = getPool(sessionId);
  if (!pool) throw new Error('No database connection for this session');

  // 1. Fetch tables
  const tables = await getAllTables(sessionId);
  
  if (tables.length === 0) {
    return [];
  }

  // 2. Fetch ALL columns
  const columnsQuery = `
    SELECT 
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default,
      character_maximum_length
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = ANY($1)
    ORDER BY table_name, ordinal_position;
  `;
  
  // 3. Fetch ALL foreign keys
  const fksQuery = `
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table,
      ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu 
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = ANY($1);
  `;

  // 4. Fetch ALL primary keys
  const pksQuery = `
    SELECT 
      tc.table_name,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = ANY($1);
  `;

  const [columnsResult, fksResult, pksResult] = await Promise.all([
    pool.query(columnsQuery, [tables]),
    pool.query(fksQuery, [tables]),
    pool.query(pksQuery, [tables])
  ]);

  // Group by table
  const schemaMap = {};
  
  tables.forEach(table => {
    schemaMap[table] = {
      table,
      columns: [],
      foreignKeys: [],
      primaryKeys: []
    };
  });

  columnsResult.rows.forEach(row => {
    if (schemaMap[row.table_name]) {
      schemaMap[row.table_name].columns.push({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
        default: row.column_default,
        maxLength: row.character_maximum_length
      });
    }
  });

  fksResult.rows.forEach(row => {
    if (schemaMap[row.table_name]) {
      schemaMap[row.table_name].foreignKeys.push({
        column: row.column_name,
        references: `${row.foreign_table}.${row.foreign_column}`
      });
    }
  });

  pksResult.rows.forEach(row => {
    if (schemaMap[row.table_name]) {
      schemaMap[row.table_name].primaryKeys.push(row.column_name);
    }
  });

  return Object.values(schemaMap);
}
