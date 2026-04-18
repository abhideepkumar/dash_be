import express from 'express';
import bcrypt from 'bcrypt';
import User from '../models/User.js';
import DbConfig from '../models/DbConfig.js';
import { generateToken } from '../middleware/auth.js';
import { encryptDbConfig } from '../utils/encryption.js';
import { triggerAsyncSync } from '../services/syncService.js';

const router = express.Router();

/**
 * POST /api/auth/check
 * Check if email exists (to determine login vs register flow)
 */
router.post('/check', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    return res.json({
      success: true,
      exists: !!user
    });
  } catch (error) {
    console.error('[AUTH] Check email error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

/**
 * POST /api/auth/register
 * Register new user with database config
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, dbConfig } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Check if dbConfig is provided and complete
    const hasFullDbConfig = dbConfig && 
                           dbConfig.host && 
                           dbConfig.database && 
                           dbConfig.user && 
                           dbConfig.password;

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'User already exists'
      });
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      email: email.toLowerCase().trim(),
      passwordHash,
      lastLoginAt: new Date()
    });

    console.log(`[AUTH] Created new user: ${user.email}`);

    // Store encrypted DB config if provided
    let syncStatus = 'none';
    if (hasFullDbConfig) {
      const encryptedConfig = encryptDbConfig(dbConfig);
      const config = await DbConfig.create({
        userId: user._id,
        ...encryptedConfig,
        syncStatus: 'pending'
      });
      syncStatus = 'pending';
      console.log(`[AUTH] Created DB config for user: ${user.email}`);

      // Fire-and-forget: Start schema sync in background
      triggerAsyncSync(user._id.toString(), config._id.toString());
    }

    // Generate token and return immediately
    const token = generateToken(user);

    return res.json({
      success: true,
      token,
      user: {
        email: user.email,
        id: user._id,
        createdAt: user.createdAt
      },
      syncStatus,
      hasDbConfig: hasFullDbConfig
    });

  } catch (error) {
    console.error('[AUTH] Register error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Registration failed: ' + error.message
    });
  }
});

/**
 * POST /api/auth/login
 * Login existing user
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required'
      });
    }

    // Find user
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Update last login
    user.lastLoginAt = new Date();
    await user.save();

    console.log(`[AUTH] User logged in: ${user.email}`);

    // Get sync status
    const dbConfig = await DbConfig.findOne({ userId: user._id });

    // Generate token
    const token = generateToken(user);

    return res.json({
      success: true,
      token,
      user: {
        email: user.email,
        id: user._id,
        createdAt: user.createdAt
      },
      syncStatus: dbConfig?.syncStatus || 'none',
      hasDbConfig: !!dbConfig
    });

  } catch (error) {
    console.error('[AUTH] Login error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

export default router;
