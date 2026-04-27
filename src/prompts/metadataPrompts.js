/**
 * Phase 1 prompt: generates an ultra-compact overview of the ENTIRE schema.
 * Input: all schemas (just table names + column names, ultra-compact).
 * Output: a short paragraph describing the domain and key relationships.
 * This is injected as a preamble in every Phase 2 batch call.
 */
export function getGlobalContextPrompt(schemas) {
  const compact = schemas.map(s =>
    `${s.table}(${s.columns.map(c => c.name).join(', ')})`
  ).join('\n');

  return `You are a database architect. Given this list of ${schemas.length} tables and their columns, write a single concise paragraph (max 150 words) that describes:
1. The overall business domain of this database
2. The key entities and what they represent
3. The primary relationships between major tables (e.g. "SalesOrderHeader links to SalesOrderDetail, Customer, and Address")

Be specific about table names. This will be used as context for subsequent enrichment calls.

Tables:
${compact}

Return ONLY the paragraph. No JSON, no markdown, no preamble.`;
}

/**
 * Phase 2 prompt: enriches a BATCH of tables with semantic descriptions.
 * Accepts an optional globalContext preamble for cross-table relational awareness.
 */
export function getMetadataEnrichmentPrompt({ schemas, tablesDescription, globalContext = '' }) {
  const preamble = globalContext
    ? `DATABASE OVERVIEW (for relational context):\n${globalContext}\n\n---\n\n`
    : '';

  return `You are a database documentation expert.${globalContext ? ' Use the database overview below to write descriptions that reference relationships to other tables where relevant.' : ''}

${preamble}Given the following ${schemas.length} tables, generate semantic descriptions.

${tablesDescription}

Generate a JSON array with one object per table. Each object must have:
{
  "table": "Schema.TableName",
  "description": "1-2 sentence business purpose, mentioning key relationships to other tables",
  "columns": [
    {"name": "column_name", "meaning": "what this column means in business terms"}
  ],
  "common_queries": ["3-5 example natural language questions this table helps answer"]
}

IMPORTANT:
- Return ONLY a valid JSON array with exactly ${schemas.length} objects
- No markdown, no explanation, no trailing text after the closing ]
- Include ALL ${schemas.length} tables listed above
- For measure columns, describe what metric they represent
- For dimension columns, describe what entity or category they label
- For timestamp columns, describe what business event they mark
- common_queries should be realistic questions a business analyst would ask
- In descriptions, reference related tables by their full Schema.TableName`;
}
