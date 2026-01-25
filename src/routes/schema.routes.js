import express from 'express';
import { createPool, getPool, testConnection, closePool } from '../config/db.js';
import { getFullSchema, getAllTables } from '../services/schemaExtractor.js';
import { generateAllMetadata } from '../services/metadataGenerator.js';
import { 
  initIndex, 
  upsertAllMetadata, 
  searchRelevantTables, 
  getStoredTables,
  clearNamespace 
} from '../services/vectorStore.js';

const router = express.Router();

// Store extraction progress per session
const extractionProgress = new Map();

/**
 * POST /api/schema/connect
 * Test PostgreSQL connection and create session pool
 */
router.post('/connect', async (req, res) => {
  try {
    const { host, port, database, user, password } = req.body;

    if (!host || !database || !user || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: host, database, user, password' 
      });
    }

    const config = { host, port: port || 5432, database, user, password };
    const result = await testConnection(config);

    if (result.success) {
      // Generate session ID and create pool
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      createPool(sessionId, config);

      return res.json({ 
        success: true, 
        message: 'Connection successful',
        sessionId,
        database,
      });
    }

    return res.status(400).json(result);
  } catch (error) {
    console.error('Connection error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

/**
 * POST /api/schema/extract
 * Extract schema, enrich with LLM, and store in Pinecone
 */
router.post('/extract', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing sessionId. Connect to database first.' 
      });
    }

    const pool = getPool(sessionId);
    if (!pool) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid sessionId. Connection not found.' 
      });
    }

    // Initialize progress tracking
    extractionProgress.set(sessionId, {
      stage: 'extracting',
      currentTable: '',
      current: 0,
      total: 0,
      completed: false,
      error: null,
    });

    console.log(`[EXTRACT] Starting extraction for session: ${sessionId}`);

    // Start async extraction
    (async () => {
      try {
        // Stage 1: Extract raw schema
        console.log('[EXTRACT] Stage 1: Extracting raw schema from PostgreSQL...');
        extractionProgress.get(sessionId).stage = 'extracting';
        
        const rawSchemas = await getFullSchema(sessionId, (table, idx, total) => {
          const progress = extractionProgress.get(sessionId);
          progress.currentTable = table;
          progress.current = idx;
          progress.total = total;
        });
        
        console.log(`[EXTRACT] Stage 1 complete: Found ${rawSchemas.length} tables`);
        rawSchemas.forEach(s => console.log(`  - ${s.table} (${s.columns.length} columns)`));

        // Stage 2: Enrich with LLM
        console.log('[EXTRACT] Stage 2: Enriching with Gemini LLM...');
        extractionProgress.get(sessionId).stage = 'enriching';
        extractionProgress.get(sessionId).current = 0;
        extractionProgress.get(sessionId).total = rawSchemas.length;
        
        const enrichedSchemas = await generateAllMetadata(rawSchemas, (table, idx, total, status) => {
          console.log(`[EXTRACT] Enriching table ${idx}/${total}: ${table}`);
          const progress = extractionProgress.get(sessionId);
          progress.currentTable = table;
          progress.current = idx;
          progress.total = total;
        });
        
        console.log(`[EXTRACT] Stage 2 complete: Enriched ${enrichedSchemas.length} tables`);

        // Stage 3: Store in Pinecone
        console.log('[EXTRACT] Stage 3: Storing in Pinecone...');
        extractionProgress.get(sessionId).stage = 'storing';
        extractionProgress.get(sessionId).current = 0;
        
        console.log('[EXTRACT] Initializing Pinecone index...');
        await initIndex();
        
        console.log('[EXTRACT] Clearing namespace...');
        await clearNamespace(sessionId);
        
        console.log('[EXTRACT] Upserting metadata...');
        await upsertAllMetadata(enrichedSchemas, sessionId, (table, idx, total, status) => {
          console.log(`[EXTRACT] Storing table ${idx}/${total}: ${table}`);
          const progress = extractionProgress.get(sessionId);
          progress.currentTable = table;
          progress.current = idx;
          progress.total = total;
        });

        // Mark complete
        console.log('[EXTRACT] ✅ Extraction complete!');
        const progress = extractionProgress.get(sessionId);
        progress.stage = 'completed';
        progress.completed = true;
        progress.schemas = enrichedSchemas;

      } catch (error) {
        console.error('[EXTRACT] ❌ Extraction failed:', error);
        console.error('[EXTRACT] Error stack:', error.stack);
        const progress = extractionProgress.get(sessionId);
        if (progress) {
          progress.stage = 'error';
          progress.error = error.message;
        }
      }
    })();

    return res.json({ 
      success: true, 
      message: 'Extraction started. Use /api/schema/progress to track status.',
      sessionId,
    });
  } catch (error) {
    console.error('Extract error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

/**
 * GET /api/schema/progress/:sessionId
 * Get extraction progress
 */
router.get('/progress/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const progress = extractionProgress.get(sessionId);

  if (!progress) {
    return res.status(404).json({ 
      success: false, 
      message: 'No extraction in progress for this session' 
    });
  }

  return res.json({ 
    success: true, 
    progress: {
      stage: progress.stage,
      currentTable: progress.currentTable,
      current: progress.current,
      total: progress.total,
      completed: progress.completed,
      error: progress.error,
    }
  });
});

/**
 * GET /api/schema/tables/:sessionId
 * Get all stored table metadata
 */
router.get('/tables/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const progress = extractionProgress.get(sessionId);

    if (progress && progress.completed && progress.schemas) {
      return res.json({ 
        success: true, 
        tables: progress.schemas 
      });
    }

    // Fallback to Pinecone query
    const tables = await getStoredTables(sessionId);
    return res.json({ 
      success: true, 
      tables 
    });
  } catch (error) {
    console.error('Get tables error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

/**
 * POST /api/schema/search
 * Find relevant tables for a natural language query
 */
router.post('/search', async (req, res) => {
  try {
    const { sessionId, query, topK = 5 } = req.body;

    if (!sessionId || !query) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: sessionId, query' 
      });
    }

    const results = await searchRelevantTables(query, sessionId, topK);

    return res.json({ 
      success: true, 
      query,
      tables: results,
    });
  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

/**
 * POST /api/schema/disconnect
 * Close database connection
 */
router.post('/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing sessionId' 
      });
    }

    await closePool(sessionId);
    extractionProgress.delete(sessionId);

    return res.json({ 
      success: true, 
      message: 'Disconnected successfully' 
    });
  } catch (error) {
    console.error('Disconnect error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

export default router;
