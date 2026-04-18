import { callLLM } from '../utils/llmClient.js';
import { searchRelevantTables } from './vectorStore.js';
import { deserializeGraph, expandWithGraph } from './schemaGraph.js';

// Session graph storage (populated from schema extraction)
const sessionGraphs = new Map();

/**
 * Store schema graph for a session (called from schema.routes.js)
 */
export function setSessionGraph(sessionId, serializedGraph) {
  sessionGraphs.set(sessionId, serializedGraph);
  console.log(`[QUERY] Stored schema graph for session: ${sessionId}`);
}

/**
 * Get schema graph for a session
 */
export function getSessionGraph(sessionId) {
  return sessionGraphs.get(sessionId);
}

/**
 * Enhance a user query to make it clearer and more suitable for vector search and SQL generation.
 * Also validates whether the query is answerable given the known DB schema.
 * @param {string} query - Original user query
 * @param {Array} history - Conversation history
 * @param {Array} dbContext - Lightweight schema summary [{table, description, columns: [name, type]}]
 * @returns {Promise<Object>} { answerable, enhancedQuery, reason, suggestions, usage, costDetails }
 */
export async function enhanceQuery(query, history = [], dbContext = null) {
  // Build the history context section for the prompt
  let historySection = '';
  if (history.length > 0) {
    // Cap at last 5 entries to keep prompt size manageable
    const recentHistory = history.slice(-5);
    historySection = `\nConversation History (most recent last):\n${recentHistory
      .map((entry, i) => `  Turn ${i + 1}:\n    User asked: "${entry.query}"\n    SQL generated: ${entry.sql}`)
      .join('\n')}\n`;
  }

  // Build DB schema section when available
  let schemaSection = '';
  if (dbContext && dbContext.length > 0) {
    const schemaLines = dbContext.map(t => {
      const colList = t.columns.map(c => `${c.name} (${c.type})`).join(', ');
      return `  - ${t.table}: ${t.description}. Columns: [${colList}]`;
    }).join('\n');
    schemaSection = `\nDatabase Schema (ALL available tables and columns):\n${schemaLines}\n`;
  }

  const prompt = `You are a database query assistant. Your task is to analyze the user's query and determine if it can be genuinely answered using the available database schema.\n${ historySection }${ schemaSection }
New user query: "${query}"

Rules:
1. If the query is a greeting, small talk, or clearly not a data request — set "answerable" to false. Provide a friendly "reason" and 3 data-related "suggestions".
2. If the query is a data question but the required data (specific columns, statuses, or measurements) does NOT exist in the schema — set "answerable" to false. Explain specifically what is missing in "reason" and suggest 3 queries that CAN be answered using the actual schema.
3. If the query is a valid data question that can be answered with the available schema — set "answerable" to true and provide a clear, standalone "enhancedQuery".
4. Add relevant database keywords to the "enhancedQuery". Keep it as a natural language question, NOT SQL.
5. Return ONLY valid JSON.

JSON format:
{
  "answerable": boolean,
  "enhancedQuery": string | null,
  "reason": string | null,
  "suggestions": string[] | null
}`;

  try {
    const { content, usage, costDetails } = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, max_tokens: 600 }
    );
    
    // Parse the JSON response
    let result;
    try {
      const cleanedContent = content.trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
      result = JSON.parse(cleanedContent);
    } catch (parseError) {
      console.error('[QUERY] Error parsing JSON from LLM:', parseError.message);
      // Fallback
      return { 
        answerable: true, 
        enhancedQuery: query, 
        usage, 
        costDetails 
      };
    }

    console.log(`[QUERY] Analyzed: "${query}" -> Answerable: ${result.answerable}`);
    return { ...result, usage, costDetails };
  } catch (error) {
    console.error('[QUERY] Error enhancing query:', error.message);
    // Fallback to original query if enhancement fails
    return { 
      answerable: true, 
      enhancedQuery: query 
    };
  }
}

/**
 * Generate SQL query based on enhanced query and relevant table schemas
 * @param {string} query - The enhanced query
 * @param {Array} tables - Array of relevant table schemas
 * @returns {Promise<string>} Generated SQL query
 */
export async function generateSQL(query, tables, history = []) {
  // Format table schemas for the prompt with enum values
  const schemaText = tables.map(t => {
    const cols = t.columns.map(c => {
      let colDesc = `    ${c.name} (${c.type}): ${c.meaning || c.name}`;
      // Include enum values if present (CRITICAL for correct SQL generation)
      if (c.is_enum && c.enum_values && c.enum_values.length > 0) {
        colDesc += ` [VALID VALUES: ${c.enum_values.join(', ')}]`;
      }
      return colDesc;
    }).join('\n');
    const fks = t.foreign_keys && t.foreign_keys.length > 0 
      ? `  Foreign Keys: ${t.foreign_keys.join(', ')}`
      : '';
    
    // Mark bridge tables for LLM awareness
    const bridgeNote = t.is_bridge ? ' [BRIDGE TABLE - connects other tables]' : '';
    
    return `TABLE: ${t.table}${bridgeNote}
  Description: ${t.description}
  Columns:
${cols}
${fks}`;
  }).join('\n\n');

  // Inject conversation history context for follow-up queries
  let historyContext = '';
  if (history.length > 0) {
    const recentHistory = history.slice(-5);
    historyContext = `\n## Prior Conversation Context\nThe current request may be a follow-up. Use the prior SQL as reference for table aliases, column selections, and filter patterns.\n${recentHistory
      .map((entry, i) => `  Turn ${i + 1}: User asked "${entry.query}"\n  SQL: ${entry.sql}`)
      .join('\n')}\n`;
  }

  const prompt = `You are a PostgreSQL expert. Generate a SQL query based on the user's request and the available table schemas.${ historyContext }

User Request: "${query}"

Available Tables:
${schemaText}

Rules:
1. Generate ONLY valid PostgreSQL syntax
2. Use appropriate JOINs based on foreign key relationships
3. Include necessary WHERE clauses based on the query
4. Use meaningful aliases for tables
5. For columns with [VALID VALUES: ...], ONLY use those exact values in WHERE clauses
6. Tables marked [BRIDGE TABLE] are junction tables - use them to connect other tables
7. Return ONLY the SQL query, no explanation, no markdown code blocks

SQL Query:`;

  try {
    const { content: rawSql, usage, costDetails } = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.2, max_tokens: 500 }
    );

    let sql = rawSql;
    
    // Clean up any markdown code blocks if present
    if (sql.startsWith('```sql')) {
      sql = sql.slice(6);
    }
    if (sql.startsWith('```')) {
      sql = sql.slice(3);
    }
    if (sql.endsWith('```')) {
      sql = sql.slice(0, -3);
    }
    sql = sql.trim();

    console.log(`[QUERY] Generated SQL for: "${query}"`);
    return { sql, usage, costDetails };
  } catch (error) {
    console.error('[QUERY] Error generating SQL:', error.message);
    throw new Error('Failed to generate SQL query: ' + error.message);
  }
}

/**
 * Main orchestrator: Process a user query through the full pipeline
 * @param {string} query - Original user query
 * @param {string} sessionId - Session ID for namespace isolation in vector store
 * @param {number} topK - Number of relevant tables to retrieve (default: 5)
 * @param {function} onStep - Optional callback for logging steps: (stepName, input, output, durationMs, error?) => void
 * @returns {Promise<Object>} Result containing enhancedQuery, relevantTables, and sql
 */
export async function processUserQuery(query, sessionId, topK = 5, onStep = null, history = []) {
  console.log(`[QUERY] Processing query: "${query}" for session: ${sessionId} (history: ${history.length} turns)`);

  // Step 1: Enhance the query — pass the DB schema so the LLM can validate answerability
  // against actual table/column availability (zero extra API calls: graph is already in memory)
  let enhancedQuery = query;
  let stepStart = Date.now();

  // Extract a lightweight schema summary from the in-memory session graph
  let dbContext = null;
  const serializedGraphForContext = getSessionGraph(sessionId);
  if (serializedGraphForContext?.nodes) {
    try {
      dbContext = Object.values(serializedGraphForContext.nodes).map(t => ({
        table: t.table,
        description: t.description || '',
        columns: (t.columns || []).map(c => ({ name: c.name, type: c.type }))
      }));
      console.log(`[QUERY] DB context built: ${dbContext.length} tables for enhanceQuery`);
    } catch (e) {
      console.warn('[QUERY] Could not extract DB context from graph:', e.message);
    }
  }
  
  try {
    if (history.length === 0) {
      // Only run enhanceQuery for fresh (non-follow-up) queries.
      // Follow-ups skip this step — the original query already passed schema validation.
      const enhancedResult = await enhanceQuery(query, [], dbContext);

      if (!enhancedResult.answerable) {
        if (onStep) onStep('enhance', { query }, { cannotAnswer: true, reason: enhancedResult.reason }, Date.now() - stepStart);
        return {
          originalQuery: query,
          cannotAnswer: true,
          reason: enhancedResult.reason,
          suggestions: enhancedResult.suggestions || []
        };
      }

      enhancedQuery = enhancedResult.enhancedQuery || query;
      const metrics = enhancedResult.usage ? { tokens: enhancedResult.usage, cost: enhancedResult.costDetails?.estimatedCost } : null;
      if (onStep) onStep('enhance', { query, historyTurns: 0 }, { enhancedQuery }, Date.now() - stepStart, null, metrics);
    } else {
      // Follow-up query: trust the user, skip answerability check.
      enhancedQuery = query;
      if (onStep) onStep('enhance', { query, skipped: true, reason: 'follow-up query — bypassing schema validation' }, { enhancedQuery }, 0);
    }
  } catch (err) {
    if (onStep) onStep('enhance', { query }, null, Date.now() - stepStart, err.message);
    // Non-fatal: fall back to raw query
    enhancedQuery = query;
  }

  // Step 2: Search for relevant tables using vector store
  stepStart = Date.now();
  let relevantTables;
  try {
    relevantTables = await searchRelevantTables(enhancedQuery, sessionId, topK);
    
    if (relevantTables.length === 0) {
      const error = 'No relevant tables found. Please ensure the database schema has been extracted.';
      if (onStep) onStep('vector_search', { query: enhancedQuery, sessionId, topK }, null, Date.now() - stepStart, error);
      throw new Error(error);
    }
    
    if (onStep) {
      onStep('vector_search', 
        { query: enhancedQuery, sessionId, topK }, 
        { tablesFound: relevantTables.length, tables: relevantTables.map(t => ({ table: t.table, score: t.score })) },
        Date.now() - stepStart
      );
    }
  } catch (err) {
    if (onStep && !err.message.includes('No relevant tables')) {
      onStep('vector_search', { query: enhancedQuery, sessionId, topK }, null, Date.now() - stepStart, err.message);
    }
    throw err;
  }

  console.log(`[QUERY] Vector search found ${relevantTables.length} tables: ${relevantTables.map(t => t.table).join(', ')}`);

  // Step 2.5: Expand with graph - find bridge tables
  stepStart = Date.now();
  const serializedGraph = getSessionGraph(sessionId);
  const originalTableCount = relevantTables.length;
  
  if (serializedGraph) {
    const graph = deserializeGraph(serializedGraph);
    if (graph) {
      const expandedTables = expandWithGraph(graph, relevantTables, 2, 3);
      if (expandedTables.length > relevantTables.length) {
        console.log(`[QUERY] Graph expansion added ${expandedTables.length - relevantTables.length} bridge/neighbor tables`);
        relevantTables = expandedTables;
      }
    }
  } else {
    console.log(`[QUERY] No schema graph found for session, skipping graph expansion`);
  }
  
  if (onStep) {
    onStep('graph_expand',
      { originalTables: originalTableCount, hasGraph: !!serializedGraph },
      { 
        expandedTables: relevantTables.length,
        addedTables: relevantTables.length - originalTableCount,
        allTables: relevantTables.map(t => ({ table: t.table, is_bridge: t.is_bridge || false }))
      },
      Date.now() - stepStart
    );
  }

  // Step 3: Generate SQL using the enhanced query and schemas
  stepStart = Date.now();
  let sql;
  try {
    const sqlResult = await generateSQL(enhancedQuery, relevantTables, history);
    sql = sqlResult.sql;
    const metrics = sqlResult.usage ? { tokens: sqlResult.usage, cost: sqlResult.costDetails?.estimatedCost } : null;
    
    if (onStep) {
      onStep('sql_generate',
        { query: enhancedQuery, tableCount: relevantTables.length, historyTurns: history.length },
        { sql, sqlLength: sql.length },
        Date.now() - stepStart,
        null,
        metrics
      );
    }
  } catch (err) {
    if (onStep) onStep('sql_generate', { query: enhancedQuery, tableCount: relevantTables.length }, null, Date.now() - stepStart, err.message);
    throw err;
  }

  return {
    originalQuery: query,
    enhancedQuery,
    relevantTables: relevantTables.map(t => ({
      table: t.table,
      description: t.description,
      score: t.score,
      is_bridge: t.is_bridge || false,
    })),
    sql,
  };
}


