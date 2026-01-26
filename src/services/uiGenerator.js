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
  
  // Sample data (first 4 rows) to help LLM understand the data shape
  const sampleData = rows.slice(0, 4);
  
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
- Sample data (first ${Math.min(4, rowCount)} rows):
${JSON.stringify(sampleData, null, 2)}

## Available UI Components
${componentDescriptions}

## Your Task
Analyze the data and select EXACTLY ONE component that best represents this data. Then output a JSON object with the component configuration.

## Selection Priority (follow this order)
1. Single aggregate value (COUNT, SUM, AVG, 1 row 1-2 cols) → Card
2. Temporal data with numeric values (date/month + numbers) → LineChart or AreaChart  
3. Category comparison (name + values, many rows) → BarChart or PieChart (Pie only for ≤8 rows)
4. Percentages or goal metrics → RadialChart or Progress
5. Status/category text → Badge
6. Fallback for complex data → Table (only if charts don't fit)

## Props Format by Component Type

For Card:
{ "title": "label", "value": the_value, "description": "context" }

For BarChart/LineChart/AreaChart:
{ "categoryKey": "column_name_for_x_axis", "dataKey": "column_name_for_values" }
Note: dataKey can be an array for multiple series: ["col1", "col2"]

For PieChart:
{ "nameKey": "column_for_labels", "dataKey": "column_for_values" }

For RadialChart:
{ "nameKey": "column_for_labels", "dataKey": "column_for_values", "maxValue": 100 }

For Table:
{ "columns": [{"Header": "Display Name", "accessor": "column_name"}], "caption": "description" }

## Rules
1. DO NOT include "data" in props - it will be injected automatically
2. Use exact column names from the sample data for categoryKey, dataKey, nameKey
3. Output ONLY valid JSON, no explanation, no markdown code blocks

## Required Output Format (JSON only)
{
  "title": "A descriptive title for this visualization",
  "description": "Brief explanation of what the data shows",
  "component": {
    "type": "Card" | "BarChart" | "LineChart" | "AreaChart" | "PieChart" | "RadialChart" | "Table" | "Progress" | "Badge",
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

    // SPECIAL HANDLING: Inject full data for data-driven components
    const dataComponents = ['Table', 'BarChart', 'LineChart', 'AreaChart', 'PieChart', 'RadialChart'];
    if (dataComponents.includes(uiSpec.component.type)) {
      uiSpec.component.props.data = rows;
      
      // For Table: ensure columns are present
      if (uiSpec.component.type === 'Table') {
        if (!uiSpec.component.props.columns || uiSpec.component.props.columns.length === 0) {
          uiSpec.component.props.columns = fields.map(f => ({ Header: f.name, accessor: f.name }));
        }
      }
    }

    console.log(`[UI GENERATOR] Selected component: ${uiSpec.component.type} for query: "${originalQuery}"`);
    
    return uiSpec;
  } catch (error) {
    console.error('[UI GENERATOR] Error:', error.message);
    
    // Fallback: Return a BarChart if we have label+value pattern, else Table
    if (rows.length > 0 && fields.length > 0) {
      const numericFields = fields.filter(f => !isNaN(Number(rows[0]?.[f.name])));
      const textFields = fields.filter(f => isNaN(Number(rows[0]?.[f.name])));
      
      // If we have one text field and one numeric field, use BarChart
      if (textFields.length === 1 && numericFields.length >= 1 && rows.length > 1 && rows.length <= 50) {
        console.log('[UI GENERATOR] Falling back to BarChart');
        return {
          title: "Query Results",
          description: `Results for: ${originalQuery}`,
          component: {
            type: "BarChart",
            props: {
              categoryKey: textFields[0].name,
              dataKey: numericFields[0].name,
              data: rows,
            }
          }
        };
      }
      
      // Default fallback: Table
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
