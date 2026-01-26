/**
 * Advanced Data Insight Generator
 * 
 * 4-Stage Pipeline:
 * 1. CLASSIFY - Determine data story type (trend, comparison, distribution, KPI)
 * 2. ANALYZE - Calculate statistics appropriate for the story type
 * 3. SYNTHESIZE - Use LLM to generate human-readable insights
 * 4. PRIORITIZE - Score and rank insights by importance
 */

import OpenAI from "openai";

// Groq client
const groqClient = new OpenAI({
  apiKey: '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',
  baseURL: "https://api.groq.com/openai/v1",
});

// ============================================
// STAGE 1: DATA CLASSIFICATION
// ============================================

/**
 * Classify the data shape to determine what type of analysis to perform
 */
function classifyDataShape(rows, fields, query) {
  const analysis = {
    storyType: null,      // 'trend' | 'comparison' | 'distribution' | 'kpi'
    timeColumn: null,     // Detected time/date column
    metricColumns: [],    // Numeric columns (measures)
    dimensionColumns: [], // Categorical columns (dimensions)
    rowCount: rows.length
  };
  
  // Detect column types
  for (const field of fields) {
    const values = rows.map(r => r[field.name]).filter(v => v != null);
    
    if (isTemporalColumn(field.name, values)) {
      analysis.timeColumn = field.name;
    } else if (isNumericColumn(values)) {
      analysis.metricColumns.push(field.name);
    } else {
      analysis.dimensionColumns.push(field.name);
    }
  }
  
  // Determine story type based on data shape
  if (rows.length === 1 && analysis.metricColumns.length <= 2) {
    analysis.storyType = 'kpi';  // Single value/metric
  } else if (analysis.timeColumn && analysis.metricColumns.length > 0) {
    analysis.storyType = 'trend';  // Time series
  } else if (analysis.dimensionColumns.length > 0 && analysis.metricColumns.length > 0) {
    analysis.storyType = 'comparison';  // Category comparison
  } else {
    analysis.storyType = 'distribution';  // General distribution
  }
  
  return analysis;
}

/**
 * Check if column contains temporal data
 */
function isTemporalColumn(name, values) {
  const temporalKeywords = ['date', 'time', 'month', 'year', 'day', 'week', 'quarter', 'period', 'created', 'updated'];
  const nameMatch = temporalKeywords.some(k => name.toLowerCase().includes(k));
  
  // Check if values look like dates
  const sampleValues = values.slice(0, 5);
  const datePattern = /^\d{4}-\d{2}|\d{2}\/\d{2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
  const valueMatch = sampleValues.some(v => 
    v && (datePattern.test(String(v)) || !isNaN(Date.parse(String(v))))
  );
  
  return nameMatch || valueMatch;
}

/**
 * Check if column contains numeric data
 */
function isNumericColumn(values) {
  const sampleValues = values.slice(0, 10).filter(v => v != null);
  if (sampleValues.length === 0) return false;
  
  const numericCount = sampleValues.filter(v => {
    const num = Number(v);
    return !isNaN(num) && typeof v !== 'boolean';
  }).length;
  
  return numericCount / sampleValues.length > 0.8;
}

// ============================================
// STAGE 2: STATISTICAL ANALYSIS
// ============================================

/**
 * Analyze data based on its classification
 */
function analyzeData(rows, classification) {
  const { storyType, timeColumn, metricColumns, dimensionColumns } = classification;
  
  const stats = {
    storyType,
    rowCount: rows.length,
    metrics: {}
  };
  
  // Analyze each metric column
  for (const metricCol of metricColumns) {
    const values = rows.map(r => Number(r[metricCol])).filter(n => !isNaN(n));
    stats.metrics[metricCol] = analyzeNumericColumn(values);
  }
  
  // Story-specific analysis
  switch (storyType) {
    case 'trend':
      if (metricColumns[0]) {
        const values = rows.map(r => Number(r[metricColumns[0]])).filter(n => !isNaN(n));
        stats.trendAnalysis = analyzeTimeSeries(values, rows, timeColumn);
      }
      break;
      
    case 'comparison':
      if (dimensionColumns[0] && metricColumns[0]) {
        stats.comparisonAnalysis = analyzeCategorical(rows, dimensionColumns[0], metricColumns[0]);
      }
      break;
      
    case 'kpi':
      stats.kpiAnalysis = { value: rows[0]?.[metricColumns[0]] };
      break;
  }
  
  return stats;
}

/**
 * Basic numeric column statistics
 */
function analyzeNumericColumn(values) {
  if (values.length === 0) return null;
  
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  
  // Standard deviation
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  
  return {
    count: values.length,
    sum: roundNum(sum),
    mean: roundNum(mean),
    min: roundNum(min),
    max: roundNum(max),
    stdDev: roundNum(stdDev),
    range: roundNum(max - min)
  };
}

/**
 * Time series analysis
 */
function analyzeTimeSeries(values, rows, timeColumn) {
  if (values.length < 2) {
    return { trend: 'insufficient_data' };
  }
  
  const first = values[0];
  const last = values[values.length - 1];
  const percentChange = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
  
  // Trend direction using linear regression
  const regression = linearRegression(values);
  
  // Period comparison (first half vs second half)
  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);
  const avgFirst = mean(firstHalf);
  const avgSecond = mean(secondHalf);
  const halfChange = avgFirst !== 0 ? ((avgSecond - avgFirst) / Math.abs(avgFirst)) * 100 : 0;
  
  // Detect anomalies (values > 2 std from mean)
  const avg = mean(values);
  const std = standardDeviation(values);
  const anomalies = [];
  values.forEach((v, i) => {
    if (Math.abs(v - avg) > 2 * std) {
      anomalies.push({ index: i, value: v, timeValue: rows[i]?.[timeColumn] });
    }
  });
  
  // Find peak and trough
  const maxIdx = values.indexOf(Math.max(...values));
  const minIdx = values.indexOf(Math.min(...values));
  
  return {
    trend: regression.slope > 0.1 ? 'increasing' : regression.slope < -0.1 ? 'decreasing' : 'stable',
    percentChange: roundNum(percentChange),
    periodComparison: {
      firstHalfAvg: roundNum(avgFirst),
      secondHalfAvg: roundNum(avgSecond),
      changePercent: roundNum(halfChange)
    },
    peak: { index: maxIdx, value: values[maxIdx], timeValue: rows[maxIdx]?.[timeColumn] },
    trough: { index: minIdx, value: values[minIdx], timeValue: rows[minIdx]?.[timeColumn] },
    anomalyCount: anomalies.length,
    anomalies: anomalies.slice(0, 3) // Limit to 3
  };
}

/**
 * Categorical comparison analysis
 */
function analyzeCategorical(rows, dimension, metric) {
  // Group by dimension
  const grouped = {};
  for (const row of rows) {
    const key = String(row[dimension] || 'Unknown');
    const value = Number(row[metric]) || 0;
    grouped[key] = (grouped[key] || 0) + value;
  }
  
  const sorted = Object.entries(grouped).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [_, val]) => sum + val, 0);
  
  // Top and bottom performers
  const topN = sorted.slice(0, 3).map(([cat, val]) => ({
    category: cat,
    value: roundNum(val),
    percentage: roundNum((val / total) * 100)
  }));
  
  const bottomN = sorted.slice(-3).reverse().map(([cat, val]) => ({
    category: cat,
    value: roundNum(val),
    percentage: roundNum((val / total) * 100)
  }));
  
  // Pareto analysis (what % of categories make up 80% of value)
  let cumulative = 0;
  let paretoCount = 0;
  for (const [_, val] of sorted) {
    cumulative += val;
    paretoCount++;
    if (cumulative / total >= 0.8) break;
  }
  
  // Concentration ratio
  const top1Share = sorted[0] ? (sorted[0][1] / total) * 100 : 0;
  const top3Share = sorted.slice(0, 3).reduce((s, [_, v]) => s + v, 0) / total * 100;
  
  return {
    categoryCount: sorted.length,
    total: roundNum(total),
    topN,
    bottomN,
    pareto: {
      categoriesFor80Percent: paretoCount,
      totalCategories: sorted.length,
      ratio: roundNum(paretoCount / sorted.length * 100)
    },
    concentration: {
      top1Percent: roundNum(top1Share),
      top3Percent: roundNum(top3Share)
    },
    spread: {
      max: sorted[0]?.[1] || 0,
      min: sorted[sorted.length - 1]?.[1] || 0,
      ratio: sorted[sorted.length - 1]?.[1] ? roundNum(sorted[0][1] / sorted[sorted.length - 1][1]) : 0
    }
  };
}

// ============================================
// STAGE 3: LLM SYNTHESIS
// ============================================

/**
 * Use LLM to synthesize human-readable insights from statistics
 */
async function synthesizeInsights(classification, statistics, originalQuery, sampleRows) {
  const prompt = `You are a senior data analyst at a Fortune 500 company. Generate insightful observations from this data analysis.

## User's Question
"${originalQuery}"

## Data Classification
- Story Type: ${classification.storyType}
- Row Count: ${classification.rowCount}
- Metrics: ${classification.metricColumns.join(', ') || 'None detected'}
- Dimensions: ${classification.dimensionColumns.join(', ') || 'None detected'}
- Time Column: ${classification.timeColumn || 'None'}

## Statistical Analysis
${JSON.stringify(statistics, null, 2)}

## Sample Data (first 4 rows)
${JSON.stringify(sampleRows.slice(0, 4), null, 2)}

## Instructions
Generate 3-4 insights following these STRICT rules:

1. **Lead with the answer** to the user's question
2. **Use specific numbers** - percentages, amounts, ratios
3. **Explain significance** - why this matters
4. **Be actionable** - what should the user consider?
5. **Highlight anomalies** - anything unexpected

For each insight provide:
- type: "summary" | "trend" | "peak" | "comparison" | "anomaly" | "recommendation"
- priority: "high" | "medium" | "low"
- text: 1-2 sentences, specific and data-backed
- evidence: The specific numbers supporting this

Return ONLY a valid JSON array, no markdown:
[{"type":"...","priority":"...","text":"...","evidence":"..."}]`;

  try {
    const response = await groqClient.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 800,
    });
    
    let content = response.choices[0].message.content.trim();
    
    // Clean up response
    if (content.startsWith('```json')) content = content.slice(7);
    if (content.startsWith('```')) content = content.slice(3);
    if (content.endsWith('```')) content = content.slice(0, -3);
    content = content.trim();
    
    const insights = JSON.parse(content);
    console.log(`[INSIGHTS] LLM generated ${insights.length} insights`);
    return insights;
    
  } catch (error) {
    console.error('[INSIGHTS] LLM synthesis failed:', error.message);
    // Fallback insight
    return [{
      type: 'summary',
      priority: 'medium',
      text: `Analysis of ${classification.rowCount} records for "${originalQuery}".`,
      evidence: `${classification.metricColumns.length} metrics, ${classification.dimensionColumns.length} dimensions`
    }];
  }
}

// ============================================
// STAGE 4: PRIORITIZATION
// ============================================

/**
 * Score and rank insights by importance
 */
function prioritizeInsights(insights) {
  const scored = insights.map(insight => ({
    ...insight,
    score: calculateInsightScore(insight)
  }));
  
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Calculate importance score for an insight
 */
function calculateInsightScore(insight) {
  let score = 0;
  
  // Priority weight
  if (insight.priority === 'high') score += 30;
  else if (insight.priority === 'medium') score += 20;
  else score += 10;
  
  // Type weight (more actionable = higher)
  const typeWeights = {
    'anomaly': 25,
    'recommendation': 20,
    'trend': 15,
    'comparison': 12,
    'peak': 10,
    'summary': 8
  };
  score += typeWeights[insight.type] || 5;
  
  // Evidence strength
  if (insight.evidence) {
    if (insight.evidence.includes('%')) score += 5;
    if (insight.evidence.includes('$') || insight.evidence.match(/\d+,\d+/)) score += 3;
  }
  
  return score;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function standardDeviation(arr) {
  const avg = mean(arr);
  const squaredDiffs = arr.map(v => Math.pow(v - avg, 2));
  return Math.sqrt(mean(squaredDiffs));
}

function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: 0 };
  
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  return { slope, intercept };
}

function roundNum(num) {
  if (typeof num !== 'number' || isNaN(num)) return 0;
  if (Math.abs(num) >= 1000) return Math.round(num);
  if (Math.abs(num) >= 10) return Math.round(num * 10) / 10;
  return Math.round(num * 100) / 100;
}

// ============================================
// MAIN EXPORT
// ============================================

/**
 * Generate insights for data query results
 * 
 * @param {Object} params
 * @param {string} params.originalQuery - User's original question
 * @param {Array} params.rows - Query result rows
 * @param {Array} params.fields - Column field definitions
 * @param {string} params.chartType - Selected chart type
 * @returns {Promise<Array>} Prioritized insights array
 */
export async function generateInsights({ originalQuery, rows, fields, chartType }) {
  console.log(`[INSIGHTS] Starting insight generation for: "${originalQuery}"`);
  
  // Skip if insufficient data
  if (!rows || rows.length === 0) {
    console.log('[INSIGHTS] No data, skipping insights');
    return [{
      type: 'info',
      priority: 'low',
      text: 'No data available for analysis.',
      evidence: '0 rows returned'
    }];
  }
  
  try {
    // Stage 1: Classify
    const classification = classifyDataShape(rows, fields, originalQuery);
    console.log(`[INSIGHTS] Stage 1 - Classified as: ${classification.storyType}`);
    
    // Stage 2: Analyze
    const statistics = analyzeData(rows, classification);
    console.log(`[INSIGHTS] Stage 2 - Analysis complete`);
    
    // Stage 3: Synthesize
    const rawInsights = await synthesizeInsights(classification, statistics, originalQuery, rows);
    console.log(`[INSIGHTS] Stage 3 - Generated ${rawInsights.length} raw insights`);
    
    // Stage 4: Prioritize
    const prioritized = prioritizeInsights(rawInsights);
    console.log(`[INSIGHTS] Stage 4 - Prioritized, returning top 4`);
    
    return prioritized.slice(0, 4);
    
  } catch (error) {
    console.error('[INSIGHTS] Pipeline failed:', error.message);
    return [{
      type: 'error',
      priority: 'low',
      text: 'Unable to generate insights for this data.',
      evidence: error.message
    }];
  }
}
