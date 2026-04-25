import { getPool } from '../config/db.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * ENTERPRISE SCHEMA EXTRACTOR
 * ═══════════════════════════════════════════════════════════════
 * 
 * Produces a canonical metadata structure per table that flows
 * unchanged through every layer:
 * 
 *   PostgreSQL → schemaExtractor → syncService → MongoDB
 *                                              → Pinecone
 *                                              → schemaGraph
 *                                              → queryProcessor (LLM prompts)
 * 
 * Design principles:
 *   1. Column is the atom — all intelligence is inline per column
 *   2. Zero duplication — no separate measures/dimensions arrays
 *   3. Self-describing — each column knows its role, stats, values
 *   4. Table is self-classifying — fact/dimension/bridge/standalone
 *   5. Time-aware — freshness and boundaries set once, used everywhere
 *   6. Generic — zero dataset-specific logic
 * ═══════════════════════════════════════════════════════════════
 */

// ============================================
// CONSTANTS & CLASSIFICATION RULES
// ============================================

/**
 * Semantic roles a column can have. Every downstream consumer
 * switches behavior based on this single field.
 * @readonly
 * @enum {string}
 */
export const SemanticRole = {
  MEASURE: 'measure',       // Numeric → SUM/AVG/COUNT in SQL
  DIMENSION: 'dimension',   // Categorical → GROUP BY in SQL
  KEY: 'key',               // PK/FK → JOIN ON in SQL
  TIMESTAMP: 'timestamp',   // Date/time → WHERE/filter in SQL
  METADATA: 'metadata',     // System audit → NEVER in SQL
};

/**
 * Table classifications. Drives SQL FROM/JOIN decisions.
 * @readonly 
 * @enum {string}
 */
export const TableType = {
  FACT: 'fact',             // Contains measures + FKs to dimensions → goes in FROM
  DIMENSION: 'dimension',   // Referenced by facts, has labels → goes in JOIN
  BRIDGE: 'bridge',         // Junction table → multiple FKs, few own columns
  STANDALONE: 'standalone',  // No FK relationships
};

// --- Type sets ---
const NUMERIC_TYPES = new Set([
  'integer', 'bigint', 'smallint',
  'numeric', 'decimal', 'real', 'double precision',
  'money', 'serial', 'bigserial', 'smallserial',
]);

const TEMPORAL_TYPES = new Set([
  'timestamp without time zone', 'timestamp with time zone',
  'date', 'time without time zone', 'time with time zone',
  'interval',
]);

const TEXT_TYPES = new Set([
  'character varying', 'character', 'text',
  'varchar', 'char', 'name',
]);

/** Types that should NEVER qualify as enums */
const ENUM_EXCLUDED_TYPES = new Set([
  ...NUMERIC_TYPES, ...TEMPORAL_TYPES,
  'boolean', 'bytea', 'uuid',
  'json', 'jsonb', 'xml',
  'inet', 'cidr', 'macaddr',
]);

// --- Name pattern rules ---
const METADATA_COLUMN_PATTERNS = [
  /^created_at$/i, /^updated_at$/i, /^deleted_at$/i,
  /^modified_at$/i, /^inserted_at$/i, /^last_modified$/i,
  /^sys_/i, /^__/, /^_etl_/i, /^row_version$/i,
];

const MEASURE_NAME_PATTERNS = [
  /amount$/i, /price$/i, /cost$/i, /total$/i, /sum$/i,
  /revenue$/i, /profit$/i, /sales$/i, /discount$/i,
  /balance$/i, /budget$/i, /fee$/i, /tax$/i,
  /quantity$/i, /qty$/i,
  /weight$/i, /height$/i, /width$/i, /length$/i, /area$/i, /volume$/i,
  /score$/i, /rating$/i, /rank$/i,
  /rate$/i, /ratio$/i, /percent$/i, /pct$/i, /percentage$/i,
  /salary$/i, /wage$/i, /income$/i, /expense$/i,
  /^num_/i, /^total_/i, /^avg_/i, /^sum_/i, /^count_/i, /^net_/i, /^gross_/i,
];

const NON_MEASURE_NUMERIC_PATTERNS = [
  /id$/i, /code$/i, /number$/i, /^is_/i, /^has_/i, /^flag_/i,
  /zip/i, /postal/i, /phone/i, /fax/i,
];

const ENUM_EXCLUDED_NAME_PATTERNS = [
  /_id$/i, /^id$/i, /_at$/i, /_date$/i, /_time$/i, /_timestamp$/i,
  /_count$/i, /_amount$/i, /_price$/i, /_cost$/i, /_total$/i,
  /_qty$/i, /_quantity$/i, /_rate$/i, /_percent$/i, /_pct$/i,
  /^quantity$/i, /^amount$/i, /^price$/i, /^cost$/i, /^total$/i,
  /^discount$/i, /^profit$/i, /^revenue$/i, /^balance$/i,
];

// ============================================
// COLUMN CLASSIFICATION
// ============================================

/**
 * Infer the recommended aggregation function for a measure column.
 */
function inferAggregation(name) {
  const n = name.toLowerCase();
  if (/rate$|ratio$|percent$|pct$|percentage$|score$|rating$/i.test(n)) return 'avg';
  return 'sum';
}

/**
 * Classify a single column's semantic role.
 * Returns classification fields to merge into the column object.
 * 
 * @param {string} name - Column name
 * @param {string} dataType - PostgreSQL data type (lowercased)
 * @param {boolean} isPK - Is primary key
 * @param {boolean} isFK - Is foreign key
 * @param {string|null} fkTarget - FK target "table.column" or null
 * @returns {Object} Fields to merge: { semantic_role, aggregation?, references? }
 */
function classifyColumn(name, dataType, isPK, isFK, fkTarget) {
  // Priority 1: System metadata columns
  if (METADATA_COLUMN_PATTERNS.some(p => p.test(name))) {
    return { semantic_role: SemanticRole.METADATA };
  }

  // Priority 2: Keys
  if (isPK || isFK) {
    const result = { semantic_role: SemanticRole.KEY, is_primary_key: isPK, is_foreign_key: isFK };
    if (fkTarget) result.references = fkTarget;
    return result;
  }

  // Priority 3: Temporal
  if (TEMPORAL_TYPES.has(dataType)) {
    return { semantic_role: SemanticRole.TIMESTAMP };
  }

  // Priority 4: Numeric → measure or dimension-like
  if (NUMERIC_TYPES.has(dataType)) {
    if (NON_MEASURE_NUMERIC_PATTERNS.some(p => p.test(name))) {
      return { semantic_role: SemanticRole.DIMENSION };
    }
    return {
      semantic_role: SemanticRole.MEASURE,
      aggregation: inferAggregation(name),
    };
  }

  // Priority 5: Everything else → dimension
  return { semantic_role: SemanticRole.DIMENSION };
}

// ============================================
// TABLE CLASSIFICATION
// ============================================

/**
 * Classify a table as fact/dimension/bridge/standalone based on its structure.
 * 
 * Rules (generic, works for any schema):
 *   fact = has outgoing FKs AND has at least 1 measure column
 *   dimension = has NO outgoing FKs (is referenced by other tables via PKs)
 *   bridge = has 2+ FKs AND very few non-FK columns
 *   standalone = no FK relationships at all
 */
function classifyTable(columns, fkCount) {
  const measureCount = columns.filter(c => c.semantic_role === SemanticRole.MEASURE).length;
  const nonKeyColumns = columns.filter(c => c.semantic_role !== SemanticRole.KEY && c.semantic_role !== SemanticRole.METADATA).length;
  
  if (fkCount === 0) {
    return measureCount > 0 ? TableType.STANDALONE : TableType.DIMENSION;
  }
  
  // Bridge: mostly FKs, very few own attributes
  if (fkCount >= 2 && nonKeyColumns <= 2) {
    return TableType.BRIDGE;
  }
  
  // Fact: has FKs (to dimensions) AND has measures
  if (fkCount > 0 && measureCount > 0) {
    return TableType.FACT;
  }
  
  // Dimension with FKs (snowflake schema)
  return TableType.DIMENSION;
}

// ============================================
// ENUM DETECTION
// ============================================

function isEnumExcluded(columnName, dataType) {
  if (ENUM_EXCLUDED_TYPES.has(dataType.toLowerCase())) return true;
  return ENUM_EXCLUDED_NAME_PATTERNS.some(p => p.test(columnName));
}

/**
 * Extract enum-like columns from pg_stats. Type-aware filtering.
 */
async function extractEnumMetadata(pool) {
  console.log('[SCHEMA] Extracting enum metadata (type-aware)...');
  const query = `
    SELECT 
      ps.tablename, ps.attname AS column_name,
      ps.n_distinct::int AS distinct_count,
      ps.most_common_vals::text AS common_values,
      cols.data_type
    FROM pg_stats ps
    JOIN information_schema.columns cols
      ON cols.table_schema = 'public'
      AND cols.table_name = ps.tablename
      AND cols.column_name = ps.attname
    WHERE ps.schemaname = 'public'
      AND ps.n_distinct > 0 AND ps.n_distinct <= 20 AND ps.n_distinct != -1
    ORDER BY ps.tablename, ps.attname;
  `;
  try {
    const result = await pool.query(query);
    const enumsByTable = {};
    let skipped = 0;
    for (const row of result.rows) {
      if (isEnumExcluded(row.column_name, row.data_type)) { skipped++; continue; }
      if (!enumsByTable[row.tablename]) enumsByTable[row.tablename] = {};
      const values = parsePostgresArray(row.common_values);
      if (values.length > 0) {
        enumsByTable[row.tablename][row.column_name] = values;
      }
    }
    const count = Object.values(enumsByTable).reduce((s, c) => s + Object.keys(c).length, 0);
    console.log(`[SCHEMA] Found ${count} enums (skipped ${skipped} non-categorical)`);
    return enumsByTable;
  } catch (error) {
    console.warn('[SCHEMA] Enum extraction failed:', error.message);
    return {};
  }
}

function parsePostgresArray(pgArray) {
  if (!pgArray) return [];
  let inner = pgArray.trim();
  if (inner.startsWith('{') && inner.endsWith('}')) inner = inner.slice(1, -1);
  if (!inner) return [];
  const values = [];
  let current = '', inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && (i === 0 || inner[i-1] !== '\\')) inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { values.push(current.trim().replace(/^"|"$/g, '')); current = ''; }
    else current += ch;
  }
  if (current) values.push(current.trim().replace(/^"|"$/g, ''));
  return values.filter(v => v && v.toLowerCase() !== 'null');
}

// ============================================
// DATA PROFILING
// ============================================

/**
 * Profile all columns that need statistical context.
 * Runs during sync to capture date ranges and measure statistics.
 */
async function profileColumns(pool, schemas) {
  console.log('[SCHEMA] Profiling column statistics...');

  // 1. Row counts (instant from pg_class — no table scan)
  const tables = schemas.map(s => s.table);
  const rowCounts = {};
  try {
    const res = await pool.query(`
      SELECT relname AS table_name, GREATEST(reltuples::bigint, 0) AS row_count
      FROM pg_class WHERE relname = ANY($1) AND relkind = 'r';
    `, [tables]);
    for (const r of res.rows) rowCounts[r.table_name] = parseInt(r.row_count, 10) || 0;
  } catch (e) { console.warn('[SCHEMA] Row count failed:', e.message); }

  // 2. Build per-column profiling queries
  const profileTasks = [];
  for (const schema of schemas) {
    for (const col of schema.columns) {
      if (col.semantic_role === SemanticRole.TIMESTAMP) {
        profileTasks.push({ table: schema.table, column: col.name, type: 'timestamp' });
      } else if (col.semantic_role === SemanticRole.MEASURE) {
        profileTasks.push({ table: schema.table, column: col.name, type: 'measure' });
      }
    }
  }

  // Execute profiling in parallel batches
  const profileResults = {};
  const BATCH_SIZE = 10;
  for (let i = 0; i < profileTasks.length; i += BATCH_SIZE) {
    const batch = profileTasks.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async ({ table, column, type }) => {
      try {
        if (type === 'timestamp') {
          const res = await pool.query(
            `SELECT MIN("${column}")::text AS min_val, MAX("${column}")::text AS max_val FROM "${table}"`
          );
          return { table, column, type, min: res.rows[0]?.min_val, max: res.rows[0]?.max_val };
        } else {
          const res = await pool.query(
            `SELECT MIN("${column}")::numeric::text AS min_val, MAX("${column}")::numeric::text AS max_val, AVG("${column}")::numeric(15,2)::text AS avg_val FROM "${table}"`
          );
          return {
            table, column, type,
            min: parseFloat(res.rows[0]?.min_val) || null,
            max: parseFloat(res.rows[0]?.max_val) || null,
            avg: parseFloat(res.rows[0]?.avg_val) || null,
          };
        }
      } catch (e) {
        return { table, column, type, error: e.message };
      }
    });
    const results = await Promise.all(promises);
    for (const r of results) {
      if (!r.error) {
        const key = `${r.table}.${r.column}`;
        profileResults[key] = r;
      }
    }
  }

  console.log(`[SCHEMA] Profiled ${Object.keys(profileResults).length} columns, ${Object.keys(rowCounts).length} table row counts`);
  return { rowCounts, profileResults };
}

// ============================================
// DATA FRESHNESS DETECTION
// ============================================

/**
 * Determine data freshness based on the most recent timestamp column.
 * Returns the primary time boundary for the table.
 */
function detectFreshness(columns, syncTime) {
  // Find all timestamp columns with profiled ranges
  const timestamps = columns.filter(c => c.semantic_role === SemanticRole.TIMESTAMP && c.stats?.max);
  if (timestamps.length === 0) return { freshness: 'unknown', time_boundary: null };

  // Pick the primary time column: prefer business dates, then most recent max
  const sorted = [...timestamps].sort((a, b) => {
    const aDate = new Date(a.stats.max);
    const bDate = new Date(b.stats.max);
    return bDate - aDate; // Most recent first
  });
  
  const primary = sorted[0];
  const maxDate = new Date(primary.stats.max);
  const minDate = new Date(primary.stats.min);
  const syncDate = new Date(syncTime);
  const daysSinceLatest = Math.floor((syncDate - maxDate) / (1000 * 60 * 60 * 24));
  const spanDays = Math.floor((maxDate - minDate) / (1000 * 60 * 60 * 24));

  return {
    freshness: daysSinceLatest <= 30 ? 'live' : 'historical',
    time_boundary: {
      column: primary.name,
      min: primary.stats.min,
      max: primary.stats.max,
      span_days: spanDays,
      days_since_latest: daysSinceLatest,
    }
  };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Get all user tables from PostgreSQL
 */
export async function getAllTables(sessionId) {
  const pool = getPool(sessionId);
  if (!pool) throw new Error('No database connection for this session');
  const result = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
  `);
  return result.rows.map(r => r.table_name);
}

/**
 * Extract the complete, canonical metadata for all tables.
 * 
 * Output shape per table:
 * {
 *   table: string,
 *   table_type: "fact" | "dimension" | "bridge" | "standalone",
 *   description: string,        // Set by LLM during enrichment (empty here)
 *   common_queries: string[],   // Set by LLM during enrichment (empty here)
 *
 *   profile: {
 *     row_count: number,
 *     synced_at: string (ISO),
 *     freshness: "live" | "historical" | "unknown",
 *     time_boundary: { column, min, max, span_days, days_since_latest } | null
 *   },
 *
 *   columns: [
 *     {
 *       name: string,
 *       data_type: string,
 *       nullable: boolean,
 *       semantic_role: "measure" | "dimension" | "key" | "timestamp" | "metadata",
 *       meaning: string,        // Set by LLM (defaults to name)
 *       
 *       // Conditional fields (only present when applicable):
 *       is_primary_key: boolean, // Only on keys
 *       is_foreign_key: boolean, // Only on keys
 *       references: string,     // Only on FKs: "target_table.column"
 *       aggregation: string,    // Only on measures: "sum" | "avg" | "count" | "max"
 *       enum_values: string[],  // Only on dimensions with valid value lists
 *       stats: {                // Only on measures and timestamps
 *         min: any, max: any, avg?: number
 *       }
 *     }
 *   ],
 *
 *   relationships: [
 *     { column, references_table, references_column, cardinality }
 *   ]
 * }
 */
export async function getFullSchema(sessionId, onProgress = null) {
  const pool = getPool(sessionId);
  if (!pool) throw new Error('No database connection for this session');

  const tables = await getAllTables(sessionId);
  if (tables.length === 0) return [];

  const syncTime = new Date().toISOString();

  // Parallel fetch: columns, FKs, PKs, enums
  const [columnsResult, fksResult, pksResult, enumMetadata] = await Promise.all([
    pool.query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position;
    `, [tables]),
    pool.query(`
      SELECT tc.table_name, kcu.column_name,
             ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND tc.table_name = ANY($1);
    `, [tables]),
    pool.query(`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = ANY($1);
    `, [tables]),
    extractEnumMetadata(pool),
  ]);

  // Build lookup maps
  const pkSet = new Set();
  const fkMap = new Map(); // "table.column" -> "foreign_table.foreign_column"
  const fkCountByTable = {};
  const relationships = {};

  pksResult.rows.forEach(r => pkSet.add(`${r.table_name}.${r.column_name}`));
  fksResult.rows.forEach(r => {
    const key = `${r.table_name}.${r.column_name}`;
    fkMap.set(key, `${r.foreign_table}.${r.foreign_column}`);
    fkCountByTable[r.table_name] = (fkCountByTable[r.table_name] || 0) + 1;
    if (!relationships[r.table_name]) relationships[r.table_name] = [];
    relationships[r.table_name].push({
      column: r.column_name,
      references_table: r.foreign_table,
      references_column: r.foreign_column,
      cardinality: 'many_to_one', // FK source → FK target is always many:1
    });
  });

  // Build canonical schema map
  const schemaMap = {};
  tables.forEach(t => {
    schemaMap[t] = {
      table: t,
      table_type: null,       // Set after column classification
      description: '',        // Set by LLM during enrichment
      common_queries: [],     // Set by LLM during enrichment
      profile: { row_count: 0, synced_at: syncTime, freshness: 'unknown', time_boundary: null },
      columns: [],
      relationships: relationships[t] || [],
    };
  });

  // Classify and build columns
  columnsResult.rows.forEach(r => {
    if (!schemaMap[r.table_name]) return;
    
    const qualifiedKey = `${r.table_name}.${r.column_name}`;
    const isPK = pkSet.has(qualifiedKey);
    const isFK = fkMap.has(qualifiedKey);
    const fkTarget = fkMap.get(qualifiedKey) || null;
    const dataType = r.data_type.toLowerCase();

    // Classify the column
    const classification = classifyColumn(r.column_name, dataType, isPK, isFK, fkTarget);

    // Build the canonical column object
    const column = {
      name: r.column_name,
      data_type: r.data_type,
      nullable: r.is_nullable === 'YES',
      semantic_role: classification.semantic_role,
      meaning: r.column_name.replace(/_/g, ' '), // Default; overwritten by LLM
    };

    // Attach conditional fields (only when applicable)
    if (classification.is_primary_key) column.is_primary_key = true;
    if (classification.is_foreign_key) column.is_foreign_key = true;
    if (classification.references) column.references = classification.references;
    if (classification.aggregation) column.aggregation = classification.aggregation;

    // Attach enum values (only for qualified dimension columns)
    const tableEnums = enumMetadata[r.table_name];
    if (tableEnums && tableEnums[r.column_name]) {
      column.enum_values = tableEnums[r.column_name];
    }

    schemaMap[r.table_name].columns.push(column);
  });

  // Convert to array for profiling
  const schemasArray = Object.values(schemaMap);

  // Profile columns (date ranges, measure stats)
  const { rowCounts, profileResults } = await profileColumns(pool, schemasArray);

  // Merge profiling data into columns and tables
  for (const schema of schemasArray) {
    // Row count
    schema.profile.row_count = rowCounts[schema.table] || 0;

    // Per-column stats
    for (const col of schema.columns) {
      const key = `${schema.table}.${col.name}`;
      const profileData = profileResults[key];
      if (profileData) {
        if (profileData.type === 'timestamp') {
          col.stats = { min: profileData.min, max: profileData.max };
        } else if (profileData.type === 'measure') {
          col.stats = { min: profileData.min, max: profileData.max, avg: profileData.avg };
        }
      }
    }

    // Table type classification
    schema.table_type = classifyTable(schema.columns, fkCountByTable[schema.table] || 0);

    // Data freshness detection
    const { freshness, time_boundary } = detectFreshness(schema.columns, syncTime);
    schema.profile.freshness = freshness;
    schema.profile.time_boundary = time_boundary;
  }

  console.log(`[SCHEMA] Extraction complete: ${schemasArray.length} tables`);
  schemasArray.forEach(s => {
    const measures = s.columns.filter(c => c.semantic_role === 'measure').map(c => c.name).join(', ');
    console.log(`  ${s.table_type.padEnd(10)} ${s.table} (${s.profile.row_count} rows, freshness: ${s.profile.freshness}, measures: ${measures || 'none'})`);
  });

  return schemasArray;
}

// ============================================
// PROMPT SERIALIZATION HELPERS
// ============================================
// These turn canonical metadata into the exact text each LLM call needs.
// No ad-hoc formatting in queryProcessor — it calls these.

/**
 * Serialize a table's metadata for the ANSWERABILITY prompt.
 * Compact format: focuses on what questions CAN be answered.
 * 
 * Example output:
 *   fact_order_line_item (fact, ~9994 rows, historical: 2020-01-03 to 2023-12-30)
 *     Measures: sales_amount (SUM), profit_amount (SUM), discount_percent (AVG), quantity (SUM)
 *     Dimensions: (via dim_product) category, sub_category, product_name
 *     Time: order_date (2020-01-03 to 2023-12-30)
 */
export function serializeForAnswerability(table) {
  const header = `${table.table} [${table.table_type}] — ${table.description || table.table}`;
  const lines = [header];

  // Measures
  const measures = table.columns.filter(c => c.semantic_role === 'measure');
  if (measures.length > 0) {
    lines.push(`  Measures: ${measures.map(m => `${m.name} (${(m.aggregation || 'sum').toUpperCase()})`).join(', ')}`);
  }

  // Dimensions
  const dims = table.columns.filter(c => c.semantic_role === 'dimension');
  if (dims.length > 0) {
    lines.push(`  Dimensions: ${dims.map(d => {
      if (d.enum_values?.length) return `${d.name} [${d.enum_values.join(', ')}]`;
      return d.name;
    }).join(', ')}`);
  }

  // Time
  const timestamps = table.columns.filter(c => c.semantic_role === 'timestamp' && c.stats);
  if (timestamps.length > 0) {
    lines.push(`  Time: ${timestamps.map(t => `${t.name} (${t.stats.min} to ${t.stats.max})`).join(', ')}`);
  }

  // Profile
  const profileParts = [];
  if (table.profile?.row_count) profileParts.push(`~${table.profile.row_count} rows`);
  if (table.profile?.freshness && table.profile.freshness !== 'unknown') profileParts.push(table.profile.freshness);
  if (profileParts.length) lines.push(`  Profile: ${profileParts.join(', ')}`);

  // Join paths
  if (table.relationships?.length > 0) {
    lines.push(`  Joins: ${table.relationships.map(r => `${r.column} → ${r.references_table}.${r.references_column}`).join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Serialize a table's metadata for the SQL GENERATION prompt.
 * Detailed format: every column with full context for SQL writing.
 * 
 * This is the most critical serialization — SQL quality depends on it.
 */
export function serializeForSQLGeneration(table) {
  const typeTag = table.table_type === 'bridge' ? ' [BRIDGE TABLE]' : 
                  table.table_type === 'fact' ? ' [FACT TABLE]' : 
                  table.table_type === 'dimension' ? ' [DIMENSION TABLE]' : '';
  
  const cols = table.columns
    .filter(c => c.semantic_role !== 'metadata')  // Never show system columns to SQL generator
    .map(c => {
      let line = `    ${c.name} (${c.data_type})`;
      
      // Meaning (from LLM enrichment)
      if (c.meaning && c.meaning !== c.name.replace(/_/g, ' ')) {
        line += `: ${c.meaning}`;
      }

      // Semantic role tag
      line += ` [${c.semantic_role}]`;

      // Role-specific annotations
      switch (c.semantic_role) {
        case 'measure':
          line += ` → use ${(c.aggregation || 'SUM').toUpperCase()}()`;
          if (c.stats) line += ` (range: ${c.stats.min} to ${c.stats.max})`;
          break;
        case 'key':
          if (c.is_primary_key) line += ' (PK)';
          if (c.is_foreign_key) line += ` → FK to ${c.references}`;
          break;
        case 'timestamp':
          if (c.stats) line += ` [DATA: ${c.stats.min} to ${c.stats.max}]`;
          break;
        case 'dimension':
          if (c.enum_values?.length) line += ` [VALID VALUES: ${c.enum_values.join(', ')}]`;
          break;
      }

      return line;
    }).join('\n');

  // Freshness instruction — directly actionable for the LLM
  let freshnessNote = '';
  if (table.profile?.freshness === 'historical' && table.profile?.time_boundary) {
    const tb = table.profile.time_boundary;
    freshnessNote = `\n  ⚠️ HISTORICAL DATA: Latest ${tb.column} is ${tb.max} (${tb.days_since_latest} days ago). Use (SELECT MAX("${tb.column}") FROM "${table.table}") instead of CURRENT_DATE for relative time filters.`;
  }

  // Measure ownership block — explicitly states which table owns which measure.
  // This prevents alias confusion when multiple fact tables are JOINed in the same query.
  // The LLM MUST read measure columns from the table listed here, not from another JOINed table.
  const measures = table.columns.filter(c => c.semantic_role === 'measure');
  let ownershipBlock = '';
  if (measures.length > 0) {
    const measureList = measures.map(m => `${m.name} → ${(m.aggregation || 'SUM').toUpperCase()}(alias.${m.name})`).join(', ');
    ownershipBlock = `\n  ⚠️ MEASURE OWNERSHIP: The following columns ONLY exist in "${table.table}", NOT in any other JOINed table: [${measureList}]`;
  }

  return `TABLE: ${table.table}${typeTag}
  Description: ${table.description || table.table}${freshnessNote}${ownershipBlock}
  Columns:
${cols}`;
}

/**
 * Serialize a table's metadata for the ANSWER CONTRACT prompt.
 * Focused format: only measures, dimensions, and time info.
 */
export function serializeForContract(table) {
  const measures = table.columns
    .filter(c => c.semantic_role === 'measure')
    .map(c => `${c.name} (${(c.aggregation || 'sum').toUpperCase()})`)
    .join(', ');
  
  const dims = table.columns
    .filter(c => c.semantic_role === 'dimension')
    .map(c => {
      if (c.enum_values?.length) return `${c.name} [${c.enum_values.slice(0, 5).join(', ')}${c.enum_values.length > 5 ? '...' : ''}]`;
      return c.name;
    })
    .join(', ');
  
  const timestamps = table.columns
    .filter(c => c.semantic_role === 'timestamp' && c.stats)
    .map(c => `${c.name} (${c.stats.min} to ${c.stats.max})`)
    .join(', ');

  return `${table.table}: measures=[${measures || 'none'}] dimensions=[${dims || 'none'}] timestamps=[${timestamps || 'none'}] freshness=${table.profile?.freshness || 'unknown'}`;
}

/**
 * Serialize a table's metadata for PINECONE embedding.
 * Natural language format optimized for semantic search.
 */
export function serializeForEmbedding(table) {
  const parts = [
    `Table: ${table.table}`,
    `Type: ${table.table_type}`,
    `Description: ${table.description || table.table}`,
  ];

  const measures = table.columns.filter(c => c.semantic_role === 'measure');
  if (measures.length) {
    parts.push(`Measures: ${measures.map(c => `${c.name} (${c.meaning || c.name})`).join(', ')}`);
  }

  const dims = table.columns.filter(c => c.semantic_role === 'dimension');
  if (dims.length) {
    parts.push(`Dimensions: ${dims.map(c => `${c.name} (${c.meaning || c.name})`).join(', ')}`);
  }

  if (table.common_queries?.length) {
    parts.push(`Common queries: ${table.common_queries.join('; ')}`);
  }

  return parts.join('\n');
}
