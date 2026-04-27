import { callLLM } from '../utils/llmClient.js';
import { searchRelevantTables } from './vectorStore.js';
import { deserializeGraph, expandWithGraph } from './schemaGraph.js';
import { serializeForAnswerability, serializeForSQLGeneration, serializeForContract } from './schemaExtractor.js';
import { generateAnswerContract, validateSQLAgainstContract, repairSQL } from './answerContract.js';
import { getEnhanceQueryPrompt, getGenerateSQLPrompt } from '../prompts/queryPrompts.js';

// Session graph storage (populated from schema extraction)
const sessionGraphs = new Map();

export function setSessionGraph(sessionId, serializedGraph) {
  sessionGraphs.set(sessionId, serializedGraph);
  console.log(`[QUERY] Stored schema graph for session: ${sessionId}`);
}

export function getSessionGraph(sessionId) {
  return sessionGraphs.get(sessionId);
}

// ============================================
// QUERY PIPELINE
// ============================================

/**
 * Enhance a user query: validate answerability + produce enhanced query.
 * Uses the canonical serializeForAnswerability() — no ad-hoc formatting.
 */
export async function enhanceQuery(query, history = [], dbContext = null) {
  // History section
  let historySection = '';
  if (history.length > 0) {
    const recent = history.slice(-5);
    historySection = `\nConversation History:\n${recent
      .map((e, i) => `  Turn ${i + 1}: User: "${e.query}" → SQL: ${e.sql}`)
      .join('\n')}\n`;
  }

  // Schema section — uses purpose-built serializer from schemaExtractor
  let schemaSection = '';
  if (dbContext && dbContext.length > 0) {
    const schemaLines = dbContext.map(t => serializeForAnswerability(t)).join('\n\n');
    schemaSection = `\nDatabase Schema:\n${schemaLines}\n`;
  }

  const prompt = getEnhanceQueryPrompt({ query, historySection, schemaSection });

  try {
    const { content, usage, costDetails } = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, max_tokens: 600 }
    );
    
    let result;
    try {
      const cleaned = content.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
      result = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('[QUERY] JSON parse error:', parseError.message);
      return { answerable: true, enhancedQuery: query, usage, costDetails };
    }

    console.log(`[QUERY] Analyzed: "${query}" → Answerable: ${result.answerable}`);
    return { ...result, usage, costDetails };
  } catch (error) {
    console.error('[QUERY] Enhancement error:', error.message);
    return { answerable: true, enhancedQuery: query };
  }
}

/**
 * Generate SQL from enhanced query + relevant tables.
 * Uses serializeForSQLGeneration() — each table rendered with
 * full semantic annotations directly actionable by the LLM.
 */
export async function generateSQL(query, tables, history = [], contract = null) {
  // Schema text — uses the purpose-built SQL serializer
  const schemaText = tables.map(t => serializeForSQLGeneration(t)).join('\n\n');

  // History context
  let historyContext = '';
  if (history.length > 0) {
    historyContext = `\n## Prior Context\n${history.slice(-5)
      .map((e, i) => `  Turn ${i + 1}: "${e.query}" → ${e.sql}`)
      .join('\n')}\n`;
  }

  // Contract section — tells the LLM exactly what must be in the output
  let contractSection = '';
  if (contract && contract.intent !== 'unknown') {
    contractSection = `\n## Analytical Contract (MUST SATISFY)
- Intent: ${contract.intent}
- Required output columns: [${(contract.required_output_columns || []).join(', ')}]
- Metrics: ${(contract.metrics || []).map(m => `${m.aggregation}(${m.source_column}) AS ${m.name}`).join(', ') || 'none'}
- Dimensions: ${(contract.dimensions || []).map(d => d.source_column).join(', ') || 'none'}
- Sort: ${contract.sort ? `${contract.sort.by} ${contract.sort.direction}` : 'none'}
- Limit: ${contract.limit || 'none'}
- Time filter: ${contract.time_filter?.needed ? contract.time_filter.description : 'none'}
Your SQL SELECT MUST include ALL required output columns.\n`;
  }

  const prompt = getGenerateSQLPrompt({ query, schemaText, historyContext, contractSection });

  try {
    const { content: rawSql, usage, costDetails } = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.2, max_tokens: 500 }
    );

    let sql = rawSql;
    if (sql.startsWith('```sql')) sql = sql.slice(6);
    if (sql.startsWith('```')) sql = sql.slice(3);
    if (sql.endsWith('```')) sql = sql.slice(0, -3);
    sql = sql.trim();

    console.log(`[QUERY] Generated SQL for: "${query}"`);
    return { sql, usage, costDetails };
  } catch (error) {
    console.error('[QUERY] SQL generation error:', error.message);
    throw new Error('Failed to generate SQL: ' + error.message);
  }
}

/**
 * Main pipeline orchestrator.
 * 
 * Flow:
 * 1. enhanceQuery — answerability + query enhancement (with full semantic context)
 * 2. searchRelevantTables — vector search for relevant tables
 * 3. expandWithGraph — bridge table discovery (tighter: 2+ seed connections)
 *    + merge semantic metadata from graph nodes into vector results
 * 4. generateAnswerContract — structured intent defining what SQL must produce
 * 5. generateSQL — SQL generation guided by contract + semantic annotations
 * 6. validateSQLAgainstContract — deterministic completeness check
 * 7. repairSQL — auto-fix if validation fails (max 1 retry)
 */
export async function processUserQuery(query, sessionId, topK = 5, onStep = null, history = []) {
  console.log(`[QUERY] Processing: "${query}" (session: ${sessionId}, history: ${history.length})`);

  // === Step 1: Enhance & validate answerability ===
  let enhancedQuery = query;
  let stepStart = Date.now();
  
  const serializedGraph = getSessionGraph(sessionId);
  
  // Build semantic DB context from graph nodes (canonical schemas)
  let dbContext = null;
  if (serializedGraph?.nodes) {
    dbContext = Object.values(serializedGraph.nodes);
    console.log(`[QUERY] Semantic context: ${dbContext.length} tables`);
  }
  
  try {
    if (history.length === 0) {
      const result = await enhanceQuery(query, [], dbContext);
      if (!result.answerable) {
        if (onStep) onStep('enhance', { query }, { cannotAnswer: true, reason: result.reason }, Date.now() - stepStart);
        return {
          originalQuery: query,
          cannotAnswer: true,
          reason: result.reason,
          suggestions: result.suggestions || []
        };
      }
      enhancedQuery = result.enhancedQuery || query;
      const metrics = result.usage ? { tokens: result.usage, cost: result.costDetails?.estimatedCost } : null;
      if (onStep) onStep('enhance', { query }, { enhancedQuery }, Date.now() - stepStart, null, metrics);
    } else {
      enhancedQuery = query;
      if (onStep) onStep('enhance', { query, skipped: true, reason: 'follow-up' }, { enhancedQuery }, 0);
    }
  } catch (err) {
    if (onStep) onStep('enhance', { query }, null, Date.now() - stepStart, err.message);
    enhancedQuery = query;
  }

  // === Step 2: Vector search ===
  stepStart = Date.now();
  let relevantTables;
  try {
    relevantTables = await searchRelevantTables(enhancedQuery, sessionId, topK);
    if (relevantTables.length === 0) {
      const error = 'No relevant tables found. Please ensure the database schema has been extracted.';
      if (onStep) onStep('vector_search', { query: enhancedQuery }, null, Date.now() - stepStart, error);
      throw new Error(error);
    }
    if (onStep) {
      onStep('vector_search', 
        { query: enhancedQuery, topK }, 
        { tablesFound: relevantTables.length, tables: relevantTables.map(t => ({ table: t.table, score: t.score })) },
        Date.now() - stepStart
      );
    }
  } catch (err) {
    if (!err.message.includes('No relevant tables') && onStep) {
      onStep('vector_search', { query: enhancedQuery }, null, Date.now() - stepStart, err.message);
    }
    throw err;
  }

  console.log(`[QUERY] Vector search: ${relevantTables.map(t => `${t.table}(${t.score.toFixed(2)})`).join(', ')}`);

  // === Step 2.5: Graph expansion + semantic enrichment ===
  stepStart = Date.now();
  const originalTableCount = relevantTables.length;
  
  if (serializedGraph) {
    const graph = deserializeGraph(serializedGraph);
    if (graph) {
      // Enrich vector results with canonical metadata from graph nodes
      // Graph nodes have full profiling data; vector results may have partial
      relevantTables = relevantTables.map(vt => {
        const graphNode = graph.nodes.get(vt.table);
        if (graphNode) {
          return {
            ...vt,
            // Use graph node's canonical data (has profiling, freshness, etc.)
            columns: graphNode.columns || vt.columns,
            table_type: graphNode.table_type || vt.table_type,
            profile: graphNode.profile || null,
            relationships: graphNode.relationships || vt.relationships,
          };
        }
        return vt;
      });

      const expandedTables = expandWithGraph(graph, relevantTables, 2, 3);
      if (expandedTables.length > relevantTables.length) {
        console.log(`[QUERY] Graph expansion: +${expandedTables.length - relevantTables.length} tables`);
        relevantTables = expandedTables;
      }
    }
  }
  
  if (onStep) {
    onStep('graph_expand',
      { originalTables: originalTableCount },
      { expandedTables: relevantTables.length, addedTables: relevantTables.length - originalTableCount },
      Date.now() - stepStart
    );
  }

  // === Step 3: Generate Answer Contract ===
  stepStart = Date.now();
  let contract = null;
  try {
    const contractResult = await generateAnswerContract(enhancedQuery, relevantTables);
    contract = contractResult.contract;
    const metrics = contractResult.usage ? { tokens: contractResult.usage, cost: contractResult.costDetails?.estimatedCost } : null;
    if (onStep) {
      onStep('answer_contract',
        { query: enhancedQuery },
        { intent: contract.intent, requiredCols: contract.required_output_columns || [] },
        Date.now() - stepStart, null, metrics
      );
    }
    console.log(`[QUERY] Contract: intent=${contract.intent}, required=[${(contract.required_output_columns || []).join(', ')}]`);
  } catch (err) {
    console.warn('[QUERY] Contract failed:', err.message);
    if (onStep) onStep('answer_contract', {}, null, Date.now() - stepStart, err.message);
  }

  // === Step 4: Generate SQL ===
  stepStart = Date.now();
  let sql;
  try {
    const sqlResult = await generateSQL(enhancedQuery, relevantTables, history, contract);
    sql = sqlResult.sql;
    const metrics = sqlResult.usage ? { tokens: sqlResult.usage, cost: sqlResult.costDetails?.estimatedCost } : null;
    if (onStep) {
      onStep('sql_generate',
        { query: enhancedQuery, hasContract: !!contract },
        { sql, sqlLength: sql.length },
        Date.now() - stepStart, null, metrics
      );
    }
  } catch (err) {
    if (onStep) onStep('sql_generate', {}, null, Date.now() - stepStart, err.message);
    throw err;
  }

  // === Step 5: Validate SQL against contract ===
  stepStart = Date.now();
  if (contract && contract.intent !== 'unknown') {
    const validation = validateSQLAgainstContract(sql, contract);
    if (onStep) {
      onStep('sql_validate', {}, { valid: validation.valid, errors: validation.errors }, Date.now() - stepStart);
    }

    // Step 5.5: Repair if invalid
    if (!validation.valid) {
      console.log(`[QUERY] Validation failed (${validation.errors.length} errors), attempting repair`);
      const repairStart = Date.now();
      try {
        const repairResult = await repairSQL(sql, contract, validation.errors, relevantTables);
        if (repairResult.wasRepaired) {
          sql = repairResult.repairedSQL;
          const revalidation = validateSQLAgainstContract(sql, contract);
          const metrics = repairResult.usage ? { tokens: repairResult.usage, cost: repairResult.costDetails?.estimatedCost } : null;
          if (onStep) onStep('sql_repair', {}, { repaired: true, remainingErrors: revalidation.errors.length }, Date.now() - repairStart, null, metrics);
        } else {
          if (onStep) onStep('sql_repair', {}, { repaired: false }, Date.now() - repairStart);
        }
      } catch (repairErr) {
        if (onStep) onStep('sql_repair', {}, null, Date.now() - repairStart, repairErr.message);
      }
    }
  }

  return {
    originalQuery: query,
    enhancedQuery,
    relevantTables: relevantTables.map(t => ({
      table: t.table,
      table_type: t.table_type || 'standalone',
      description: t.description,
      score: t.score,
      is_bridge: t.is_bridge || false,
    })),
    sql,
    contract,
  };
}
