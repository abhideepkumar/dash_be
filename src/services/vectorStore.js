import { Pinecone } from '@pinecone-database/pinecone';

// Lazy-initialized client (prevents crash on import when env vars not set)
let pinecone = null;

// Lazy-initialized config
const EMBEDDING_MODEL = 'llama-text-embed-v2'; // Pinecone's integrated model
const EMBEDDING_DIMENSION = 1024;

function getIndexName() {
  return 'dash2';
}

/**
 * Get or create Pinecone client
 */
function getPineconeClient() {
  if (!pinecone) {
    pinecone = new Pinecone({
      apiKey: 'pcsk_4Tcxpx_UQUGiT9wZxwCBirDmDsfLj6o9McKw8CNiuegb771wTjD7srYRB8EY4boSKpbqSZ',
    });
  }
  return pinecone;
}

/**
 * Initialize Pinecone index (create if not exists)
 * @returns {Promise<void>}
 */
export async function initIndex() {
  try {
    const pc = getPineconeClient();
    const indexName = getIndexName();
    const existingIndexes = await pc.listIndexes();
    const indexNames = existingIndexes.indexes?.map(idx => idx.name) || [];
    
    if (!indexNames.includes(indexName)) {
      console.log(`Creating Pinecone index: ${indexName}`);
      await pc.createIndex({
        name: indexName,
        dimension: EMBEDDING_DIMENSION,
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: 'aws',
            region: 'us-east-1',
          },
        },
      });
      
      // Wait for index to be ready
      console.log('Waiting for index to be ready...');
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
    
    
    console.log(`Pinecone index ${getIndexName()} is ready`);
  } catch (error) {
    console.error('Error initializing Pinecone index:', error.message);
    throw error;
  }
}

/**
 * Generate embedding for text using Pinecone's inference API
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
export async function generateEmbedding(text) {
  const pc = getPineconeClient();
  
  const response = await pc.inference.embed(
    EMBEDDING_MODEL,
    [text],
    { inputType: 'passage' }
  );
  
  return response.data[0].values;
}

/**
 * Create embeddable text from table metadata
 * @param {object} metadata - Enriched table metadata
 * @returns {string} Text representation for embedding
 */
function createEmbeddableText(metadata) {
  const parts = [
    `Table: ${metadata.table}`,
    `Description: ${metadata.description}`,
    `Columns: ${metadata.columns.map(c => `${c.name} (${c.meaning})`).join(', ')}`,
  ];

  if (metadata.common_queries && metadata.common_queries.length > 0) {
    parts.push(`Common queries: ${metadata.common_queries.join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * Upsert table metadata to Pinecone
 * @param {object} metadata - Enriched table metadata
 * @param {string} namespace - Namespace for isolation (e.g., database name)
 * @returns {Promise<void>}
 */
export async function upsertTableMetadata(metadata, namespace = 'default') {
  const pc = getPineconeClient();
  const index = pc.index(getIndexName());
  
  const embeddableText = createEmbeddableText(metadata);
  const embedding = await generateEmbedding(embeddableText);
  
  await index.namespace(namespace).upsert([
    {
      id: `table_${metadata.table}`,
      values: embedding,
      metadata: {
        table: metadata.table,
        description: metadata.description,
        columns: JSON.stringify(metadata.columns),
        foreign_keys: JSON.stringify(metadata.foreign_keys || []),
        common_queries: JSON.stringify(metadata.common_queries || []),
      },
    },
  ]);
}

/**
 * Upsert all table metadata
 * @param {Array} metadataList - Array of enriched table metadata
 * @param {string} namespace - Namespace for isolation
 * @param {function} onProgress - Progress callback
 * @returns {Promise<void>}
 */
export async function upsertAllMetadata(metadataList, namespace = 'default', onProgress = null) {
  for (let i = 0; i < metadataList.length; i++) {
    const metadata = metadataList[i];
    
    if (onProgress) {
      onProgress(metadata.table, i + 1, metadataList.length, 'storing');
    }
    
    await upsertTableMetadata(metadata, namespace);
    
    // Small delay to avoid rate limiting
    if (i < metadataList.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/**
 * Search for relevant tables given a natural language query
 * @param {string} query - Natural language query
 * @param {string} namespace - Namespace to search in
 * @param {number} topK - Number of results to return
 * @returns {Promise<Array>} Array of relevant tables with scores
 */
export async function searchRelevantTables(query, namespace = 'default', topK = 5) {
  const pc = getPineconeClient();
  const index = pc.index(getIndexName());
  
  const queryEmbedding = await generateEmbedding(query);
  
  const results = await index.namespace(namespace).query({
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
  });
  
  return results.matches.map(match => ({
    table: match.metadata.table,
    description: match.metadata.description,
    score: match.score,
    columns: JSON.parse(match.metadata.columns),
    foreign_keys: JSON.parse(match.metadata.foreign_keys),
    common_queries: JSON.parse(match.metadata.common_queries),
  }));
}

/**
 * Delete all vectors in a namespace
 * @param {string} namespace - Namespace to clear
 * @returns {Promise<void>}
 */
export async function clearNamespace(namespace = 'default') {
  try {
    const pc = getPineconeClient();
    const index = pc.index(getIndexName());
    await index.namespace(namespace).deleteAll();
    console.log(`[PINECONE] Cleared namespace: ${namespace}`);
  } catch (error) {
    // Ignore 404 errors - namespace doesn't exist yet, which is fine
    if (error.message?.includes('404') || error.name === 'PineconeNotFoundError') {
      console.log(`[PINECONE] Namespace ${namespace} doesn't exist yet, skipping clear`);
    } else {
      throw error;
    }
  }
}

/**
 * Get all stored tables in a namespace
 * @param {string} namespace - Namespace to query
 * @returns {Promise<Array>} Array of table names
 */
export async function getStoredTables(namespace = 'default') {
  const pc = getPineconeClient();
  const index = pc.index(getIndexName());
  
  // Pinecone doesn't have a direct "list all" - we use a zero vector query
  const zeroVector = new Array(EMBEDDING_DIMENSION).fill(0);
  
  const results = await index.namespace(namespace).query({
    vector: zeroVector,
    topK: 1000,
    includeMetadata: true,
  });
  
  return results.matches.map(match => ({
    table: match.metadata.table,
    description: match.metadata.description,
  }));
}
