import OpenAI from "openai";
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateInsights } from './insightGenerator.js';

// Get current directory for loading component metadata
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load component metadata
const componentMetadataPath = join(__dirname, '../config/component_metadata.json');
const componentMetadata = JSON.parse(readFileSync(componentMetadataPath, 'utf-8'));

// Groq client (lazy-initialized)
let client = null;

function getGroqClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  return client;
}

// Time-related column name patterns
const TIME_PATTERNS = /^(date|month|year|week|quarter|day|time|period|created|updated|timestamp)$|(_at|_date|_time)$/i;

/**
 * Analyze data shape to determine the best visualization strategy
 * @param {Array} rows - Query result rows
 * @param {Array} fields - Field definitions
 * @returns {object} Data analysis results
 */
function analyzeDataShape(rows, fields) {
  if (!rows.length || !fields.length) {
    return {
      rowCount: 0,
      categoryColumns: [],
      numericColumns: [],
      isTimeSeries: false,
      isMultiSeries: false,
      seriesCount: 0,
      recommendedChart: 'Table',
      analysisNotes: 'No data to analyze'
    };
  }

  const rowCount = rows.length;
  const sample = rows.slice(0, Math.min(50, rows.length));
  
  // Classify columns as numeric or categorical
  const numericColumns = [];
  const categoryColumns = [];
  let timeColumn = null;

  fields.forEach(field => {
    const colName = field.name;
    const values = sample.map(row => row[colName]).filter(v => v != null);
    
    // Check if it's a time-related column
    if (TIME_PATTERNS.test(colName)) {
      timeColumn = {
        name: colName,
        uniqueCount: new Set(values).size
      };
      return;
    }
    
    // Check if numeric (at least 80% of non-null values are numbers)
    const numericCount = values.filter(v => !isNaN(Number(v)) && typeof v !== 'boolean').length;
    const isNumeric = values.length > 0 && (numericCount / values.length) >= 0.8;
    
    if (isNumeric) {
      numericColumns.push({
        name: colName,
        min: Math.min(...values.map(Number)),
        max: Math.max(...values.map(Number)),
        avg: values.reduce((sum, v) => sum + Number(v), 0) / values.length
      });
    } else {
      const uniqueValues = new Set(values);
      categoryColumns.push({
        name: colName,
        uniqueCount: uniqueValues.size,
        sampleValues: Array.from(uniqueValues).slice(0, 5)
      });
    }
  });

  // Determine data patterns
  const isTimeSeries = timeColumn !== null;
  const hasMultipleCategories = categoryColumns.length >= 2;
  const hasOneCategoryOneTime = categoryColumns.length === 1 && isTimeSeries;
  
  // For multi-series: if we have both a time column and a category column (like user + month)
  // the series count is the unique values in the category column
  let isMultiSeries = false;
  let seriesColumn = null;
  let seriesCount = 0;

  if (isTimeSeries && categoryColumns.length >= 1) {
    // If there's a time column and at least one category, it's potentially multi-series
    // The category with the most unique values is likely the series column
    seriesColumn = categoryColumns.reduce((max, col) => 
      col.uniqueCount > (max?.uniqueCount || 0) ? col : max, null);
    if (seriesColumn && seriesColumn.uniqueCount > 1) {
      isMultiSeries = true;
      seriesCount = seriesColumn.uniqueCount;
    }
  } else if (categoryColumns.length >= 2 && numericColumns.length >= 1) {
    // Two categorical dimensions + numeric = grouped/stacked potential
    isMultiSeries = true;
    seriesColumn = categoryColumns[1]; // second category becomes series
    seriesCount = seriesColumn.uniqueCount;
  }

  // Recommend chart type based on analysis
  let recommendedChart = 'Table';
  let analysisNotes = '';

  if (rowCount === 1 && (numericColumns.length === 1 || (numericColumns.length === 0 && categoryColumns.length <= 2))) {
    recommendedChart = 'Card';
    analysisNotes = 'Single row with 1-2 values → Card';
  } else if (isMultiSeries && seriesCount > 5) {
    recommendedChart = 'Heatmap';
    analysisNotes = `Multi-series with ${seriesCount} series (>5) → Heatmap for 2D grid visualization`;
  } else if (isMultiSeries && seriesCount <= 5) {
    recommendedChart = isTimeSeries ? 'LineChart' : 'BarChart';
    analysisNotes = `Multi-series with ${seriesCount} series (≤5) → ${recommendedChart} with seriesKey`;
  } else if (isTimeSeries && numericColumns.length >= 1) {
    recommendedChart = 'LineChart';
    analysisNotes = 'Time series data → LineChart';
  } else if (categoryColumns.length === 1 && numericColumns.length >= 1) {
    if (rowCount <= 8) {
      recommendedChart = 'PieChart';
      analysisNotes = `${rowCount} categories (≤8) → PieChart`;
    } else if (rowCount <= 50) {
      recommendedChart = 'BarChart';
      analysisNotes = `${rowCount} categories (9-50) → BarChart`;
    } else {
      recommendedChart = 'Table';
      analysisNotes = `${rowCount} categories (>50) → Table for readability`;
    }
  } else if (rowCount > 100) {
    recommendedChart = 'Table';
    analysisNotes = `Large dataset (${rowCount} rows) → Table`;
  }

  return {
    rowCount,
    categoryColumns,
    numericColumns,
    timeColumn,
    isTimeSeries,
    isMultiSeries,
    seriesColumn: seriesColumn?.name || null,
    seriesCount,
    recommendedChart,
    analysisNotes
  };
}

/**
 * Analyze query result data and generate a UI specification with insights
 * @param {object} params - Parameters for UI generation
 * @param {string} params.originalQuery - The original natural language query
 * @param {string} params.sql - The executed SQL query
 * @param {Array} params.rows - The query result rows
 * @param {Array} params.fields - The query result field definitions
 * @returns {Promise<object>} UI specification JSON with insights
 */
export async function generateUISpec({ originalQuery, sql, rows, fields }) {
  // Analyze data shape first
  const dataAnalysis = analyzeDataShape(rows, fields);
  console.log('[UI GENERATOR] Data analysis:', JSON.stringify(dataAnalysis, null, 2));
  
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

  // Build data analysis section for the prompt
  const analysisSection = `
## Data Analysis (PRE-COMPUTED - follow these recommendations)
- Row count: ${dataAnalysis.rowCount}
- Category columns: ${dataAnalysis.categoryColumns.map(c => `${c.name} (${c.uniqueCount} unique)`).join(', ') || 'none'}
- Numeric columns: ${dataAnalysis.numericColumns.map(c => c.name).join(', ') || 'none'}
- Time column: ${dataAnalysis.timeColumn?.name || 'none'}
- Is time series: ${dataAnalysis.isTimeSeries}
- Is multi-series: ${dataAnalysis.isMultiSeries}
- Series column: ${dataAnalysis.seriesColumn || 'N/A'}
- Series count: ${dataAnalysis.seriesCount}
- **RECOMMENDED CHART: ${dataAnalysis.recommendedChart}**
- Analysis notes: ${dataAnalysis.analysisNotes}
`;

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
${analysisSection}

## Available UI Components
${componentDescriptions}

## CRITICAL: Multi-Series Data Handling Rules
1. If "Is multi-series" is TRUE and "Series count" > 5:
   → Use **Heatmap** (perfect for user×month, product×region grids)
   → Shows 2D grid with color intensity for values
2. If "Is multi-series" is TRUE and "Series count" ≤ 5:
   → Use LineChart (if time-based) or BarChart with "seriesKey" prop
3. If data has a time column with only 1 category dimension:
   → Use LineChart (single line trend)

## Selection Priority (follow this order)
1. Single aggregate value (COUNT, SUM, AVG, 1 row 1-2 cols) → Card
2. **Two categorical dimensions + 1 numeric (>5 series)** → Heatmap (BEST for grids like user×month)
3. Multi-series data (2 grouping dimensions, ≤5 series) → LineChart/BarChart WITH seriesKey  
4. Single-series temporal data (date/month + numbers) → LineChart
5. Category comparison (1 label + values, ≤8 rows) → PieChart
6. Category comparison (1 label + values, 9-50 rows) → BarChart
7. Large datasets (>50 rows) or fallback → Table

## Props Format by Component Type

For Card:
{ "title": "label", "value": the_value, "description": "context" }

For BarChart/LineChart/AreaChart (single-series):
{ "categoryKey": "x_axis_column", "dataKey": "numeric_column" }

For BarChart/LineChart/AreaChart (MULTI-SERIES - ≤5 series):
{ 
  "categoryKey": "x_axis_column (usually time/date)", 
  "dataKey": "numeric_column",
  "seriesKey": "column_that_groups_series (e.g., user_name, category)"
}

For Heatmap (MULTI-SERIES - >5 series, 2D grid):
{
  "xKey": "column_for_x_axis (e.g., month, date)",
  "yKey": "column_for_y_axis (e.g., user_name, product)",
  "valueKey": "numeric_column_for_color_intensity"
}

For PieChart:
{ "nameKey": "column_for_labels", "dataKey": "column_for_values" }

For Table:
{ "columns": [{"Header": "Display Name", "accessor": "column_name"}], "caption": "description" }

## Rules
1. DO NOT include "data" in props - it will be injected automatically
2. Use exact column names from the sample data
3. Output ONLY valid JSON, no explanation, no markdown code blocks
4. STRONGLY prefer Heatmap when isMultiSeries=true and seriesCount>5
5. Heatmap is IDEAL for queries like "each user spends per month" or "sales by product per region"

## Required Output Format (JSON only)
{
  "title": "A descriptive title for this visualization",
  "description": "Brief explanation of what the data shows",
  "component": {
    "type": "Card" | "BarChart" | "LineChart" | "AreaChart" | "PieChart" | "Heatmap" | "Table",
    "props": { ... }
  }
}

JSON Output:`;

  try {
    // Generate UI spec and insights in parallel for better performance
    const [uiResponse, insights] = await Promise.all([
      getGroqClient().chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      generateInsights({ originalQuery, rows, fields, chartType: null })
    ]);

    let content = uiResponse.choices[0].message.content.trim();
    
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
    const dataComponents = ['Table', 'BarChart', 'LineChart', 'AreaChart', 'PieChart', 'RadialChart', 'Heatmap'];
    if (dataComponents.includes(uiSpec.component.type)) {
      uiSpec.component.props.data = rows;
      
      // For Table: ensure columns are present
      if (uiSpec.component.type === 'Table') {
        if (!uiSpec.component.props.columns || uiSpec.component.props.columns.length === 0) {
          uiSpec.component.props.columns = fields.map(f => ({ Header: f.name, accessor: f.name }));
        }
      }
    }

    // Add insights to the response
    uiSpec.insights = insights;

    console.log(`[UI GENERATOR] Selected component: ${uiSpec.component.type} with ${insights.length} insights for query: "${originalQuery}"`);
    
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
          },
          insights: []
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
        },
        insights: []
      };
    }
    
    throw new Error('Failed to generate UI specification: ' + error.message);
  }
}

