import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { generateInsights } from './insightGenerator.js';
import { callLLM } from '../utils/llmClient.js';

// Get current directory for loading component metadata
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load component metadata
const componentMetadataPath = join(__dirname, '../config/component_metadata.json');
const componentMetadata = JSON.parse(readFileSync(componentMetadataPath, 'utf-8'));

// Time-related column name patterns
const TIME_PATTERNS = /^(date|month|year|week|quarter|day|time|period|created|updated|timestamp)$|(_at|_date|_time)$/i;

/**
 * Analyze data shape to determine the best visualization strategy.
 * Returns data pattern descriptors instead of hardcoded chart recommendations,
 * so the LLM can match patterns to the `use_when` field in component metadata.
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
      dataPatterns: ['no_data'],
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

  // Build data pattern tags (descriptive, not prescriptive)
  const dataPatterns = [];
  
  if (rowCount === 1 && numericColumns.length >= 2) {
    // Single row with multiple numeric columns → StatGrid (multi-KPI overview)
    dataPatterns.push('single_row_multi_column');
  } else if (rowCount === 1 && (numericColumns.length <= 2 && categoryColumns.length <= 2)) {
    dataPatterns.push('single_value');
  }
  if (isTimeSeries) {
    dataPatterns.push('time_series');
  }
  if (isMultiSeries && seriesCount > 5) {
    dataPatterns.push('high_cardinality_series');
    dataPatterns.push('two_dimensions');
  }
  if (isMultiSeries && seriesCount <= 5) {
    dataPatterns.push('low_cardinality_series');
  }
  if (categoryColumns.length === 1 && numericColumns.length >= 1 && !isTimeSeries) {
    dataPatterns.push('category_comparison');
    if (rowCount <= 8) dataPatterns.push('few_categories');
    if (rowCount > 8 && rowCount <= 50) dataPatterns.push('moderate_categories');
    if (rowCount > 8) dataPatterns.push('many_categories'); // TreeMap candidate
  }
  if (numericColumns.length >= 1) {
    dataPatterns.push('has_numeric');
    const allBetween0and100 = numericColumns.every(c => c.min >= 0 && c.max <= 100);
    if (allBetween0and100 && rowCount <= 5) dataPatterns.push('percentage_range');
  }
  // Two numeric columns with no clear series → ScatterChart or ComboChart
  if (numericColumns.length >= 2 && categoryColumns.length <= 1 && !isMultiSeries && rowCount > 1) {
    if (isTimeSeries || (categoryColumns.length === 1)) {
      dataPatterns.push('dual_numeric_time'); // ComboChart candidate
    } else {
      dataPatterns.push('two_numeric_columns'); // ScatterChart candidate
    }
  }
  // Ordered-stages heuristic: single category + single numeric + monotonically decreasing values
  if (categoryColumns.length === 1 && numericColumns.length === 1 && rowCount >= 3 && rowCount <= 12) {
    const numKey = numericColumns[0].name;
    const vals = rows.map(r => Number(r[numKey])).filter(v => !isNaN(v));
    const isDecreasing = vals.every((v, i) => i === 0 || v <= vals[i - 1]);
    if (isDecreasing) dataPatterns.push('ordered_stages'); // FunnelChart candidate
  }
  if (rowCount > 50) {
    dataPatterns.push('large_dataset');
  }
  if (dataPatterns.length === 0) {
    dataPatterns.push('general');
  }

  // Build analysis notes (human readable summary)
  let analysisNotes = `${rowCount} rows, ${numericColumns.length} numeric cols, ${categoryColumns.length} category cols`;
  if (isTimeSeries) analysisNotes += ', time-series detected';
  if (isMultiSeries) analysisNotes += `, multi-series (${seriesCount} series)`;

  return {
    rowCount,
    categoryColumns,
    numericColumns,
    timeColumn,
    isTimeSeries,
    isMultiSeries,
    seriesColumn: seriesColumn?.name || null,
    seriesCount,
    dataPatterns,
    analysisNotes
  };
}

/**
 * Try to select a UI component deterministically based on unambiguous data patterns.
 * Returns null if the pattern is ambiguous and should fall through to LLM.
 * 
 * This saves ~4-5 seconds and ~4k tokens per query for simple shapes.
 */
function tryDeterministicUISelection(dataAnalysis, rows, fields, originalQuery) {
  const { dataPatterns, rowCount, categoryColumns, numericColumns, timeColumn } = dataAnalysis;

  // Pattern 1: Single value → Card
  if (dataPatterns.includes('single_value') && rowCount === 1) {
    const firstRow = rows[0];
    const numField = fields.find(f => !isNaN(Number(firstRow[f.name])) && firstRow[f.name] !== null);
    const textField = fields.find(f => isNaN(Number(firstRow[f.name])));
    
    const value = numField ? firstRow[numField.name] : (textField ? firstRow[textField.name] : Object.values(firstRow)[0]);
    const label = textField ? firstRow[textField.name] : (numField ? numField.name.replace(/_/g, ' ') : 'Result');
    
    return {
      title: originalQuery,
      description: `Answer to: ${originalQuery}`,
      component: {
        type: 'Card',
        props: {
          title: typeof label === 'string' ? label : String(label),
          value: value,
          description: numField ? numField.name.replace(/_/g, ' ') : null,
        }
      }
    };
  }

  // Pattern 2: Single row, multiple numeric columns → StatGrid
  if (dataPatterns.includes('single_row_multi_column') && rowCount === 1) {
    const firstRow = rows[0];
    const metrics = fields
      .filter(f => !isNaN(Number(firstRow[f.name])) && firstRow[f.name] !== null)
      .map(f => ({
        title: f.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        value: firstRow[f.name],
        description: null,
        trend: null,
      }));
    
    if (metrics.length >= 2) {
      return {
        title: originalQuery,
        description: `Summary metrics for: ${originalQuery}`,
        component: {
          type: 'StatGrid',
          props: { metrics }
        }
      };
    }
  }

  // Pattern 3: Category + single metric, few items → BarChart
  if (dataPatterns.includes('category_comparison') && dataPatterns.includes('few_categories')
      && categoryColumns.length === 1 && numericColumns.length >= 1 && rowCount > 1) {
    return {
      title: originalQuery,
      description: `Comparison by ${categoryColumns[0].name.replace(/_/g, ' ')}`,
      component: {
        type: 'BarChart',
        props: {
          categoryKey: categoryColumns[0].name,
          dataKey: numericColumns[0].name,
          data: rows,
        }
      }
    };
  }

  // Pattern 4: Time series + single metric → LineChart
  if (dataPatterns.includes('time_series') && !dataPatterns.includes('low_cardinality_series')
      && numericColumns.length >= 1 && timeColumn && rowCount > 1) {
    return {
      title: originalQuery,
      description: `Trend over ${timeColumn.name.replace(/_/g, ' ')}`,
      component: {
        type: 'LineChart',
        props: {
          xKey: timeColumn.name,
          yKey: numericColumns[0].name,
          data: rows,
        }
      }
    };
  }

  // No clear deterministic match → fall through to LLM
  return null;
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

  // --- FAST PATH: Deterministic UI selection for unambiguous shapes ---
  // This avoids the LLM call (~4-5s and ~4k tokens) for clear patterns.
  const deterministicSpec = tryDeterministicUISelection(dataAnalysis, rows, fields, originalQuery);
  
  if (deterministicSpec) {
    console.log(`[UI GENERATOR] Deterministic selection: ${deterministicSpec.component.type} (skipped LLM)`);
    
    // Still generate insights in parallel (they add value)
    try {
      const insightsResponse = await generateInsights({ originalQuery, rows, fields, chartType: deterministicSpec.component.type });
      deterministicSpec.insights = insightsResponse.data || [];
      if (insightsResponse.metrics) {
        deterministicSpec.metrics = insightsResponse.metrics;
      }
    } catch (err) {
      console.warn('[UI GENERATOR] Insight generation failed for deterministic path:', err.message);
      deterministicSpec.insights = [];
    }
    
    return deterministicSpec;
  }

  // --- SLOW PATH: LLM-based UI selection for ambiguous shapes ---
  
  // Prepare data summary for the LLM
  const rowCount = rows.length;
  const columnInfo = fields.map(f => f.name).join(', ');
  
  // Sample data (first 4 rows) to help LLM understand the data shape
  const sampleData = rows.slice(0, 4);
  
  // --- DYNAMICALLY GENERATED from component_metadata.json ---

  // 1. Component descriptions (already dynamic - good)
  const componentDescriptions = componentMetadata.map(c => {
    return `### ${c.component} (priority: ${c.priority})
Description: ${c.description}
Use when: ${c.use_when}
Expected props: ${JSON.stringify(c.expects, null, 2)}`;
  }).join('\n\n');

  // 2. Valid type enum - dynamically generated
  const validTypeEnum = componentMetadata.map(c => `"${c.component}"`).join(' | ');

  // 3. Props format section - dynamically generated from props_example
  const propsFormatSection = componentMetadata
    .filter(c => c.props_example)
    .map(c => `For ${c.component}:\n${JSON.stringify(c.props_example, null, 2)}`)
    .join('\n\n');

  // 4. Data analysis section for the prompt
  const analysisSection = `
## Data Analysis (PRE-COMPUTED)
- Row count: ${dataAnalysis.rowCount}
- Category columns: ${dataAnalysis.categoryColumns.map(c => `${c.name} (${c.uniqueCount} unique)`).join(', ') || 'none'}
- Numeric columns: ${dataAnalysis.numericColumns.map(c => c.name).join(', ') || 'none'}
- Time column: ${dataAnalysis.timeColumn?.name || 'none'}
- Is time series: ${dataAnalysis.isTimeSeries}
- Is multi-series: ${dataAnalysis.isMultiSeries}
- Series column: ${dataAnalysis.seriesColumn || 'N/A'}
- Series count: ${dataAnalysis.seriesCount}
- **Data patterns: [${dataAnalysis.dataPatterns.join(', ')}]**
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

## How to Choose
1. Look at the **Data patterns** above
2. Match them against each component's **"Use when"** criteria
3. Prefer components with lower **priority** numbers when multiple match
4. **Pattern → Component guidance:**
   - \`single_row_multi_column\` → **StatGrid** (multiple KPI tiles from one summary row)
   - \`single_value\` → **Card** (single KPI)
   - \`two_numeric_columns\` → **ScatterChart** (correlation between two numeric vars)
   - \`dual_numeric_time\` → **ComboChart** (two metrics on dual axes over time/category)
   - \`ordered_stages\` → **FunnelChart** (pipeline/conversion stages)
   - \`many_categories\` → **TreeMap** (proportional area for many categories)
   - \`few_categories\` + part-to-whole question → **PieChart**
   - \`high_cardinality_series\` or \`two_dimensions\` → **Heatmap**
   - \`low_cardinality_series\` + time → **LineChart** with seriesKey
   - \`low_cardinality_series\` + category → **BarChart** with seriesKey
   - \`time_series\` (single series) → **LineChart** or **AreaChart**
   - \`category_comparison\` (single series) → **BarChart**
   - \`percentage_range\` → **RadialChart** or **GaugeChart** (if question mentions target)
5. For percentage/completion **against a target**: Use **GaugeChart**
6. P&L, variance, bridge analysis: Use **WaterfallChart**
7. For status labels: Consider **Badge**
8. **Table is the LAST resort** — only when data is too heterogeneous for any chart

## Props Format Examples (use these as reference for the correct prop shape)
${propsFormatSection}

## Rules
1. DO NOT include "data" in props - it will be injected automatically
2. Use exact column names from the sample data
3. Output ONLY valid JSON, no explanation, no markdown code blocks
4. For multi-series BarChart/LineChart/AreaChart, include "seriesKey" prop

## Required Output Format (JSON only)
{
  "title": "A descriptive title for this visualization",
  "description": "Brief explanation of what the data shows",
  "component": {
    "type": ${validTypeEnum},
    "props": { ... }
  }
}

JSON Output:`;

  try {
    // Generate UI spec and insights in parallel for better performance
    const [uiResponse, insightsResponse] = await Promise.all([
      callLLM(
        [{ role: 'user', content: prompt }],
        { temperature: 0.1, max_tokens: 2000 }
      ),
      generateInsights({ originalQuery, rows, fields, chartType: null })
    ]);

    let content = uiResponse.content.trim();
    
    // Extract and combine metrics
    let combinedMetrics = null;
    const uiMetrics = uiResponse.usage ? { tokens: uiResponse.usage, cost: uiResponse.costDetails?.estimatedCost } : null;
    const insightMetrics = insightsResponse.metrics;
    
    if (uiMetrics || insightMetrics) {
       combinedMetrics = {
          tokens: {
             promptTokens: (uiMetrics?.tokens?.promptTokens || 0) + (insightMetrics?.tokens?.promptTokens || 0),
             completionTokens: (uiMetrics?.tokens?.completionTokens || 0) + (insightMetrics?.tokens?.completionTokens || 0),
             totalTokens: (uiMetrics?.tokens?.totalTokens || 0) + (insightMetrics?.tokens?.totalTokens || 0),
          },
          cost: (uiMetrics?.cost || 0) + (insightMetrics?.cost || 0)
       };
    }
    
    const insights = insightsResponse.data || [];
    
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

    // Validate component type against metadata (dynamic, not hardcoded)
    const validTypes = componentMetadata.map(c => c.component);
    if (!validTypes.includes(uiSpec.component.type)) {
      throw new Error(`Invalid component type: ${uiSpec.component.type}. Must be one of: ${validTypes.join(', ')}`);
    }

    // METADATA-DRIVEN data injection: check needs_data from component metadata
    const componentMeta = componentMetadata.find(c => c.component === uiSpec.component.type);
    if (componentMeta?.needs_data) {
      uiSpec.component.props.data = rows;
      
      // For Table: ensure columns are present
      if (uiSpec.component.type === 'Table') {
        if (!uiSpec.component.props.columns || uiSpec.component.props.columns.length === 0) {
          uiSpec.component.props.columns = fields.map(f => ({ Header: f.name, accessor: f.name }));
        }
      }
    }

    // POST-PROCESSING for StatGrid: auto-build metrics array from single-row result
    // The LLM sets type=StatGrid but may not know the actual values — inject them
    if (uiSpec.component.type === 'StatGrid' && rows.length > 0) {
      const firstRow = rows[0];
      const numericFields = fields.filter(f => {
        const v = firstRow[f.name];
        return v !== null && v !== undefined && !isNaN(Number(v));
      });
      // If LLM didn't produce a valid metrics array, auto-build it
      if (!Array.isArray(uiSpec.component.props.metrics) || uiSpec.component.props.metrics.length === 0) {
        uiSpec.component.props.metrics = numericFields.map(f => ({
          title: f.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          value: firstRow[f.name],
          description: null,
          trend: null,
        }));
      } else {
        // Merge LLM-provided titles/descriptions with actual values from rows
        uiSpec.component.props.metrics = uiSpec.component.props.metrics.map(metric => ({
          ...metric,
          value: metric.value !== undefined ? metric.value : firstRow[metric.valueKey || metric.title?.toLowerCase().replace(/ /g, '_')],
        }));
      }
    }

    // POST-PROCESSING for GaugeChart: inject numeric value from rows if not set
    if (uiSpec.component.type === 'GaugeChart' && rows.length > 0) {
      const props = uiSpec.component.props;
      if (props.value === undefined || props.value === null) {
        // Take first numeric field as the value
        const firstRow = rows[0];
        const numericField = fields.find(f => !isNaN(Number(firstRow[f.name])) && firstRow[f.name] !== null);
        if (numericField) props.value = Number(firstRow[numericField.name]);
      }
      // Ensure max is set to a reasonable default
      if (props.max === undefined || props.max === null) {
        props.max = 100;
      }
    }

    // Add insights to the response
    uiSpec.insights = insights;
    if (combinedMetrics) {
      uiSpec.metrics = combinedMetrics;
    }

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
