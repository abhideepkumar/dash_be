import { randomUUID } from 'crypto';
import QueryLog from '../models/QueryLog.js';

/**
 * Query Logger Service
 * Provides comprehensive logging for each query request with step-by-step tracking
 */

/**
 * Create a new query log entry
 * @param {string} userId - User ID (can be null for anonymous)
 * @param {string} query - Original user query
 * @param {string} sessionId - Session ID
 * @returns {Promise<string>} Request ID for tracking
 */
export async function createLog(userId, query, sessionId) {
  const requestId = randomUUID();
  
  const log = await QueryLog.create({
    userId,
    requestId,
    originalQuery: query,
    sessionId,
    steps: [],
    status: 'pending',
    createdAt: new Date()
  });
  
  console.log(`[LOG] Created query log: ${requestId}`);
  return requestId;
}

/**
 * Log a processing step
 * @param {string} requestId - Request ID from createLog
 * @param {string} stepName - Name of the step
 * @param {object} input - Input data for this step
 * @param {object} output - Output data from this step
 * @param {string} error - Error message if step failed
 * @param {number} durationMs - Duration in milliseconds
 */
export async function logStep(requestId, stepName, input, output, error = null, durationMs = 0) {
  const step = {
    name: stepName,
    startedAt: new Date(Date.now() - durationMs),
    completedAt: new Date(),
    durationMs,
    input: sanitizeForMongo(input),
    output: sanitizeForMongo(output),
    error
  };
  
  await QueryLog.findOneAndUpdate(
    { requestId },
    { $push: { steps: step } }
  );
  
  const status = error ? '❌' : '✓';
  console.log(`[LOG] ${status} Step "${stepName}" logged (${durationMs}ms)`);
}

/**
 * Complete the log with final status
 * @param {string} requestId - Request ID
 * @param {string} status - 'completed' or 'error'
 * @param {object} finalData - Final results (sql, rowCount, uiSpec, errorMessage)
 */
export async function completeLog(requestId, status, finalData = {}) {
  const log = await QueryLog.findOne({ requestId });
  if (!log) return;
  
  const completedAt = new Date();
  const totalDurationMs = completedAt - log.createdAt;
  
  await QueryLog.findOneAndUpdate(
    { requestId },
    {
      status,
      completedAt,
      totalDurationMs,
      generatedSQL: finalData.sql,
      rowCount: finalData.rowCount,
      uiSpec: finalData.uiSpec,
      errorMessage: finalData.errorMessage
    }
  );
  
  console.log(`[LOG] Query log completed: ${requestId} (${status}, ${totalDurationMs}ms total)`);
}

/**
 * Get logs for a user
 * @param {string} userId - User ID
 * @param {number} limit - Max number of logs to return
 * @returns {Promise<Array>} Array of query logs
 */
export async function getLogsForUser(userId, limit = 50) {
  return QueryLog.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-uiSpec') // Exclude large uiSpec from list view
    .lean()
    .then(logs => {
      return logs.map(log => ({
        ...log,
        steps: log.steps ? log.steps.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt)) : []
      }));
    });
}

/**
 * Get a single log by request ID
 * @param {string} requestId - Request ID
 * @returns {Promise<object>} Full query log
 */
export async function getLogByRequestId(requestId) {
  const log = await QueryLog.findOne({ requestId }).lean();
  if (log && log.steps) {
    log.steps.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  }
  return log;
}

/**
 * Sanitize data for MongoDB storage (handle circular refs, limit size)
 */
function sanitizeForMongo(data) {
  if (!data) return data;
  
  try {
    // Convert to JSON and back to remove circular refs and functions
    const str = JSON.stringify(data, (key, value) => {
      // Limit array sizes
      if (Array.isArray(value) && value.length > 100) {
        return [...value.slice(0, 100), `... (${value.length - 100} more items)`];
      }
      // Limit string sizes
      if (typeof value === 'string' && value.length > 5000) {
        return value.substring(0, 5000) + '... (truncated)';
      }
      return value;
    });
    return JSON.parse(str);
  } catch (e) {
    return { _error: 'Could not serialize data' };
  }
}

export default {
  createLog,
  logStep,
  completeLog,
  getLogsForUser,
  getLogByRequestId
};
