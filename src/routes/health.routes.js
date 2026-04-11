import express from 'express';
import mongoose from 'mongoose';
import { getPool } from '../config/db.js';
import { Pinecone } from '@pinecone-database/pinecone';
import { callLLM, getLLMConfig } from '../utils/llmClient.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/status', authenticateToken, async (req, res) => {
  const { sessionId } = req.query;

  // Resolve active LLM provider info upfront (safe — never throws)
  let llmConfig = { provider: 'unknown', defaultModel: 'unknown', baseURL: '' };
  try {
    llmConfig = getLLMConfig();
  } catch (configErr) {
    // Config error handled below in the LLM check
  }

  const results = {
    timestamp: new Date().toISOString(),
    services: {
      mongodb:  { status: 'unknown', message: '' },
      postgres: { status: 'unknown', message: '' },
      pinecone: { status: 'unknown', message: '' },
      llm:      { status: 'unknown', provider: llmConfig.provider, model: llmConfig.defaultModel, message: '' },
    },
    env: {
      LLM_PROVIDER:        process.env.LLM_PROVIDER || 'groq (default)',
      GROQ_API_KEY:        !!process.env.GROQ_API_KEY,
      NVIDIA_NIM_API_KEY:  !!process.env.NVIDIA_NIM_API_KEY,
      PINECONE_API_KEY:    !!process.env.PINECONE_API_KEY,
      PORT:                process.env.PORT || '8000',
    }
  };

  // 1. MongoDB Check
  try {
    const mongoStatus = mongoose.connection.readyState;
    // 0: disconnected, 1: connected, 2: connecting, 3: disconnecting
    if (mongoStatus === 1) {
      results.services.mongodb = { status: 'connected', message: 'Successfully connected' };
    } else {
      results.services.mongodb = { status: 'disconnected', message: `State code: ${mongoStatus}` };
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
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    await pinecone.listIndexes();
    results.services.pinecone = { status: 'connected', message: 'API responds correctly' };
  } catch (err) {
    results.services.pinecone = { status: 'error', message: err.message };
  }

  // 4. LLM Provider Health Check (provider-agnostic)
  // Sends a minimal prompt to verify the active provider is reachable and authenticated.
  try {
    const { content } = await callLLM(
      [{ role: 'user', content: 'Reply with only the word: ok' }],
      { temperature: 0, max_tokens: 5 }
    );
    results.services.llm = {
      status: 'connected',
      provider: llmConfig.provider,
      model: llmConfig.defaultModel,
      message: `API responds correctly (reply: "${content?.slice(0, 20)}")`,
    };
  } catch (err) {
    results.services.llm = {
      status: 'error',
      provider: llmConfig.provider,
      model: llmConfig.defaultModel,
      message: err.message,
    };
  }

  res.json({ success: true, ...results });
});

export default router;

