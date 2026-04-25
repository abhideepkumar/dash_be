import { callLLM } from '../utils/llmClient.js';
import { serializeForAnswerability } from './schemaExtractor.js';

/**
 * Enrich canonical schemas with LLM-generated descriptions and meanings.
 * 
 * MUTATES the input schemas in-place — no separate output structure.
 * This means:
 *   - schema.description gets set
 *   - schema.common_queries gets set
 *   - Each column.meaning gets set
 * 
 * All deterministic metadata (semantic_role, aggregation, stats, enum_values)
 * is already on the schema from schemaExtractor. The LLM only adds
 * human-language descriptions — it never overwrites deterministic fields.
 * 
 * @param {Array} schemas - Canonical schemas from getFullSchema (mutated in-place)
 * @param {function} onProgress - Optional progress callback
 */
export async function generateAllMetadata(schemas, onProgress = null) {
  if (onProgress) {
    onProgress('all tables', 1, 1, 'enriching');
  }

  // Build the prompt using the answerability serializer (it's compact and rich)
  const tablesDescription = schemas.map(schema => {
    return serializeForAnswerability(schema);
  }).join('\n\n---\n');

  const prompt = `You are a database documentation expert. Given the following database schema with ${schemas.length} tables, generate semantic descriptions.

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

  try {
    console.log(`[METADATA] Sending ${schemas.length} tables to LLM for enrichment...`);

    const { content: responseText } = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.3 }
    );

    // Clean up response
    let cleanJson = responseText.trim();
    if (cleanJson.startsWith('```json')) cleanJson = cleanJson.slice(7);
    if (cleanJson.startsWith('```')) cleanJson = cleanJson.slice(3);
    if (cleanJson.endsWith('```')) cleanJson = cleanJson.slice(0, -3);
    cleanJson = cleanJson.trim();

    const parsed = JSON.parse(cleanJson);
    console.log(`[METADATA] ✅ Received enrichment for ${parsed.length} tables`);
    
    // Merge LLM output into canonical schemas IN-PLACE
    mergeLLMEnrichment(schemas, parsed);
    
  } catch (error) {
    console.error('[METADATA] ❌ LLM enrichment failed:', error.message);
    // Non-fatal: schemas keep their default descriptions
    // column.meaning already defaults to the column name
    for (const schema of schemas) {
      if (!schema.description) {
        schema.description = `Table ${schema.table} with ${schema.columns.length} columns`;
      }
    }
  }
}

/**
 * Merge LLM-generated descriptions into canonical schemas.
 * Only sets description, common_queries, and column.meaning.
 * Never overwrites deterministic fields (semantic_role, aggregation, stats, etc.)
 * 
 * @param {Array} schemas - Canonical schemas (mutated in-place)
 * @param {Array} llmOutput - Parsed LLM response
 */
function mergeLLMEnrichment(schemas, llmOutput) {
  // Build lookup map from LLM output
  const llmMap = {};
  for (const item of llmOutput) {
    llmMap[item.table] = item;
  }

  for (const schema of schemas) {
    const enrichment = llmMap[schema.table];
    if (!enrichment) continue;

    // Set table-level fields
    if (enrichment.description) {
      schema.description = enrichment.description;
    }
    if (enrichment.common_queries?.length) {
      schema.common_queries = enrichment.common_queries;
    }

    // Set column-level meanings
    if (enrichment.columns?.length) {
      const meaningMap = {};
      for (const col of enrichment.columns) {
        if (col.meaning) meaningMap[col.name] = col.meaning;
      }
      
      for (const col of schema.columns) {
        if (meaningMap[col.name]) {
          col.meaning = meaningMap[col.name];
        }
      }
    }
  }

  console.log(`[METADATA] Merged enrichment into ${schemas.length} canonical schemas`);
}
