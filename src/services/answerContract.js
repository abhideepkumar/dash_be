/**
 * Answer Contract Service — Semantic Answer Layer
 * 
 * Sits between query enhancement and SQL generation to ensure analytical completeness.
 * 
 * Two responsibilities:
 * 1. Generate a structured analytical contract from the user's question
 * 2. Validate that the generated SQL fulfills that contract
 * 
 * This is the key differentiator between "AI generates charts" and "AI analyst I can trust."
 */

import { callLLM } from '../utils/llmClient.js';
import { serializeForContract } from './schemaExtractor.js';

// ============================================
// CONTRACT GENERATION
// ============================================

/**
 * Generate a structured analytical contract from the user's query and available schema.
 * The contract defines WHAT the SQL must produce — not HOW.
 * 
 * @param {string} query - The enhanced user query
 * @param {Array} tables - Relevant table schemas (from vector search + graph expansion)
 * @returns {Promise<Object>} The analytical contract
 */
export async function generateAnswerContract(query, tables) {
  // Use the canonical contract serializer — compact, consistent format
  const schemaSummary = tables.map(t => serializeForContract(t)).join('\n');

  const prompt = `You are an analytical query planner. Given a user's question and available database schema, produce a structured analytical contract that defines exactly what the answer must contain.

User Question: "${query}"

Available Schema:
${schemaSummary}

Generate a JSON contract with this structure:
{
  "intent": "top_n" | "aggregation" | "trend" | "comparison" | "detail" | "count",
  "grain": "the main entity being analyzed (e.g., region, product, category)",
  "metrics": [
    {
      "name": "human-readable metric name (e.g., total_sales)",
      "source_column": "the source column name (e.g., sales_amount)",
      "source_table": "the table containing this column",
      "aggregation": "SUM" | "AVG" | "COUNT" | "MAX" | "MIN",
      "required_in_select": true
    }
  ],
  "dimensions": [
    {
      "name": "human-readable dimension name (e.g., region)",
      "source_column": "the source column name",
      "source_table": "the table containing this column",
      "required_in_select": true
    }
  ],
  "time_filter": {
    "needed": true | false,
    "column": "the date column to filter on (fully qualified: table.column)",
    "type": "relative" | "absolute" | "none",
    "description": "human-readable description (e.g., last 90 days)"
  },
  "sort": {
    "by": "metric or dimension name to sort by",
    "direction": "DESC" | "ASC"
  },
  "limit": null | number,
  "required_output_columns": ["list of column names/aliases that MUST appear in SELECT"]
}

Rules:
1. If the user asks for "highest", "best", "top" → intent is "top_n", include sort DESC and limit
2. If the user asks for "total", "sum", "average" → intent is "aggregation"
3. If the user asks for "over time", "trend", "monthly" → intent is "trend"
4. EVERY metric the user cares about MUST be in "required_output_columns"
5. EVERY dimension the user groups by MUST be in "required_output_columns"
6. If the question implies a number (e.g., "highest total sales"), the metric MUST appear in output
7. For time filters: if the date range in the schema does NOT reach today's date, note this — the SQL should use MAX(date) anchoring instead of CURRENT_DATE
8. Return ONLY valid JSON, no markdown, no explanation

JSON Contract:`;

  try {
    const { content: raw, usage, costDetails } = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, max_tokens: 600 }
    );

    let cleaned = raw.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    const contract = JSON.parse(cleaned);
    console.log(`[CONTRACT] Generated: intent=${contract.intent}, metrics=${contract.metrics?.length || 0}, dimensions=${contract.dimensions?.length || 0}`);
    
    return {
      contract,
      usage,
      costDetails
    };
  } catch (error) {
    console.error('[CONTRACT] Failed to generate answer contract:', error.message);
    // Return a permissive fallback contract (don't block the pipeline)
    return {
      contract: {
        intent: 'unknown',
        grain: null,
        metrics: [],
        dimensions: [],
        time_filter: { needed: false },
        sort: null,
        limit: null,
        required_output_columns: [],
      },
      usage: null,
      costDetails: null
    };
  }
}

// ============================================
// SQL VALIDATION AGAINST CONTRACT
// ============================================

/**
 * Extract the SELECT clause from a SQL query string.
 * @param {string} sql
 * @returns {string} The SELECT clause content
 */
function extractSelectClause(sql) {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const selectMatch = normalized.match(/SELECT\s+(.*?)\s+FROM/i);
  return selectMatch ? selectMatch[1] : '';
}

/**
 * Check if a SELECT clause contains a reference to a column (by name or alias).
 * Handles aliases like "SUM(x) AS total_sales" and plain column references.
 * @param {string} selectClause
 * @param {string} columnName
 * @returns {boolean}
 */
function selectContainsColumn(selectClause, columnName) {
  const normalized = selectClause.toLowerCase();
  const colLower = columnName.toLowerCase();
  
  // Check for exact column name, alias, or qualified name (table.column)
  // Patterns: "column_name", "AS column_name", "table.column_name"
  const patterns = [
    new RegExp(`\\b${escapeRegex(colLower)}\\b`, 'i'),                    // plain column name
    new RegExp(`\\bAS\\s+${escapeRegex(colLower)}\\b`, 'i'),              // AS alias
    new RegExp(`\\.${escapeRegex(colLower)}\\b`, 'i'),                    // table.column
  ];

  return patterns.some(p => p.test(normalized));
}

/**
 * Check if a SELECT clause contains an aggregation function applied to a column.
 * @param {string} selectClause
 * @param {string} columnName - The source column being aggregated
 * @param {string} aggregation - The expected function (SUM, AVG, etc.)
 * @returns {boolean}
 */
function selectContainsAggregation(selectClause, columnName, aggregation) {
  const normalizedSelect = selectClause.toLowerCase();
  const colLower = columnName.toLowerCase();
  const aggLower = (aggregation || 'sum').toLowerCase();

  // Check for: SUM(col), SUM(table.col), COUNT(*), etc.
  const aggPattern = new RegExp(`${escapeRegex(aggLower)}\\s*\\([^)]*${escapeRegex(colLower)}[^)]*\\)`, 'i');
  
  // Also check for any aggregation on the column (user might have used a different agg)
  const anyAggPattern = new RegExp(`(sum|avg|count|max|min)\\s*\\([^)]*${escapeRegex(colLower)}[^)]*\\)`, 'i');
  
  return aggPattern.test(normalizedSelect) || anyAggPattern.test(normalizedSelect);
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate a generated SQL query against the analytical contract.
 * Returns a list of issues found. If empty, the SQL is valid.
 * 
 * This is deterministic validation — no LLM calls.
 * 
 * @param {string} sql - The generated SQL query
 * @param {Object} contract - The analytical contract
 * @returns {Object} { valid: boolean, errors: Array<{type, detail, fix}> }
 */
export function validateSQLAgainstContract(sql, contract) {
  const errors = [];
  
  // Skip validation for unknown/fallback contracts
  if (!contract || contract.intent === 'unknown' || !contract.required_output_columns?.length) {
    return { valid: true, errors: [] };
  }

  const selectClause = extractSelectClause(sql);
  const sqlUpper = sql.toUpperCase().replace(/\s+/g, ' ');

  // 1. Check required output columns appear in SELECT.
  // IMPORTANT: Skip raw SQL expressions (e.g. "SUM(profit_amount)") — these are LLM
  // formatting errors in the contract itself. Raw aggregation expressions will be
  // correctly validated by the metrics[] check in step 2, which understands aliases.
  // Only validate simple column names and aliases here.
  const isRawExpression = (col) => /[()/]/.test(col) || /^(sum|avg|count|max|min)\s*\(/i.test(col.trim());
  for (const col of contract.required_output_columns) {
    if (isRawExpression(col)) {
      // Skip - this is a raw SQL expression the LLM put in required_output_columns.
      // The metrics[] array validation handles this correctly via selectContainsAggregation().
      console.warn(`[CONTRACT] Skipping raw SQL expression in required_output_columns: "${col}"`);
      continue;
    }
    if (!selectContainsColumn(selectClause, col)) {
      errors.push({
        type: 'MISSING_OUTPUT_COLUMN',
        detail: `Column "${col}" is required in SELECT but not found`,
        fix: `Add "${col}" to the SELECT clause`
      });
    }
  }

  // 2. Check metrics have aggregation in SELECT
  for (const metric of (contract.metrics || [])) {
    if (metric.required_in_select) {
      const hasAgg = selectContainsAggregation(selectClause, metric.source_column, metric.aggregation);
      const hasAlias = selectContainsColumn(selectClause, metric.name);
      
      if (!hasAgg && !hasAlias) {
        errors.push({
          type: 'MISSING_METRIC',
          detail: `Metric "${metric.name}" (${metric.aggregation}(${metric.source_column})) is required but not in SELECT`,
          fix: `Add ${metric.aggregation}(${metric.source_column}) AS ${metric.name} to SELECT`
        });
      }
    }
  }

  // 3. Check ORDER BY for top_n queries
  if (contract.intent === 'top_n' && !sqlUpper.includes('ORDER BY')) {
    errors.push({
      type: 'MISSING_ORDER_BY',
      detail: 'Query intent is "top_n" but no ORDER BY clause found',
      fix: `Add ORDER BY ${contract.sort?.by || 'metric'} ${contract.sort?.direction || 'DESC'}`
    });
  }

  // 4. Check LIMIT for top_n queries
  if (contract.intent === 'top_n' && contract.limit && !sqlUpper.includes('LIMIT')) {
    errors.push({
      type: 'MISSING_LIMIT',
      detail: `Query intent is "top_n" but no LIMIT clause found (expected LIMIT ${contract.limit})`,
      fix: `Add LIMIT ${contract.limit}`
    });
  }

  // 5. Check time anchoring — if contract says date doesn't reach today, CURRENT_DATE is wrong
  if (contract.time_filter?.needed && contract.time_filter?.type === 'relative') {
    if (sqlUpper.includes('CURRENT_DATE') || sqlUpper.includes('NOW()') || sqlUpper.includes('CURRENT_TIMESTAMP')) {
      // Check if the schema date range extends to today
      // The contract generator should have noted this
      const hasMaxAnchor = sqlUpper.includes('SELECT MAX') || sqlUpper.includes('(SELECT MAX');
      if (!hasMaxAnchor) {
        errors.push({
          type: 'POSSIBLE_TIME_ANCHOR_ISSUE',
          detail: 'Using CURRENT_DATE for relative time filter. If the dataset is static/historical, this may return 0 rows.',
          fix: 'Consider using (SELECT MAX(date_col) FROM table) instead of CURRENT_DATE for static datasets'
        });
      }
    }
  }

  // 6. Check GROUP BY when aggregations are present
  if ((contract.metrics || []).length > 0 && (contract.dimensions || []).length > 0) {
    const hasAggInSelect = /\b(SUM|AVG|COUNT|MAX|MIN)\s*\(/i.test(selectClause);
    if (hasAggInSelect && !sqlUpper.includes('GROUP BY')) {
      errors.push({
        type: 'MISSING_GROUP_BY',
        detail: 'Aggregation functions found in SELECT but no GROUP BY clause',
        fix: `Add GROUP BY for dimension columns: ${contract.dimensions.map(d => d.source_column).join(', ')}`
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ============================================
// SQL REPAIR
// ============================================

/**
 * Attempt to repair SQL that failed contract validation.
 * Uses LLM to fix the specific issues identified by validation.
 * Maximum 1 repair attempt to avoid infinite loops.
 * 
 * @param {string} sql - The original SQL
 * @param {Object} contract - The analytical contract
 * @param {Array} validationErrors - Errors from validateSQLAgainstContract
 * @param {Array} tables - Available table schemas for context
 * @returns {Promise<Object>} { repairedSQL, wasRepaired, usage, costDetails }
 */
export async function repairSQL(sql, contract, validationErrors, tables) {
  // Only attempt repair for actionable errors (not warnings like time anchor)
  const actionableErrors = validationErrors.filter(e => 
    e.type !== 'POSSIBLE_TIME_ANCHOR_ISSUE'
  );

  if (actionableErrors.length === 0) {
    return { repairedSQL: sql, wasRepaired: false };
  }

  console.log(`[CONTRACT] Attempting SQL repair for ${actionableErrors.length} errors`);

  const errorList = actionableErrors.map(e => `- ${e.type}: ${e.detail}. Fix: ${e.fix}`).join('\n');
  
  // Compact schema for repair context using canonical field names
  const schemaContext = tables.map(t => {
    const cols = (t.columns || []).map(c => {
      let desc = `${c.name} (${c.data_type || c.type})`;
      if (c.semantic_role) desc += ` [${c.semantic_role}]`;
      return desc;
    }).join(', ');
    return `${t.table}: ${cols}`;
  }).join('\n');

  const prompt = `Fix this SQL query based on the validation errors below.

Original SQL:
${sql}

Analytical Contract (what the answer MUST contain):
- Required output columns: ${contract.required_output_columns?.join(', ') || 'none'}
- Metrics: ${(contract.metrics || []).map(m => `${m.aggregation}(${m.source_column}) AS ${m.name}`).join(', ') || 'none'}
- Dimensions: ${(contract.dimensions || []).map(d => d.source_column).join(', ') || 'none'}
- Intent: ${contract.intent}
- Sort: ${contract.sort ? `${contract.sort.by} ${contract.sort.direction}` : 'none'}
- Limit: ${contract.limit || 'none'}

Validation Errors:
${errorList}

Available Schema:
${schemaContext}

Rules:
1. Fix ONLY the issues listed above
2. Keep the original query logic intact
3. Ensure all required_output_columns appear in SELECT
4. Return ONLY the fixed SQL query, no explanation, no markdown

Fixed SQL:`;

  try {
    const { content: rawSQL, usage, costDetails } = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, max_tokens: 500 }
    );

    let repairedSQL = rawSQL.trim();
    if (repairedSQL.startsWith('```sql')) repairedSQL = repairedSQL.slice(6);
    if (repairedSQL.startsWith('```')) repairedSQL = repairedSQL.slice(3);
    if (repairedSQL.endsWith('```')) repairedSQL = repairedSQL.slice(0, -3);
    repairedSQL = repairedSQL.trim();

    console.log(`[CONTRACT] SQL repaired successfully`);
    return {
      repairedSQL,
      wasRepaired: true,
      usage,
      costDetails
    };
  } catch (error) {
    console.error('[CONTRACT] SQL repair failed:', error.message);
    // Return original SQL if repair fails — don't block the pipeline
    return {
      repairedSQL: sql,
      wasRepaired: false
    };
  }
}

// ============================================
// ZERO-ROW DIAGNOSIS
// ============================================

/**
 * Diagnose why a SQL query returned zero rows.
 * Runs lightweight diagnostic queries to identify the root cause.
 * 
 * @param {Object} pool - Database connection pool
 * @param {string} sql - The SQL that returned 0 rows
 * @param {Object} contract - The analytical contract (if available)
 * @returns {Promise<Object>} { reason, detail, suggestion }
 */
export async function diagnoseEmptyResult(pool, sql, contract = null) {
  const diagnosis = {
    reason: 'unknown',
    detail: null,
    suggestion: null,
  };

  try {
    // Strategy 1: Check if it's a date filter issue
    // Look for date-related WHERE clauses and check actual date ranges
    const dateFilterMatch = sql.match(/WHERE[^;]*?(\w+\.?\w+)\s*>=?\s*(?:CURRENT_DATE|NOW\(\)|'[^']+')[^;]*/i);
    
    if (dateFilterMatch) {
      const dateRef = dateFilterMatch[1];
      // Try to extract the table and column
      const parts = dateRef.split('.');
      const column = parts[parts.length - 1];
      
      // Find the table containing this column from the SQL
      const tableMatch = sql.match(new RegExp(`FROM\\s+"?(\\w+)"?.*?${escapeRegex(dateRef)}`, 'is'));
      const aliasMatch = sql.match(new RegExp(`"?(\\w+)"?\\s+(?:AS\\s+)?${escapeRegex(parts[0])}`, 'i'));
      
      const tableName = tableMatch?.[1] || aliasMatch?.[1];
      
      if (tableName && column) {
        try {
          const rangeResult = await pool.query(
            `SELECT MIN("${column}")::text AS min_date, MAX("${column}")::text AS max_date FROM "${tableName}"`
          );
          
          if (rangeResult.rows[0]) {
            const { min_date, max_date } = rangeResult.rows[0];
            diagnosis.reason = 'date_filter_out_of_range';
            diagnosis.detail = `The date column "${column}" in "${tableName}" ranges from ${min_date} to ${max_date}. Your filter may be looking for dates outside this range.`;
            diagnosis.suggestion = `Try asking about data within the available range (${min_date} to ${max_date}), or use "last 90 days of available data" instead of calendar dates.`;
            return diagnosis;
          }
        } catch (err) {
          // Diagnostic query failed — continue to next strategy
          console.warn('[DIAGNOSIS] Date range check failed:', err.message);
        }
      }
    }

    // Strategy 2: Check if the base tables have any data at all
    const fromMatch = sql.match(/FROM\s+"?(\w+)"?/i);
    if (fromMatch) {
      const baseTable = fromMatch[1];
      try {
        const countResult = await pool.query(`SELECT COUNT(*) AS cnt FROM "${baseTable}" LIMIT 1`);
        const count = parseInt(countResult.rows[0]?.cnt, 10) || 0;
        
        if (count === 0) {
          diagnosis.reason = 'empty_table';
          diagnosis.detail = `The table "${baseTable}" contains no data.`;
          diagnosis.suggestion = 'Verify that data has been loaded into this table.';
          return diagnosis;
        }
      } catch (err) {
        console.warn('[DIAGNOSIS] Table count check failed:', err.message);
      }
    }

    // Strategy 3: Generic — the filter was too restrictive
    diagnosis.reason = 'no_matching_rows';
    diagnosis.detail = 'The query executed successfully but no rows matched the filter criteria.';
    diagnosis.suggestion = 'Try broadening the filter conditions or removing specific constraints.';
    
  } catch (error) {
    console.error('[DIAGNOSIS] Diagnosis failed:', error.message);
    diagnosis.reason = 'diagnosis_failed';
    diagnosis.detail = error.message;
  }

  return diagnosis;
}
