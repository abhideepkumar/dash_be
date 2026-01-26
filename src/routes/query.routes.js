import express from 'express';
import { getPool, createPool } from '../config/db.js';
import DbConfig from '../models/DbConfig.js';
import User from '../models/User.js';
import { decryptDbConfig } from '../utils/encryption.js';
import { processUserQuery, setSessionGraph } from '../services/queryProcessor.js';
import { generateUISpec } from '../services/uiGenerator.js';
import { createLog, logStep, completeLog } from '../services/queryLogger.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Store active request logs for multi-step tracking
const activeRequestLogs = new Map();

/**
 * Helper to ensure connection exists for a session
 * Restores connection from DbConfig if missing
 */
async function ensureConnection(sessionId, userId) {
  if (getPool(sessionId)) return true;

  // Only try to restore for user sessions
  if (sessionId && sessionId.startsWith('user_') && userId) {
    console.log(`[QUERY] Session ${sessionId} not found. Attempting to restore connection...`);
    try {
      const dbConfig = await DbConfig.findOne({ userId });
      
      if (dbConfig && (dbConfig.syncStatus === 'completed' || dbConfig.syncStatus === 'syncing' || dbConfig.tableCount > 0)) {
        // Decrypt credentials
        // Note: DbConfig stores encrypted values
        const credentials = decryptDbConfig({
            host: dbConfig.host,
            port: dbConfig.port,
            database: dbConfig.database,
            user: dbConfig.user,
            password: dbConfig.password
        });
        
        createPool(sessionId, credentials);

        // Restore schema graph if available
        if (dbConfig.schemaGraph) {
            setSessionGraph(sessionId, dbConfig.schemaGraph);
        }
        console.log(`[QUERY] Connection restored for ${sessionId}`);
        return true;
      } else {
        console.warn(`[QUERY] Cannot restore connection: DbConfig not found or invalid status (${dbConfig?.syncStatus})`);
      }
    } catch (error) {
      console.error(`[QUERY] Failed to restore connection: ${error.message}`);
    }
  }
  return false;
}

/**
 * POST /api/query/generate
 * Generate SQL from natural language query
 */
router.post('/generate', authenticateToken, async (req, res) => {
  try {
    const { sessionId, query, topK = 5 } = req.body;
    const userId = req.user?.userId || null;

    if (userId) {
      const user = await User.findById(userId);
      if (user && !user.isReady) {
        return res.status(409).json({
          success: false,
          message: 'Database synchronization in progress. Please wait...',
          isProcessing: true
        });
      }
    }

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing sessionId. Connect to database first.',
      });
    }

    if (!query || query.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Missing query. Please provide a natural language query.',
      });
    }

    
    // Ensure connection exists (auto-reconnect if needed)
    await ensureConnection(sessionId, userId);

    const pool = getPool(sessionId);
    if (!pool) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sessionId. Connection not found. Please sync database again.',
      });
    }

    console.log(`[QUERY ROUTE] Processing query: "${query}"`);

    // Create log entry
    const requestId = await createLog(userId, query, sessionId);

    // Step logging callback
    const onStep = async (stepName, input, output, durationMs, error = null) => {
      await logStep(requestId, stepName, input, output, error, durationMs);
    };

    try {
      const result = await processUserQuery(query, sessionId, topK, onStep);
      
      // Store requestId for subsequent steps
      activeRequestLogs.set(sessionId + '_latest', requestId);

      return res.json({
        success: true,
        requestId,
        ...result,
      });
    } catch (error) {
      await completeLog(requestId, 'error', { errorMessage: error.message });
      throw error;
    }
  } catch (error) {
    console.error('[QUERY ROUTE] Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * POST /api/query/execute
 * Execute the generated SQL query on the connected database
 */
router.post('/execute', authenticateToken, async (req, res) => {
  try {
    const { sessionId, sql, requestId } = req.body;
    const userId = req.user?.userId || null;

    if (userId) {
      const user = await User.findById(userId);
      if (user && !user.isReady) {
        return res.status(409).json({
          success: false,
          message: 'Database synchronization in progress. Please wait...',
          isProcessing: true
        });
      }
    }

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing sessionId. Connect to database first.',
      });
    }

    if (!sql || sql.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Missing SQL query.',
      });
    }

    
    // Ensure connection exists
    await ensureConnection(sessionId, userId);

    const pool = getPool(sessionId);
    if (!pool) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sessionId. Connection not found. Please sync database again.',
      });
    }

    console.log(`[QUERY ROUTE] Executing SQL: ${sql.substring(0, 100)}...`);

    // Get or create request ID for logging
    const logRequestId = requestId || activeRequestLogs.get(sessionId + '_latest');

    const stepStart = Date.now();
    try {
      const result = await pool.query(sql);
      const durationMs = Date.now() - stepStart;

      // Log execution step
      if (logRequestId) {
        await logStep(logRequestId, 'sql_execute', 
          { sql: sql.substring(0, 500) },
          { rowCount: result.rowCount, fieldCount: result.fields?.length },
          null,
          durationMs
        );
        
        // Update log status to completed (will be updated again if visualize is called)
        await completeLog(logRequestId, 'completed', {
          sql,
          rowCount: result.rowCount
        });
      }

      return res.json({
        success: true,
        requestId: logRequestId,
        rowCount: result.rowCount,
        rows: result.rows,
        fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      });
    } catch (error) {
      if (logRequestId) {
        await logStep(logRequestId, 'sql_execute',
          { sql: sql.substring(0, 500) },
          null,
          error.message,
          Date.now() - stepStart
        );
        await completeLog(logRequestId, 'error', { sql, errorMessage: error.message });
      }
      throw error;
    }
  } catch (error) {
    console.error('[QUERY ROUTE] SQL Execution Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'SQL execution failed: ' + error.message,
    });
  }
});

/**
 * POST /api/query/visualize
 * Generate UI specification from query results using LLM
 */
router.post('/visualize', authenticateToken, async (req, res) => {
  try {
    const { originalQuery, sql, rows, fields, requestId, sessionId } = req.body;

    if (!originalQuery) {
      return res.status(400).json({
        success: false,
        message: 'Missing originalQuery.',
      });
    }

    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid rows data.',
      });
    }

    if (!fields || !Array.isArray(fields)) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid fields data.',
      });
    }

    console.log(`[QUERY ROUTE] Generating UI for: "${originalQuery}" (${rows.length} rows)`);

    // Get request ID for logging
    const logRequestId = requestId || (sessionId ? activeRequestLogs.get(sessionId + '_latest') : null);

    const stepStart = Date.now();
    try {
      const uiSpec = await generateUISpec({ originalQuery, sql, rows, fields });
      const durationMs = Date.now() - stepStart;

      // Log UI generation step
      if (logRequestId) {
        await logStep(logRequestId, 'ui_generate',
          { query: originalQuery, rowCount: rows.length, fieldCount: fields.length },
          { uiType: uiSpec?.type, componentCount: uiSpec?.components?.length || 1 },
          null,
          durationMs
        );

        // Complete the log
        await completeLog(logRequestId, 'completed', {
          sql,
          rowCount: rows.length,
          uiSpec
        });
      }

      return res.json({
        success: true,
        requestId: logRequestId,
        uiSpec,
      });
    } catch (error) {
      if (logRequestId) {
        await logStep(logRequestId, 'ui_generate',
          { query: originalQuery, rowCount: rows.length },
          null,
          error.message,
          Date.now() - stepStart
        );
        await completeLog(logRequestId, 'error', { sql, errorMessage: error.message });
      }
      throw error;
    }
  } catch (error) {
    console.error('[QUERY ROUTE] UI Generation Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'UI generation failed: ' + error.message,
    });
  }
});

export default router;
