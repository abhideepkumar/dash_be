import { callLLM } from '../utils/llmClient.js';
import { searchRelevantTables } from './vectorStore.js';
import { deserializeGraph, expandWithGraph } from './schemaGraph.js';
import { serializeForAnswerability, serializeForSQLGeneration } from './schemaExtractor.js';
import { generateAnswerContract, validateSQLAgainstContract, repairSQL } from './answerContract.js';
import { enhanceQuery, generateSQL, getSessionGraph } from './queryProcessor.js';
import { generateUISpec } from './uiGenerator.js';
import { getBlueprintPrompt } from '../prompts/dashboardPrompts.js';

// ============================================================
// BLUEPRINT STORE — short-lived server-side cache (10 min TTL)
// ============================================================

const blueprintStore = new Map();

function storeBlueprintData(blueprintId, data) {
  blueprintStore.set(blueprintId, {
    ...data,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10-minute TTL
  });
  // Purge stale entries on every write
  for (const [key, val] of blueprintStore.entries()) {
    if (val.expiresAt < Date.now()) blueprintStore.delete(key);
  }
}

function getBlueprintData(blueprintId) {
  const data = blueprintStore.get(blueprintId);
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    blueprintStore.delete(blueprintId);
    return null;
  }
  return data;
}

// ============================================================
// STEP 1: PLAN DASHBOARD
// ============================================================

/**
 * Phase 1 of the dashboard pipeline:
 *  1. enhanceQuery  — answerability check + NL rewrite (once for entire dashboard)
 *  2. vector_search + expandWithGraph — fetch relevant tables ONCE
 *  3. Blueprint LLM — given enhanced query + schema, produces component plans
 *
 * Returns: { blueprintId, dashboardTitle, clarificationNeeded, clarifyingQuestions, components, sharedContext }
 */
export async function planDashboard(originalQuery, sessionId) {
  console.log(`[DASHBOARD] Planning dashboard for: "${originalQuery}" (session: ${sessionId})`);

  // ── Step 1: Enhance query (answerability check + rewrite) ────────────────
  const serializedGraph = getSessionGraph(sessionId);
  let dbContext = null;
  if (serializedGraph?.nodes) {
    dbContext = Object.values(serializedGraph.nodes);
  }

  const enhanceResult = await enhanceQuery(originalQuery, [], dbContext);
  if (!enhanceResult.answerable) {
    return {
      cannotAnswer: true,
      reason: enhanceResult.reason,
      suggestions: enhanceResult.suggestions || [],
    };
  }
  const enhancedQuery = enhanceResult.enhancedQuery || originalQuery;
  console.log(`[DASHBOARD] Enhanced query: "${enhancedQuery}"`);

  // ── Step 2: Vector search + graph expansion (ONCE for all components) ────
  let relevantTables = await searchRelevantTables(enhancedQuery, sessionId, 7);
  if (!relevantTables || relevantTables.length === 0) {
    throw new Error('No relevant tables found. Please ensure the database schema has been extracted.');
  }

  if (serializedGraph) {
    const graph = deserializeGraph(serializedGraph);
    if (graph) {
      // Enrich vector results with canonical metadata from graph nodes
      relevantTables = relevantTables.map(vt => {
        const graphNode = graph.nodes.get(vt.table);
        if (graphNode) {
          return {
            ...vt,
            columns: graphNode.columns || vt.columns,
            table_type: graphNode.table_type || vt.table_type,
            profile: graphNode.profile || null,
            relationships: graphNode.relationships || vt.relationships,
          };
        }
        return vt;
      });
      const expanded = expandWithGraph(graph, relevantTables, 2, 3);
      if (expanded.length > relevantTables.length) {
        console.log(`[DASHBOARD] Graph expansion: +${expanded.length - relevantTables.length} tables`);
        relevantTables = expanded;
      }
    }
  }

  console.log(`[DASHBOARD] Relevant tables (${relevantTables.length}): ${relevantTables.map(t => t.table).join(', ')}`);

  // ── Step 3: Blueprint LLM call (with schema context) ─────────────────────
  const schemaContext = relevantTables
    .map(t => serializeForAnswerability(t))
    .join('\n\n');

  const tableNames = relevantTables.map(t => t.table);

  const blueprintPrompt = getBlueprintPrompt({ enhancedQuery, schemaContext, tableNames });

  const { content } = await callLLM(
    [{ role: 'user', content: blueprintPrompt }],
    { temperature: 0.2, max_tokens: 2000 }
  );

  let blueprint;
  try {
    const cleaned = content.trim()
      .replace(/^```json\n?/, '')
      .replace(/\n?```$/, '');
    blueprint = JSON.parse(cleaned);
  } catch (e) {
    console.error('[DASHBOARD] Blueprint parse error:', e.message);
    throw new Error('Failed to parse dashboard blueprint from LLM response.');
  }

  console.log(`[DASHBOARD] Blueprint: "${blueprint.dashboardTitle}" — ${blueprint.components?.length || 0} components, clarify: ${blueprint.clarificationNeeded}`);

  // ── Store blueprint + tables for execute step ─────────────────────────────
  const blueprintId = `bp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  storeBlueprintData(blueprintId, {
    blueprint,
    relevantTables,
    enhancedQuery,
  });

  return {
    blueprintId,
    dashboardTitle: blueprint.dashboardTitle,
    clarificationNeeded: blueprint.clarificationNeeded || false,
    clarifyingQuestions: blueprint.clarifyingQuestions || [],
    components: blueprint.components || [],
    sharedContext: blueprint.sharedContext || {},
  };
}

// ============================================================
// STEP 2: EXECUTE A SINGLE DASHBOARD COMPONENT
// ============================================================

/**
 * Runs one component through the pipeline:
 *   generateAnswerContract → generateSQL → sql_validate + repairSQL → pool.query → generateUISpec
 *
 * Bypasses enhanceQuery and vector_search — tables are pre-fetched during planDashboard.
 *
 * @param {object} component   — blueprint component plan
 * @param {Array}  allTables   — full relevantTables from planDashboard
 * @param {object} pool        — pg pool for the session
 * @returns {object}           — { id, title, uiSpec, sql, error }
 */
async function executeDashboardComponent(component, allTables, pool) {
  const { id, title, focusQuery, tableHints = [], suggestedType } = component;
  console.log(`[DASHBOARD] Executing component "${id}" (${suggestedType}): "${focusQuery}"`);

  try {
    // Filter tables by tableHints for precision; fall back to all tables if no hints
    let componentTables = allTables;
    if (tableHints.length > 0) {
      const hinted = allTables.filter(t => tableHints.includes(t.table));
      // Always keep at least something — fall back if hints don't match
      componentTables = hinted.length > 0 ? hinted : allTables;
    }

    // ── generateAnswerContract ──────────────────────────────────────────────
    let contract = null;
    try {
      const contractResult = await generateAnswerContract(focusQuery, componentTables);
      contract = contractResult.contract;
      console.log(`[DASHBOARD] [${id}] Contract: intent=${contract?.intent}`);
    } catch (e) {
      console.warn(`[DASHBOARD] [${id}] Contract failed: ${e.message}`);
    }

    // ── generateSQL ─────────────────────────────────────────────────────────
    // Hint the LLM toward the suggestedType by appending it to the context
    const sqlResult = await generateSQL(focusQuery, componentTables, [], contract);
    let sql = sqlResult.sql;
    console.log(`[DASHBOARD] [${id}] SQL generated (${sql.length} chars)`);

    // ── Validate + repair SQL ───────────────────────────────────────────────
    if (contract && contract.intent !== 'unknown') {
      const validation = validateSQLAgainstContract(sql, contract);
      if (!validation.valid) {
        console.log(`[DASHBOARD] [${id}] Validation failed (${validation.errors.length} errors), repairing...`);
        try {
          const repairResult = await repairSQL(sql, contract, validation.errors, componentTables);
          if (repairResult.wasRepaired) {
            sql = repairResult.repairedSQL;
            console.log(`[DASHBOARD] [${id}] SQL repaired`);
          }
        } catch (repairErr) {
          console.warn(`[DASHBOARD] [${id}] Repair failed: ${repairErr.message}`);
        }
      }
    }

    // ── Execute SQL ─────────────────────────────────────────────────────────
    const execResult = await pool.query(sql);
    const rows = execResult.rows;
    const fields = execResult.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })) || [];
    console.log(`[DASHBOARD] [${id}] SQL returned ${rows.length} rows`);

    if (rows.length === 0) {
      return {
        id, title, suggestedType,
        uiSpec: null,
        sql,
        error: 'No data returned for this component',
      };
    }

    // ── generateUISpec ───────────────────────────────────────────────────────
    const uiSpec = await generateUISpec({
      originalQuery: focusQuery,
      sql,
      rows,
      fields,
    });

    return { id, title, suggestedType, uiSpec, sql, error: null };

  } catch (err) {
    console.error(`[DASHBOARD] [${id}] Component failed: ${err.message}`);
    return { id, title, suggestedType, uiSpec: null, sql: null, error: err.message };
  }
}

// ============================================================
// STEP 3: EXECUTE ALL COMPONENTS IN PARALLEL
// ============================================================

/**
 * Retrieves blueprint from store, applies any clarification answers to the focusQuery,
 * then executes all components in parallel via Promise.allSettled.
 *
 * @param {string} blueprintId  — ID from planDashboard
 * @param {object} pool         — pg pool for the session
 * @param {object} answers      — optional { questionIndex: answerText } from user
 * @returns {{ dashboardTitle, components[] }}
 */
export async function executeDashboard(blueprintId, pool, answers = {}) {
  const stored = getBlueprintData(blueprintId);
  if (!stored) {
    throw new Error('Blueprint expired or not found. Please re-submit your query.');
  }

  const { blueprint, relevantTables } = stored;
  let components = blueprint.components || [];

  // If answers were provided, append them to each focusQuery for context
  if (Object.keys(answers).length > 0) {
    const answerContext = Object.entries(answers)
      .map(([q, a]) => `${q}: ${a}`)
      .join('; ');
    components = components.map(comp => ({
      ...comp,
      focusQuery: `${comp.focusQuery} (Context: ${answerContext})`,
    }));
    console.log(`[DASHBOARD] Clarification answers applied: ${answerContext}`);
  }

  console.log(`[DASHBOARD] Executing ${components.length} components in parallel...`);
  const startTime = Date.now();

  // Run all components in parallel — failures are isolated per component
  const settled = await Promise.allSettled(
    components.map(comp => executeDashboardComponent(comp, relevantTables, pool))
  );

  const results = settled.map((result, i) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      console.error(`[DASHBOARD] Component ${components[i].id} failed unexpectedly: ${result.reason}`);
      return {
        id: components[i].id,
        title: components[i].title,
        suggestedType: components[i].suggestedType,
        uiSpec: null,
        sql: null,
        error: result.reason?.message || 'Unknown error',
      };
    }
  });

  console.log(`[DASHBOARD] All components done in ${Date.now() - startTime}ms. Success: ${results.filter(r => r.uiSpec).length}/${results.length}`);

  return {
    dashboardTitle: blueprint.dashboardTitle,
    sharedContext: blueprint.sharedContext,
    components: results,
  };
}
