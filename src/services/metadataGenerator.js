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
    const columns = schema.columns.map(c => {
      let colDesc = `    - ${c.name} (${c.type}${c.nullable ? ', nullable' : ''})`;
      // Include enum values if present (NEW)
      if (c.is_enum && c.enum_values && c.enum_values.length > 0) {
        colDesc += ` [ENUM: ${c.enum_values.join(', ')}]`;
      }
      return colDesc;
    }).join('\n');
    
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
- Include ALL ${rawSchemas.length} tables in your response
- For columns marked [ENUM: ...], the valid values are already provided - use them in the meaning`;

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
    
    // Merge enum values from raw schema into parsed result (NEW)
    const enrichedResult = mergeEnumValues(parsed, rawSchemas);
    
    return enrichedResult;
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
        ...(c.is_enum && c.enum_values ? { is_enum: true, enum_values: c.enum_values } : {})
      })),
      foreign_keys: schema.foreignKeys.map(fk => `${fk.references}`),
      common_queries: [],
    }));
  }
}

/**
 * Merge enum values from raw schema into AI-enriched metadata
 * This ensures enum_values are preserved even if AI doesn't include them
 */
function mergeEnumValues(enrichedMetadata, rawSchemas) {
  // Create lookup map for raw schema columns
  const rawSchemaMap = {};
  rawSchemas.forEach(schema => {
    rawSchemaMap[schema.table] = {};
    schema.columns.forEach(col => {
      if (col.is_enum && col.enum_values) {
        rawSchemaMap[schema.table][col.name] = col.enum_values;
      }
    });
  });
  
  // Merge enum values into enriched metadata
  return enrichedMetadata.map(table => {
    const tableEnums = rawSchemaMap[table.table] || {};
    
    if (table.columns) {
      table.columns = table.columns.map(col => {
        const enumValues = tableEnums[col.name];
        if (enumValues) {
          return {
            ...col,
            is_enum: true,
            enum_values: enumValues
          };
        }
        return col;
      });
    }
    
    return table;
  });
}
