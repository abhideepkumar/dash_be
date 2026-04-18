/**
 * llmClient.js — Centralized Multi-Provider LLM Client
 *
 * Supports:
 *   - Groq        (via openai SDK, OpenAI-compatible)
 *   - Nvidia NIM  (via axios + SSE streaming, assembled internally)
 *
 * To switch provider: set LLM_PROVIDER=groq | nvidia_nim in .env
 *
 * All services call:
 *   import { callLLM, getLLMConfig } from '../utils/llmClient.js';
 *   const { content } = await callLLM(messages, { temperature, max_tokens });
 */

import OpenAI from 'openai';
import axios from 'axios';

// ─────────────────────────────────────────────
// Custom Error Classes
// ─────────────────────────────────────────────

export class LLMConfigError extends Error {
  constructor(message) { super(message); this.name = 'LLMConfigError'; }
}

export class LLMAuthError extends Error {
  constructor(message) { super(message); this.name = 'LLMAuthError'; }
}

export class LLMRateLimitError extends Error {
  constructor(message) { super(message); this.name = 'LLMRateLimitError'; }
}

export class LLMNetworkError extends Error {
  constructor(message) { super(message); this.name = 'LLMNetworkError'; }
}

export class LLMEmptyResponseError extends Error {
  constructor(message) { super(message); this.name = 'LLMEmptyResponseError'; }
}

// ─────────────────────────────────────────────
// Cost Calculation
// ─────────────────────────────────────────────

const PRICING = {
  // Estimated prices per 1M tokens in USD
  'llama-3.3-70b-versatile': { prompt: 0.59, completion: 0.79 },
  'llama3-70b-8192': { prompt: 0.59, completion: 0.79 },
  'llama3-8b-8192': { prompt: 0.05, completion: 0.08 },
  'google/gemma-4-31b-it': { prompt: 0.20, completion: 0.20 },
  'google/gemma-2-9b-it': { prompt: 0.20, completion: 0.20 },
  'meta/llama-3.1-70b-instruct': { prompt: 0.88, completion: 0.88 },
  'default': { prompt: 0.50, completion: 0.50 }
};

export function calculateCost(model, usage) {
  if (!usage) return 0;
  const rates = PRICING[model] || PRICING['default'];
  const promptCost = ((usage.promptTokens || 0) / 1000000) * rates.prompt;
  const completionCost = ((usage.completionTokens || 0) / 1000000) * rates.completion;
  return promptCost + completionCost;
}

export function estimateTokens(text) {
  // Rough estimate: 1 token ~= 4 chars (standard rule of thumb for English text)
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────
// Provider Config Resolution
// ─────────────────────────────────────────────

const SUPPORTED_PROVIDERS = ['groq', 'nvidia_nim'];

/**
 * Resolve provider config from environment variables.
 * Called once; result is cached in module scope.
 * @returns {{ provider: string, apiKey: string, baseURL: string, defaultModel: string }}
 */
function resolveProviderConfig() {
  const provider = (process.env.LLM_PROVIDER || 'groq').toLowerCase().trim();

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new LLMConfigError(
      `[LLM] Unknown LLM_PROVIDER="${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }

  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new LLMConfigError(
        '[LLM] LLM_PROVIDER=groq but GROQ_API_KEY is not set in .env'
      );
    }
    return {
      provider: 'groq',
      apiKey,
      baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      defaultModel: process.env.GROQ_DEFAULT_MODEL || 'llama-3.3-70b-versatile',
    };
  }

  if (provider === 'nvidia_nim') {
    const apiKey = process.env.NVIDIA_NIM_API_KEY;
    if (!apiKey) {
      throw new LLMConfigError(
        '[LLM] LLM_PROVIDER=nvidia_nim but NVIDIA_NIM_API_KEY is not set in .env'
      );
    }
    return {
      provider: 'nvidia_nim',
      apiKey,
      baseURL: process.env.NVIDIA_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1',
      defaultModel: process.env.NVIDIA_NIM_DEFAULT_MODEL || 'google/gemma-4-31b-it',
    };
  }
}

// Cached config — resolved on first use (lazy, not at import time so .env is loaded first)
let _config = null;
let _groqClient = null;

function getConfig() {
  if (!_config) {
    _config = resolveProviderConfig();
    console.log(`[LLM] Provider initialized: ${_config.provider} | default model: ${_config.defaultModel}`);
  }
  return _config;
}

// ─────────────────────────────────────────────
// Groq Adapter (via openai SDK)
// ─────────────────────────────────────────────

function getGroqClient(config) {
  if (!_groqClient) {
    _groqClient = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  }
  return _groqClient;
}

/**
 * Call Groq via openai-compatible SDK.
 * @param {Array} messages - OpenAI-style messages array
 * @param {object} opts - { model?, temperature?, max_tokens? }
 * @returns {Promise<{ content: string, model: string, usage: object }>}
 */
async function callGroq(messages, opts = {}) {
  const config = getConfig();
  const client = getGroqClient(config);

  const model = opts.model || config.defaultModel;

  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      ...(opts.max_tokens ? { max_tokens: opts.max_tokens } : {}),
    });

    const content = response.choices?.[0]?.message?.content?.trim() ?? '';

    if (!content) {
      throw new LLMEmptyResponseError('[LLM][Groq] Received empty content in response');
    }

    const rawUsage = response.usage || {};
    const usage = {
      promptTokens: rawUsage.prompt_tokens || 0,
      completionTokens: rawUsage.completion_tokens || 0,
      totalTokens: rawUsage.total_tokens || 0
    };
    
    // Fallback estimation if usage is not provided
    if (usage.totalTokens === 0) {
      const promptText = messages.map(m => m.content).join('\n');
      usage.promptTokens = estimateTokens(promptText);
      usage.completionTokens = estimateTokens(content);
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
    }

    const estimatedCost = calculateCost(response.model || model, usage);

    return {
      content,
      model: response.model || model,
      usage,
      costDetails: { estimatedCost }
    };
  } catch (err) {
    // Re-classify known HTTP error codes
    if (err instanceof LLMEmptyResponseError) throw err;

    const status = err?.status || err?.response?.status;
    const message = err?.message || String(err);

    if (status === 401) throw new LLMAuthError(`[LLM][Groq] Authentication failed: ${message}`);
    if (status === 429) throw new LLMRateLimitError(`[LLM][Groq] Rate limited: ${message}`);
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
      throw new LLMNetworkError(`[LLM][Groq] Network error: ${message}`);
    }
    // Generic pass-through
    throw new Error(`[LLM][Groq] ${message}`);
  }
}

// ─────────────────────────────────────────────
// Nvidia NIM Adapter (via axios + SSE stream)
// ─────────────────────────────────────────────

/**
 * Parse a single SSE data line and extract delta content.
 * Returns null if the line should be skipped.
 * @param {string} line
 * @returns {string|null}
 */
function parseNimSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const jsonPart = trimmed.slice(5).trim();
  if (jsonPart === '[DONE]') return null; // sentinel — end of stream

  try {
    const parsed = JSON.parse(jsonPart);
    return parsed?.choices?.[0]?.delta?.content ?? null;
  } catch {
    // Malformed chunk (e.g., keep-alive ping) — skip silently
    console.warn('[LLM][NIM] Skipped unparseable SSE chunk:', jsonPart.slice(0, 80));
    return null;
  }
}

/**
 * Call Nvidia NIM via axios streaming, assembling the full response internally.
 * Services receive the same non-streaming interface as with Groq.
 * @param {Array} messages - OpenAI-style messages array
 * @param {object} opts - { model?, temperature?, max_tokens?, top_p?, enableThinking? }
 * @returns {Promise<{ content: string, model: string }>}
 */
async function callNvidiaNim(messages, opts = {}) {
  const config = getConfig();
  const model = opts.model || config.defaultModel;

  const payload = {
    model,
    messages,
    // Provide at least 4096 tokens for NIM models to allow 'thinking' to complete
    // otherwise the stream gets cut off and returns empty content.
    max_tokens: Math.max(opts.max_tokens || 0, 4096),
    temperature: opts.temperature ?? 1.0,
    top_p: opts.top_p ?? 0.95,
    stream: true,
    // Thinking disabled by default unless explicitly requested
    ...(opts.enableThinking ? { chat_template_kwargs: { enable_thinking: true } } : {}),
  };

  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
  };

  try {
    const response = await axios.post(
      `${config.baseURL}/chat/completions`,
      payload,
      { headers, responseType: 'stream', timeout: 120_000 }
    );

    // Assemble the SSE stream into a single string
    return await new Promise((resolve, reject) => {
      let assembled = '';
      let buffer = '';
      let doneSentinelReceived = false;
      let finalModel = model;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        // SSE lines are separated by '\n' or '\n\n'
        const lines = buffer.split('\n');
        // Keep any incomplete last line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed === 'data: [DONE]') {
            doneSentinelReceived = true;
            continue;
          }

          const token = parseNimSseLine(trimmed);
          if (token !== null) {
            assembled += token;
          }
        }
      });

      response.data.on('end', () => {
        // Flush any remaining buffer content
        if (buffer.trim()) {
          const token = parseNimSseLine(buffer.trim());
          if (token !== null) assembled += token;
        }

        if (!doneSentinelReceived) {
          console.warn('[LLM][NIM] Stream ended without [DONE] sentinel. Assembled length:', assembled.length);
        }

        const content = assembled.trim();
        if (!content) {
          reject(new LLMEmptyResponseError('[LLM][NIM] Stream assembled to empty content'));
          return;
        }

        const promptText = messages.map(m => m.content).join('\n');
        const promptTokens = estimateTokens(promptText);
        const completionTokens = estimateTokens(content);
        const totalTokens = promptTokens + completionTokens;
        
        const usage = { promptTokens, completionTokens, totalTokens };
        const estimatedCost = calculateCost(finalModel, usage);

        resolve({ 
          content, 
          model: finalModel,
          usage,
          costDetails: { estimatedCost }
        });
      });

      response.data.on('error', (streamErr) => {
        reject(new LLMNetworkError(
          `[LLM][NIM] Stream error after ${assembled.length} chars: ${streamErr.message}`
        ));
      });
    });
  } catch (err) {
    if (
      err instanceof LLMEmptyResponseError ||
      err instanceof LLMNetworkError
    ) throw err;

    const status = err?.response?.status;
    const message = err?.response?.data?.detail || err?.message || String(err);

    if (status === 401) throw new LLMAuthError(`[LLM][NIM] Authentication failed: ${message}`);
    if (status === 429) throw new LLMRateLimitError(`[LLM][NIM] Rate limited: ${message}`);
    if (status === 400) throw new Error(`[LLM][NIM] Bad request (check model name / payload): ${message}`);
    if (err.code === 'ECONNABORTED') throw new LLMNetworkError(`[LLM][NIM] Request timed out: ${message}`);
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      throw new LLMNetworkError(`[LLM][NIM] Network error: ${message}`);
    }

    throw new Error(`[LLM][NIM] ${message}`);
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Call the active LLM provider with a messages array.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {object} [opts]
 * @param {string}  [opts.model]          - Override the default model
 * @param {number}  [opts.temperature]    - Sampling temperature (default depends on provider)
 * @param {number}  [opts.max_tokens]     - Max tokens to generate
 * @param {number}  [opts.top_p]          - Top-p sampling (NIM only, ignored by Groq)
 * @param {boolean} [opts.enableThinking] - Enable chain-of-thought (NIM only)
 * @returns {Promise<{ content: string, model: string, usage?: object, costDetails?: object }>}
 */
export async function callLLM(messages, opts = {}) {
  const config = getConfig();

  if (config.provider === 'groq') {
    const result = await callGroq(messages, opts);
    if (result.usage && result.costDetails) {
      console.log(`[LLM][Groq] Tokens: ${result.usage.totalTokens} (P:${result.usage.promptTokens}, C:${result.usage.completionTokens}) | Est. Cost: $${result.costDetails.estimatedCost.toFixed(6)}`);
    }
    return result;
  }

  if (config.provider === 'nvidia_nim') {
    const result = await callNvidiaNim(messages, opts);
    if (result.usage && result.costDetails) {
      console.log(`[LLM][NIM] Tokens (Est): ${result.usage.totalTokens} (P:${result.usage.promptTokens}, C:${result.usage.completionTokens}) | Est. Cost: $${result.costDetails.estimatedCost.toFixed(6)}`);
    }
    return result;
  }

  // Unreachable given validateProviderConfig(), but guards against future additions
  throw new LLMConfigError(`[LLM] No adapter implemented for provider: ${config.provider}`);
}

/**
 * Returns current provider metadata (useful for health checks and logging).
 * @returns {{ provider: string, defaultModel: string, baseURL: string }}
 */
export function getLLMConfig() {
  const config = getConfig();
  return {
    provider: config.provider,
    defaultModel: config.defaultModel,
    baseURL: config.baseURL,
  };
}

/**
 * Reset the cached client (useful in tests or if env vars change at runtime).
 */
export function resetLLMClient() {
  _config = null;
  _groqClient = null;
  console.log('[LLM] Client cache reset.');
}
