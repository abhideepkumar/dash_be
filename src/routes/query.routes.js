import express from 'express';
import { getPool } from '../config/db.js';
import { processUserQuery } from '../services/queryProcessor.js';
import { generateUISpec } from '../services/uiGenerator.js';

const router = express.Router();

/**
 * POST /api/query/generate
 * Generate SQL from natural language query
 */
router.post('/generate', async (req, res) => {
  try {
    const { sessionId, query, topK = 5 } = req.body;

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

    const pool = getPool(sessionId);
    if (!pool) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sessionId. Connection not found.',
      });
    }

    console.log(`[QUERY ROUTE] Processing query: "${query}"`);

    const result = await processUserQuery(query, sessionId, topK);

    return res.json({
      success: true,
      ...result,
    });
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
router.post('/execute', async (req, res) => {
  try {
    const { sessionId, sql } = req.body;

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

    const pool = getPool(sessionId);
    if (!pool) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sessionId. Connection not found.',
      });
    }

    console.log(`[QUERY ROUTE] Executing SQL: ${sql.substring(0, 100)}...`);

    const result = await pool.query(sql);

    return res.json({
      success: true,
      rowCount: result.rowCount,
      rows: result.rows,
      fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
    });
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
router.post('/visualize', async (req, res) => {
  try {
    const { originalQuery, sql, rows, fields } = req.body;

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

    const uiSpec = await generateUISpec({ originalQuery, sql, rows, fields });

    return res.json({
      success: true,
      uiSpec,
    });
  } catch (error) {
    console.error('[QUERY ROUTE] UI Generation Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'UI generation failed: ' + error.message,
    });
  }
});

export default router;

