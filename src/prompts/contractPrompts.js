export function getAnswerContractPrompt({ query, schemaSummary }) {
  return `You are an analytical query planner. Given a user's question and available database schema, produce a structured analytical contract that defines exactly what the answer must contain.

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
}

export function getRepairSQLPrompt({ sql, contract, errorList, schemaContext }) {
  return `Fix this SQL query based on the validation errors below.

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
4. **CRITICAL — IDENTIFIERS**: PostgreSQL folds unquoted identifiers to lowercase. If a schema or table contains uppercase letters (e.g. Schema.TableName), you MUST wrap the schema and the table separately in double quotes in your repaired query (e.g. FROM "Schema"."TableName"). Do NOT use unquoted mixed-case names.
5. Return ONLY the fixed SQL query, no explanation, no markdown

Fixed SQL:`;
}
