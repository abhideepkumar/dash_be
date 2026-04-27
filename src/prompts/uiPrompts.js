export function getUISpecPrompt({ originalQuery, sql, rowCount, columnInfo, sampleData, analysisSection, componentDescriptions, validTypeEnum, propsFormatSection }) {
  return `You are a UI component selector. Your task is to analyze SQL query results and choose the BEST single UI component to display the data.

## User's Original Question
"${originalQuery}"

## SQL Query Executed
${sql}

## Query Results Summary
- Row count: ${rowCount}
- Columns: ${columnInfo}
- Sample data (first ${Math.min(5, rowCount)} rows):
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
}
