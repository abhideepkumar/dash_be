import express from 'express';
import { getPool, createPool } from '../config/db.js';
import DbConfig from '../models/DbConfig.js';
import User from '../models/User.js';
import { decryptDbConfig } from '../utils/encryption.js';
import { setSessionGraph } from '../services/queryProcessor.js';
import { authenticateToken } from '../middleware/auth.js';
import { planDashboard, executeDashboard } from '../services/dashboard.service.js';

const router = express.Router();

/**
 * Helper to restore DB connection if missing (same logic as query.routes.js)
 */
async function ensureConnection(sessionId, userId) {
  if (getPool(sessionId)) return true;

  if (sessionId && sessionId.startsWith('user_') && userId) {
    console.log(`[DASHBOARD ROUTE] Restoring connection for session ${sessionId}...`);
    try {
      const dbConfig = await DbConfig.findOne({ userId });
      if (dbConfig && (dbConfig.syncStatus === 'completed' || dbConfig.syncStatus === 'syncing' || dbConfig.tableCount > 0)) {
        const credentials = decryptDbConfig({
          host: dbConfig.host,
          port: dbConfig.port,
          database: dbConfig.database,
          user: dbConfig.user,
          password: dbConfig.password,
        });
        createPool(sessionId, credentials);
        if (dbConfig.schemaGraph) {
          setSessionGraph(sessionId, dbConfig.schemaGraph);
        }
        console.log(`[DASHBOARD ROUTE] Connection restored for ${sessionId}`);
        return true;
      }
    } catch (error) {
      console.error(`[DASHBOARD ROUTE] Failed to restore connection: ${error.message}`);
    }
  }
  return false;
}

/**
 * POST /api/dashboard/plan
 *
 * Phase 1: Run enhanceQuery → vector_search → Blueprint LLM.
 * Returns the blueprint (component list) or a clarification request.
 *
 * Body: { sessionId, query }
 * Returns: {
 *   success,
 *   blueprintId,
 *   dashboardTitle,
 *   clarificationNeeded,
 *   clarifyingQuestions,
 *   components,
 *   sharedContext,
 *   cannotAnswer?,
 *   reason?,
 *   suggestions?
 * }
 */
router.post('/plan', authenticateToken, async (req, res) => {
  try {
    const { sessionId, query } = req.body;
    const userId = req.user?.userId || null;

    if (!sessionId || !query?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Missing sessionId or query.',
      });
    }

    // Guard: check if DB is ready
    if (userId) {
      const user = await User.findById(userId);
      if (user && !user.isReady) {
        return res.status(409).json({
          success: false,
          message: 'Database synchronization in progress. Please wait...',
          isProcessing: true,
        });
      }
    }

    await ensureConnection(sessionId, userId);
    const pool = getPool(sessionId);
    if (!pool) {
      return res.status(400).json({
        success: false,
        message: 'Session not found. Please reconnect to the database.',
      });
    }

    console.log(`[DASHBOARD ROUTE] Planning dashboard for: "${query}"`);

    const result = await planDashboard(query, sessionId);

    if (result.cannotAnswer) {
      return res.json({
        success: true,
        cannotAnswer: true,
        reason: result.reason,
        suggestions: result.suggestions,
      });
    }

    return res.json({ success: true, ...result });

  } catch (error) {
    console.error('[DASHBOARD ROUTE] Plan error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * POST /api/dashboard/execute
 *
 * Phase 2: Execute all blueprint components in parallel.
 * Retrieves pre-fetched tables from the blueprint store — no re-run of vector_search.
 *
 * Body: { sessionId, blueprintId, answers? }
 * Returns: {
 *   success,
 *   dashboardTitle,
 *   sharedContext,
 *   components: [{ id, title, suggestedType, uiSpec, sql, error }]
 * }
 */
router.post('/execute', authenticateToken, async (req, res) => {
  try {
    const { sessionId, blueprintId, answers = {} } = req.body;
    const userId = req.user?.userId || null;

    if (!sessionId || !blueprintId) {
      return res.status(400).json({
        success: false,
        message: 'Missing sessionId or blueprintId.',
      });
    }

    await ensureConnection(sessionId, userId);
    const pool = getPool(sessionId);
    if (!pool) {
      return res.status(400).json({
        success: false,
        message: 'Session not found. Please reconnect to the database.',
      });
    }

    console.log(`[DASHBOARD ROUTE] Executing blueprint ${blueprintId}...`);

    const result = await executeDashboard(blueprintId, pool, answers);

    return res.json({ success: true, ...result });

  } catch (error) {
    console.error('[DASHBOARD ROUTE] Execute error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;
