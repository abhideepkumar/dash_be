import { callLLM } from '../utils/llmClient.js';
import { serializeForAnswerability } from './schemaExtractor.js';
import { getMetadataEnrichmentPrompt, getGlobalContextPrompt } from '../prompts/metadataPrompts.js';

/**
 * Enrich canonical schemas with LLM-generated descriptions and meanings.
 * 
 * MUTATES the input schemas in-place — no separate output structure.
 * Uses batched processing (10 tables/batch) + a Phase 1 global context pass
 * to give each batch relational awareness without blowing the token ceiling.
 * 
 * @param {Array} schemas - Canonical schemas from getFullSchema (mutated in-place)
 * @param {function} onProgress - Optional progress callback
 */
export async function generateAllMetadata(schemas, onProgress = null) {
  // 10 tables per batch. Each call sets no max_tokens so the model uses its full budget.
  const BATCH_SIZE = 10;
  const batches = [];
  for (let i = 0; i < schemas.length; i += BATCH_SIZE) {
    batches.push(schemas.slice(i, i + BATCH_SIZE));
  }

  console.log(`[METADATA] Sending ${schemas.length} tables to LLM for enrichment (${batches.length} batches of up to ${BATCH_SIZE})...`);

  // ── Phase 1: Global context (skipped for small databases that fit in 1 batch) ──
  // For large databases, produce an ultra-compact overview of the full schema so
  // that each batch prompt has cross-table relational awareness.
  let globalContext = '';
  if (batches.length > 1) {
    try {
      console.log(`[METADATA] Phase 1: generating global database overview for ${schemas.length} tables...`);
      const globalPrompt = getGlobalContextPrompt(schemas);
      const { content: overview } = await callLLM(
        [{ role: 'user', content: globalPrompt }],
        { temperature: 0.2 }
      );
      globalContext = overview.trim();
      console.log(`[METADATA] Phase 1 complete. Overview: "${globalContext.slice(0, 120)}..."`);
    } catch (err) {
      console.warn(`[METADATA] Phase 1 global context failed (non-fatal): ${err.message}`);
    }
  }

  // ── Phase 2: Batched detail enrichment ────────────────────────────────────────
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    if (onProgress) {
      onProgress(
        batch.map(s => s.table).join(', '),
        batchIdx + 1,
        batches.length,
        'enriching'
      );
    }

    const tablesDescription = batch.map(schema => serializeForAnswerability(schema)).join('\n\n---\n');
    const prompt = getMetadataEnrichmentPrompt({ schemas: batch, tablesDescription, globalContext });

    try {
      console.log(`[METADATA] Batch ${batchIdx + 1}/${batches.length}: enriching ${batch.map(s => s.table).join(', ')}`);

      const { content: responseText } = await callLLM(
        [{ role: 'user', content: prompt }],
        { temperature: 0.3 }
      );

      // Clean markdown code fences if present
      let cleanJson = responseText.trim();
      if (cleanJson.startsWith('```json')) cleanJson = cleanJson.slice(7);
      if (cleanJson.startsWith('```')) cleanJson = cleanJson.slice(3);
      if (cleanJson.endsWith('```')) cleanJson = cleanJson.slice(0, -3);
      cleanJson = cleanJson.trim();

      const parsed = JSON.parse(cleanJson);
      console.log(`[METADATA] ✅ Batch ${batchIdx + 1}: received enrichment for ${parsed.length} tables`);

      // Merge LLM output into canonical schemas IN-PLACE
      mergeLLMEnrichment(schemas, parsed);

    } catch (error) {
      console.error(`[METADATA] ❌ Batch ${batchIdx + 1} enrichment failed: ${error.message}`);
      // Non-fatal: apply default descriptions to this batch only
      for (const schema of batch) {
        if (!schema.description) {
          schema.description = `Table ${schema.table} with ${schema.columns.length} columns`;
        }
      }
    }
  }

  console.log(`[METADATA] Merged enrichment into ${schemas.length} canonical schemas`);
}

/**
 * Merge LLM-generated descriptions into canonical schemas.
 * Only sets description, common_queries, and column.meaning.
 * Never overwrites deterministic fields (semantic_role, aggregation, stats, etc.)
 * 
 * @param {Array} schemas - Canonical schemas (mutated in-place)
 * @param {Array} llmOutput - Parsed LLM response
 */
function mergeLLMEnrichment(schemas, llmOutput) {
  // Build lookup map from LLM output
  const llmMap = {};
  for (const item of llmOutput) {
    llmMap[item.table] = item;
  }

  for (const schema of schemas) {
    const enrichment = llmMap[schema.table];
    if (!enrichment) continue;

    // Set table-level fields
    if (enrichment.description) {
      schema.description = enrichment.description;
    }
    if (enrichment.common_queries?.length) {
      schema.common_queries = enrichment.common_queries;
    }

    // Set column-level meanings
    if (enrichment.columns?.length) {
      const meaningMap = {};
      for (const col of enrichment.columns) {
        if (col.meaning) meaningMap[col.name] = col.meaning;
      }
      
      for (const col of schema.columns) {
        if (meaningMap[col.name]) {
          col.meaning = meaningMap[col.name];
        }
      }
    }
  }
}
