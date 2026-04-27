export function getMetadataEnrichmentPrompt({ schemas, tablesDescription }) {
  return `You are a database documentation expert. Given the following database schema with ${schemas.length} tables, generate semantic descriptions.

${tablesDescription}

Generate a JSON array with one object per table. Each object must have:
{
  "table": "table_name",
  "description": "1-2 sentence business purpose of this table",
  "columns": [
    {"name": "column_name", "meaning": "what this column means in business terms"}
  ],
  "common_queries": ["3-5 example natural language questions this table helps answer"]
}

IMPORTANT: 
- Return ONLY valid JSON array with exactly ${schemas.length} objects
- No markdown, no explanation
- Include ALL ${schemas.length} tables
- For measure columns, describe what metric they represent
- For dimension columns, describe what entity or category they label
- For timestamp columns, describe what business event they mark
- common_queries should be realistic questions a business analyst would ask`;
}
