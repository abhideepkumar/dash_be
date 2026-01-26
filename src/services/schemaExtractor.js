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
 * Extract enum-like columns using PostgreSQL statistics (pg_stats)
 * This identifies columns with low cardinality (≤20 distinct values)
 * and extracts their most common values - all in a SINGLE query
 * 
 * @param {Object} pool - Database pool
 * @returns {Promise<Object>} Map of table -> column -> {distinct_count, values}
 */
async function extractEnumMetadata(pool) {
  console.log('[SCHEMA] Extracting enum metadata from pg_stats...');
  
  const query = `
    SELECT 
      tablename,
      attname AS column_name,
      n_distinct::int AS distinct_count,
      most_common_vals::text AS common_values
    FROM pg_stats
    WHERE schemaname = 'public'
      AND n_distinct > 0
      AND n_distinct <= 20
      AND n_distinct != -1
    ORDER BY tablename, attname;
  `;
  
  try {
    const result = await pool.query(query);
    
    // Group by table -> column
    const enumsByTable = {};
    for (const row of result.rows) {
      if (!enumsByTable[row.tablename]) {
        enumsByTable[row.tablename] = {};
      }
      
      const values = parsePostgresArray(row.common_values);
      if (values.length > 0) {
        enumsByTable[row.tablename][row.column_name] = {
          distinct_count: row.distinct_count,
          values: values
        };
      }
    }
    
    const enumCount = Object.values(enumsByTable).reduce((sum, cols) => sum + Object.keys(cols).length, 0);
    console.log(`[SCHEMA] Found ${enumCount} enum-like columns across ${Object.keys(enumsByTable).length} tables`);
    
    return enumsByTable;
  } catch (error) {
    console.error('[SCHEMA] Error extracting enum metadata:', error.message);
    console.log('[SCHEMA] Note: pg_stats may be empty if ANALYZE has not been run');
    return {};
  }
}

/**
 * Parse PostgreSQL array format {val1,val2,val3} to JS array
 * Handles quoted values and special characters
 */
function parsePostgresArray(pgArray) {
  if (!pgArray) return [];
  
  // Remove outer braces
  let inner = pgArray.trim();
  if (inner.startsWith('{') && inner.endsWith('}')) {
    inner = inner.slice(1, -1);
  }
  
  if (!inner) return [];
  
  // Parse values - handle quoted strings and commas within quotes
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    
    if (char === '"' && (i === 0 || inner[i-1] !== '\\')) {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  
  // Don't forget the last value
  if (current) {
    values.push(current.trim().replace(/^"|"$/g, ''));
  }
  
  // Filter out NULL and empty strings
  return values.filter(v => v && v.toLowerCase() !== 'null');
}

/**
 * Get raw schema for ALL tables in a single pass to avoid N+1 queries
 * Now includes enum metadata from pg_stats
 * @param {string} sessionId - Session identifier
 * @param {function} onProgress - Progress callback (not used for per-table anymore, but kept for signature)
 * @returns {Promise<Array>} Array of table schemas with enum info
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

  // 5. Fetch enum metadata from pg_stats (NEW)
  const [columnsResult, fksResult, pksResult, enumMetadata] = await Promise.all([
    pool.query(columnsQuery, [tables]),
    pool.query(fksQuery, [tables]),
    pool.query(pksQuery, [tables]),
    extractEnumMetadata(pool)
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
      const column = {
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
        default: row.column_default,
        maxLength: row.character_maximum_length
      };
      
      // Check if this column has enum values (NEW)
      const tableEnums = enumMetadata[row.table_name];
      if (tableEnums && tableEnums[row.column_name]) {
        column.is_enum = true;
        column.enum_values = tableEnums[row.column_name].values;
      }
      
      schemaMap[row.table_name].columns.push(column);
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
