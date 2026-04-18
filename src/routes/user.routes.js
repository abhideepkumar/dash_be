import express from 'express';
import User from '../models/User.js';
import DbConfig from '../models/DbConfig.js';
import { authenticateToken } from '../middleware/auth.js';
import { encryptDbConfig, decryptDbConfig, maskValue, decrypt } from '../utils/encryption.js';
import { triggerAsyncSync, getSyncStatus } from '../services/syncService.js';
import { testConnection } from '../config/db.js';

const router = express.Router();

// All routes in this file require authentication
router.use(authenticateToken);

/**
 * GET /api/user/me
 * Get current user info
 */
router.get('/me', async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    return res.json({
      success: true,
      user: {
        email: user.email,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt
      }
    });
  } catch (error) {
    console.error('[USER] Get user error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to get user info'
    });
  }
});

/**
 * GET /api/user/settings
 * Get user settings with masked DB config
 */
router.get('/settings', async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    const dbConfig = await DbConfig.findOne({ userId: req.user.userId });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Mask sensitive fields for display
    let maskedConfig = null;
    if (dbConfig) {
      maskedConfig = {
        host: maskValue(decrypt(dbConfig.host)),
        port: dbConfig.port,
        database: dbConfig.database,
        user: maskValue(decrypt(dbConfig.user)),
        password: '••••••••',
        syncStatus: dbConfig.syncStatus,
        lastSyncedAt: dbConfig.lastSyncedAt,
        tableCount: dbConfig.tableCount,
        syncError: dbConfig.syncError
      };
    }

    return res.json({
      success: true,
      user: {
        email: user.email,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt
      },
      dbConfig: maskedConfig
    });
  } catch (error) {
    console.error('[USER] Get settings error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to get settings'
    });
  }
});

/**
 * POST /api/user/sync
 * Trigger database schema re-sync
 */
router.post('/sync', async (req, res) => {
  try {
    const dbConfig = await DbConfig.findOne({ userId: req.user.userId });

    if (!dbConfig) {
      return res.status(404).json({
        success: false,
        error: 'No database configuration found'
      });
    }

    // Don't allow sync if already syncing
    if (dbConfig.syncStatus === 'syncing') {
      return res.json({
        success: true,
        message: 'Sync already in progress',
        syncStatus: 'syncing'
      });
    }

    // Trigger fire-and-forget sync
    triggerAsyncSync(req.user.userId, dbConfig._id.toString());

    console.log(`[USER] Sync triggered for user: ${req.user.email}`);

    return res.json({
      success: true,
      message: 'Sync started',
      syncStatus: 'syncing'
    });
  } catch (error) {
    console.error('[USER] Sync trigger error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to start sync'
    });
  }
});

/**
 * GET /api/user/sync-status
 * Poll sync status
 */
router.get('/sync-status', async (req, res) => {
  try {
    const status = await getSyncStatus(req.user.userId);
    return res.json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('[USER] Sync status error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to get sync status'
    });
  }
});

/**
 * POST /api/user/connect
 * Save database configuration and trigger sync
 */
router.post('/connect', async (req, res) => {
  try {
    const { host, port, database, user, password } = req.body;

    if (!host || !database || !user || !password) {
      return res.status(400).json({
        success: false,
        error: 'Complete database configuration is required (host, database, user, password)'
      });
    }

    const dbConfigPlain = { host, port: port || 5432, database, user, password };
    
    // 1. Test connection first
    console.log(`[USER] Testing connection for user: ${req.user.email}`);
    const testResult = await testConnection(dbConfigPlain);
    
    if (!testResult.success) {
      return res.status(400).json({
        success: false,
        error: 'Connection test failed: ' + testResult.message
      });
    }

    // 2. Encrypt and save config
    const encryptedConfig = encryptDbConfig(dbConfigPlain);
    
    let dbConfig = await DbConfig.findOne({ userId: req.user.userId });
    
    if (dbConfig) {
      // Update existing
      Object.assign(dbConfig, {
        ...encryptedConfig,
        syncStatus: 'pending',
        updatedAt: new Date()
      });
      await dbConfig.save();
    } else {
      // Create new
      dbConfig = await DbConfig.create({
        userId: req.user.userId,
        ...encryptedConfig,
        syncStatus: 'pending'
      });
    }

    console.log(`[USER] Saved DB config for user: ${req.user.email}`);

    // 3. Trigger async sync
    triggerAsyncSync(req.user.userId, dbConfig._id.toString());

    return res.json({
      success: true,
      message: 'Database connected and sync started',
      syncStatus: 'pending'
    });
  } catch (error) {
    console.error('[USER] Connect error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to save database configuration: ' + error.message
    });
  }
});

export default router;
