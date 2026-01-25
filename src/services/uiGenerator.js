import OpenAI from "openai";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current directory for loading component metadata
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load component metadata
const componentMetadataPath = join(__dirname, '../config/component_metadata.json');
const componentMetadata = JSON.parse(readFileSync(componentMetadataPath, 'utf-8'));

// Groq client
const groqClient = new OpenAI({
  apiKey: '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',
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Analyze query result data and generate a UI specification
 * @param {object} params - Parameters for UI generation
 * @param {string} params.originalQuery - The original natural language query
 * @param {string} params.sql - The executed SQL query
 * @param {Array} params.rows - The query result rows
 * @param {Array} params.fields - The query result field definitions
 * @returns {Promise<object>} UI specification JSON
 */
export async function generateUISpec({ originalQuery, sql, rows, fields }) {
  // Prepare data summary for the LLM
  const rowCount = rows.length;
  const columnInfo = fields.map(f => f.name).join(', ');
  
  // Sample data (first 5 rows) to help LLM understand the data shape
  const sampleData = rows.slice(0, 5);
  
  // Format component metadata for the prompt
  const componentDescriptions = componentMetadata.map(c => {
    return `### ${c.component}
Description: ${c.description}
Use when: ${c.use_when}
Expected props: ${JSON.stringify(c.expects, null, 2)}`;
  }).join('\n\n');

  const prompt = `You are a UI component selector. Your task is to analyze SQL query results and choose the BEST single UI component to display the data.

## User's Original Question
"${originalQuery}"

## SQL Query Executed
${sql}

## Query Results Summary
- Row count: ${rowCount}
- Columns: ${columnInfo}
- Sample data (first ${Math.min(5, rowCount)} rows):
${JSON.stringify(sampleData, null, 2)}

## Available UI Components
${componentDescriptions}

## Your Task
Analyze the data and select EXACTLY ONE component that best represents this data. Then output a JSON object with the component configuration.

## Rules
1. For single aggregate values (COUNT, SUM, AVG) → use Card
2. For percentage values (0-100) → use Progress  
3. For multiple rows with multiple columns → use Table
4. For status/category single values → use Badge
5. The "props" must match EXACTLY what the component expects (see "Expected props" above)
6. For Table component: ONLY define "columns" and "caption". DO NOT include the "data" array in your JSON; the system will inject it automatically.
7. Output ONLY valid JSON, no explanation, no markdown code blocks

## Required Output Format (JSON only)
{
  "title": "A descriptive title for this visualization",
  "description": "Brief explanation of what the data shows",
  "component": {
    "type": "Card" | "Table" | "Progress" | "Badge",
    "props": { ... }
  }
}

JSON Output:`;

  try {
    const response = await groqClient.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1, // Low temperature for consistent output
      max_tokens: 2000,
    });

    let content = response.choices[0].message.content.trim();
    
    // Clean up any markdown code blocks if present
    if (content.startsWith('```json')) {
      content = content.slice(7);
    }
    if (content.startsWith('```')) {
      content = content.slice(3);
    }
    if (content.endsWith('```')) {
      content = content.slice(0, -3);
    }
    content = content.trim();

    // Parse and validate the JSON
    const uiSpec = JSON.parse(content);
    
    // Validate required fields
    if (!uiSpec.title || !uiSpec.component || !uiSpec.component.type) {
      throw new Error('Invalid UI specification: missing required fields');
    }

    // Validate component type
    const validTypes = componentMetadata.map(c => c.component);
    if (!validTypes.includes(uiSpec.component.type)) {
      throw new Error(`Invalid component type: ${uiSpec.component.type}. Must be one of: ${validTypes.join(', ')}`);
    }

    // SPECIAL HANDLING: Inject full data for Table components
    if (uiSpec.component.type === 'Table') {
      uiSpec.component.props.data = rows;
      // Ensure columns are present, if not, fallback to field names
      if (!uiSpec.component.props.columns || uiSpec.component.props.columns.length === 0) {
        uiSpec.component.props.columns = fields.map(f => ({ Header: f.name, accessor: f.name }));
      }
    }

    console.log(`[UI GENERATOR] Selected component: ${uiSpec.component.type} for query: "${originalQuery}"`);
    
    return uiSpec;
  } catch (error) {
    console.error('[UI GENERATOR] Error:', error.message);
    
    // Fallback: Return a Table component with the raw data
    if (rows.length > 0 && fields.length > 0) {
      console.log('[UI GENERATOR] Falling back to Table component');
      return {
        title: "Query Results",
        description: `Results for: ${originalQuery}`,
        component: {
          type: "Table",
          props: {
            columns: fields.map(f => ({ Header: f.name, accessor: f.name })),
            data: rows,
          }
        }
      };
    }
    
    throw new Error('Failed to generate UI specification: ' + error.message);
  }
}
