import express from 'express';
import { getLogsForUser, getLogByRequestId } from '../services/queryLogger.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/logs
 * Get recent query logs for the authenticated user
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    const limit = parseInt(req.query.limit) || 50;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    const logs = await getLogsForUser(userId, limit);

    return res.json({
      success: true,
      count: logs.length,
      logs: logs.map(log => ({
        requestId: log.requestId,
        query: log.originalQuery,
        status: log.status,
        stepCount: log.steps?.length || 0,
        totalDurationMs: log.totalDurationMs,
        createdAt: log.createdAt,
        completedAt: log.completedAt,
        isFollowUp: log.isFollowUp || false,
        historyDepth: log.conversationHistory?.length || 0,
      }))
    });
  } catch (error) {
    console.error('[LOGS] Error fetching logs:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch logs'
    });
  }
});

/**
 * GET /api/logs/:requestId
 * Get full details of a specific query log
 */
router.get('/:requestId', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.params;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: 'Missing requestId'
      });
    }

    const log = await getLogByRequestId(requestId);

    if (!log) {
      return res.status(404).json({
        success: false,
        message: 'Log not found'
      });
    }

    return res.json({
      success: true,
      log
    });
  } catch (error) {
    console.error('[LOGS] Error fetching log:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch log'
    });
  }
});

export default router;
