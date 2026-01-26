import OpenAI from "openai";
import { searchRelevantTables } from './vectorStore.js';
import { deserializeGraph, expandWithGraph } from './schemaGraph.js';

// Groq client (hardcoded API key as per earlier request)
const groqClient = new OpenAI({
  apiKey: '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',
  baseURL: "https://api.groq.com/openai/v1",
});

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
 * Enhance a user query to make it clearer and more suitable for vector search and SQL generation
 * @param {string} query - Original user query
 * @returns {Promise<string>} Enhanced query
 */
export async function enhanceQuery(query) {
  const prompt = `You are a database query assistant. Your task is to enhance and clarify the following natural language query to make it more precise for searching database tables and generating SQL.

Original query: "${query}"

Rules:
1. Make the query more specific and clear
2. Expand abbreviations if any
3. Add relevant keywords that might help in database search
4. Keep it as a natural language question, NOT SQL
5. Return ONLY the enhanced query, nothing else

Enhanced query:`;

  try {
    const response = await groqClient.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 200,
    });

    const enhanced = response.choices[0].message.content.trim();
    console.log(`[QUERY] Enhanced: "${query}" -> "${enhanced}"`);
    return enhanced;
  } catch (error) {
    console.error('[QUERY] Error enhancing query:', error.message);
    // Fallback to original query if enhancement fails
    return query;
  }
}

/**
 * Generate SQL query based on enhanced query and relevant table schemas
 * @param {string} query - The enhanced query
 * @param {Array} tables - Array of relevant table schemas
 * @returns {Promise<string>} Generated SQL query
 */
export async function generateSQL(query, tables) {
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

  const prompt = `You are a PostgreSQL expert. Generate a SQL query based on the user's request and the available table schemas.

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
    const response = await groqClient.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 500,
    });

    let sql = response.choices[0].message.content.trim();
    
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
    return sql;
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
 * @returns {Promise<Object>} Result containing enhancedQuery, relevantTables, and sql
 */
export async function processUserQuery(query, sessionId, topK = 5) {
  console.log(`[QUERY] Processing query: "${query}" for session: ${sessionId}`);

  // Step 1: Enhance the query (DISABLED for testing - using raw query instead)
  // const enhancedQuery = await enhanceQuery(query);
  const enhancedQuery = query; // Use raw query directly

  // Step 2: Search for relevant tables using vector store
  let relevantTables = await searchRelevantTables(enhancedQuery, sessionId, topK);
  
  if (relevantTables.length === 0) {
    throw new Error('No relevant tables found. Please ensure the database schema has been extracted.');
  }

  console.log(`[QUERY] Vector search found ${relevantTables.length} tables: ${relevantTables.map(t => t.table).join(', ')}`);

  // Step 2.5: Expand with graph - find bridge tables (NEW)
  const serializedGraph = getSessionGraph(sessionId);
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

  // Step 3: Generate SQL using the enhanced query and schemas
  const sql = await generateSQL(enhancedQuery, relevantTables);

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

