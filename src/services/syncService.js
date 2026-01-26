/**
 * Sync Service - Fire-and-forget schema extraction
 * 
 * Runs schema extraction in the background without blocking API responses.
 */

import DbConfig from '../models/DbConfig.js';
import { createPool, closePool } from '../config/db.js';
import { getFullSchema } from './schemaExtractor.js';
import { generateAllMetadata } from './metadataGenerator.js';
import { buildSchemaGraph, serializeGraph } from './schemaGraph.js';
import { initIndex, upsertAllMetadata, clearNamespace } from './vectorStore.js';
import { decryptDbConfig } from '../utils/encryption.js';
import { setSessionGraph } from './queryProcessor.js';

/**
 * Trigger async schema sync - FIRE AND FORGET
 * 
 * This function kicks off the sync and returns immediately.
 * The sync runs in the background and updates the DbConfig status.
 * 
 * @param {string} userId - User ID
 * @param {string} configId - DbConfig ID
 */
export function triggerAsyncSync(userId, configId) {
  console.log(`[SYNC] Triggering async sync for user: ${userId}`);
  
  // Don't await - let it run in background
  runSyncProcess(userId, configId).catch(error => {
    console.error(`[SYNC] Background sync failed for user ${userId}:`, error.message);
  });
}

/**
 * Run the actual sync process
 */
async function runSyncProcess(userId, configId) {
  const sessionId = `user_${userId}`;
  
  try {
    // Update status to syncing
    await DbConfig.findByIdAndUpdate(configId, { 
      syncStatus: 'syncing',
      syncError: null 
    });
    
    console.log(`[SYNC] Starting sync for session: ${sessionId}`);
    
    // Get and decrypt config
    const config = await DbConfig.findById(configId);
    if (!config) {
      throw new Error('DbConfig not found');
    }
    
    const dbCredentials = decryptDbConfig({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password
    });
    
    console.log(`[SYNC] Connecting to database: ${dbCredentials.database}`);
    
    // Create connection pool
    createPool(sessionId, dbCredentials);
    
    // Stage 1: Extract raw schema
    console.log(`[SYNC] Stage 1: Extracting schema...`);
    const rawSchemas = await getFullSchema(sessionId);
    console.log(`[SYNC] Found ${rawSchemas.length} tables`);
    
    // Stage 2: Enrich with LLM
    console.log(`[SYNC] Stage 2: Enriching with AI...`);
    const enrichedSchemas = await generateAllMetadata(rawSchemas);
    
    // Stage 3: Build schema graph
    console.log(`[SYNC] Stage 3: Building schema graph...`);
    const schemaGraph = buildSchemaGraph(rawSchemas);
    const serializedGraph = serializeGraph(schemaGraph);
    
    // Store graph for query processor
    setSessionGraph(sessionId, serializedGraph);
    
    // Stage 4: Store in Pinecone
    console.log(`[SYNC] Stage 4: Storing in Pinecone...`);
    await initIndex();
    await clearNamespace(sessionId);
    await upsertAllMetadata(enrichedSchemas, sessionId);
    
    // Update config with success
    await DbConfig.findByIdAndUpdate(configId, {
      syncStatus: 'completed',
      lastSyncedAt: new Date(),
      tableCount: rawSchemas.length,
      schemaGraph: serializedGraph,
      syncError: null
    });
    
    console.log(`[SYNC] ✅ Sync completed for session: ${sessionId} (${rawSchemas.length} tables)`);
    
  } catch (error) {
    console.error(`[SYNC] ❌ Sync failed for session ${sessionId}:`, error.message);
    
    // Update config with error
    await DbConfig.findByIdAndUpdate(configId, {
      syncStatus: 'error',
      syncError: error.message
    });
    
    // Close pool on error
    try {
      await closePool(sessionId);
    } catch (e) {
      // Ignore
    }
  }
}

/**
 * Get sync status for a user
 */
export async function getSyncStatus(userId) {
  const config = await DbConfig.findOne({ userId });
  
  if (!config) {
    return { status: 'none', hasConfig: false };
  }
  
  return {
    status: config.syncStatus,
    hasConfig: true,
    lastSyncedAt: config.lastSyncedAt,
    tableCount: config.tableCount,
    error: config.syncError
  };
}
