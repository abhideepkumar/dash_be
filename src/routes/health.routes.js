import express from 'express';
import mongoose from 'mongoose';
import { getPool } from '../config/db.js';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from "openai";
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/status', authenticateToken, async (req, res) => {
  const { sessionId } = req.query;
  const results = {
    timestamp: new Date().toISOString(),
    services: {
      mongodb: { status: 'unknown', message: '' },
      postgres: { status: 'unknown', message: '' },
      pinecone: { status: 'unknown', message: '' },
      groq: { status: 'unknown', message: '' },
    },
    env: {
      PINECONE_API_KEY: !!process.env.PINECONE_API_KEY,
      GROQ_API_KEY: !!process.env.GROQ_API_KEY,
      PORT: process.env.PORT || '8000',
    }
  };

  // 1. MongoDB Check
  try {
    const mongoStatus = mongoose.connection.readyState;
    // 0: disconnected, 1: connected, 2: connecting, 3: disconnecting
    if (mongoStatus === 1) {
      results.services.mongodb = { status: 'connected', message: 'Successfully connected' };
    } else {
      results.services.mongodb = { status: 'disconnected', message: `Status code: ${mongoStatus}` };
    }
  } catch (err) {
    results.services.mongodb = { status: 'error', message: err.message };
  }

  // 2. Postgres Check (Session-based)
  if (sessionId) {
    try {
      const pool = getPool(sessionId);
      if (pool) {
        await pool.query('SELECT 1');
        results.services.postgres = { status: 'connected', message: 'Session connection active' };
      } else {
        results.services.postgres = { status: 'disconnected', message: 'No active pool for this session' };
      }
    } catch (err) {
      results.services.postgres = { status: 'error', message: err.message };
    }
  } else {
    results.services.postgres = { status: 'skipped', message: 'No sessionId provided' };
  }

  // 3. Pinecone Check
  try {
    const pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
    // Check if we can list indexes
    await pinecone.listIndexes();
    results.services.pinecone = { status: 'connected', message: 'API responds correctly' };
  } catch (err) {
    results.services.pinecone = { status: 'error', message: err.message };
  }

  // 4. Groq Check
  try {
    const groqClient = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
    // List models as a health check
    await groqClient.models.list();
    results.services.groq = { status: 'connected', message: 'API responds correctly' };
  } catch (err) {
    results.services.groq = { status: 'error', message: err.message };
  }

  res.json({
    success: true,
    ...results
  });
});

export default router;
