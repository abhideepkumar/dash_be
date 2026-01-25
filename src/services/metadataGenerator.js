import OpenAI from "openai";

// Lazy-initialized client
let client = null;

function getGroqClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: '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',
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return client;
}

/**
 * Generate semantic metadata for ALL tables in a single LLM call
 * @param {Array} rawSchemas - Array of raw table schemas from schemaExtractor
 * @param {function} onProgress - Progress callback
 * @returns {Promise<Array>} Array of enriched metadata
 */
export async function generateAllMetadata(rawSchemas, onProgress = null) {
  if (onProgress) {
    onProgress('all tables', 1, 1, 'enriching');
  }

  // Build a single prompt with all tables
  const tablesDescription = rawSchemas.map(schema => {
    const columns = schema.columns.map(c => 
      `    - ${c.name} (${c.type}${c.nullable ? ', nullable' : ''})`
    ).join('\n');
    
    const fks = schema.foreignKeys.length > 0
      ? schema.foreignKeys.map(fk => `    - ${fk.column} -> ${fk.references}`).join('\n')
      : '    None';
    
    return `
TABLE: ${schema.table}
Primary Keys: ${schema.primaryKeys.join(', ') || 'None'}
Columns:
${columns}
Foreign Keys:
${fks}`;
  }).join('\n\n---\n');

  const prompt = `You are a database documentation expert. Given the following database schema with ${rawSchemas.length} tables, generate semantic descriptions for ALL tables.

${tablesDescription}

Generate a JSON array with one object per table. Each object must have this exact structure:
{
  "table": "table_name",
  "description": "1-2 sentence purpose of this table",
  "columns": [
    {"name": "column_name", "type": "data_type", "meaning": "business purpose of this column"}
  ],
  "foreign_keys": ["table.column", "table.column"],
  "common_queries": ["3-5 example natural language questions this table could help answer"]
}

IMPORTANT: 
- Return a valid JSON array containing exactly ${rawSchemas.length} objects
- No markdown, no explanation, ONLY the JSON array
- Include ALL ${rawSchemas.length} tables in your response`;

  try {
    console.log(`[METADATA] Sending ${rawSchemas.length} tables to Groq...`);
    
    const groq = getGroqClient();
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
    });
    
    const responseText = response.choices[0].message.content;
    
    // Clean up response - remove markdown code blocks if present
    let cleanJson = responseText.trim();
    if (cleanJson.startsWith('```json')) {
      cleanJson = cleanJson.slice(7);
    }
    if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.slice(3);
    }
    if (cleanJson.endsWith('```')) {
      cleanJson = cleanJson.slice(0, -3);
    }
    cleanJson = cleanJson.trim();

    const parsed = JSON.parse(cleanJson);
    console.log(`[METADATA] ✅ Received metadata for ${parsed.length} tables`);
    
    return parsed;
  } catch (error) {
    console.error('[METADATA] ❌ Error generating metadata:', error.message);
    
    // Return basic metadata for all tables if LLM fails
    return rawSchemas.map(schema => ({
      table: schema.table,
      description: `Table containing ${schema.columns.length} columns`,
      columns: schema.columns.map(c => ({
        name: c.name,
        type: c.type,
        meaning: c.name.replace(/_/g, ' '),
      })),
      foreign_keys: schema.foreignKeys.map(fk => `${fk.references}`),
      common_queries: [],
    }));
  }
}
