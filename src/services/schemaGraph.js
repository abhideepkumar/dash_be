/**
 * Schema Graph Module
 * 
 * Implements graph-enhanced schema retrieval using optimal DSA:
 * - Adjacency List with Map<string, Set<string>> for O(1) operations
 * - Multi-Source BFS for O(V+E) bridge detection
 * 
 * Solves the "Bridge Table Problem" - automatically finds junction tables
 * that connect semantically-retrieved tables.
 */

/**
 * Build bidirectional graph from schema foreign keys
 * 
 * Time: O(T × F) where T = tables, F = avg foreign keys per table
 * Space: O(T + E) where E = total edges
 * 
 * @param {Array} rawSchemas - Array of table schemas with foreignKeys
 * @returns {{ nodes: Map, edges: Map }} Schema graph
 */
export function buildSchemaGraph(rawSchemas) {
  const nodes = new Map();
  const edges = new Map();
  
  // The canonical schema IS the node — store directly without spreading
  for (const schema of rawSchemas) {
    nodes.set(schema.table, schema);
    edges.set(schema.table, new Set());
  }
  
  // Build bidirectional edges from canonical relationships[]
  for (const schema of rawSchemas) {
    const sourceTable = schema.table;
    
    for (const rel of schema.relationships || []) {
      const targetTable = rel.references_table;
      if (targetTable === sourceTable || !edges.has(targetTable)) continue;
      edges.get(sourceTable).add(targetTable);
      edges.get(targetTable).add(sourceTable);
    }
    
    // Also build from column-level references (covers all FK paths)
    for (const col of schema.columns || []) {
      if (col.references) {
        const targetTable = col.references.split('.')[0];
        if (targetTable !== sourceTable && edges.has(targetTable)) {
          edges.get(sourceTable).add(targetTable);
          edges.get(targetTable).add(sourceTable);
        }
      }
    }
  }
  
  const edgeCount = countEdges(edges);
  console.log(`[GRAPH] Built schema graph: ${nodes.size} nodes, ${edgeCount} edges`);
  
  return { nodes, edges };
}

/**
 * Count total edges (for logging)
 * @private
 */
function countEdges(edges) {
  let count = 0;
  for (const neighbors of edges.values()) {
    count += neighbors.size;
  }
  return count / 2; // Bidirectional, so divide by 2
}

/**
 * Multi-Source BFS to find bridge and neighbor tables
 * 
 * Algorithm:
 * 1. Start BFS from ALL seed tables simultaneously
 * 2. Track which seed(s) can reach each discovered node
 * 3. A node is a "bridge" if it can be reached from 2+ different seeds
 * 
 * Time: O(V + E) - single pass through graph
 * Space: O(V) - visited map
 * 
 * @param {Object} graph - { nodes: Map, edges: Map }
 * @param {string[]} seedTables - Tables from vector search
 * @param {number} maxHops - Maximum distance from seeds (default: 2)
 * @returns {{ bridges: Set, neighbors: Set, visited: Map }}
 */
export function findConnectingTables(graph, seedTables, maxHops = 2) {
  const { edges } = graph;
  const seeds = new Set(seedTables);
  
  // State tracking with proper data structures
  const visited = new Map(); // node → { distance, sources: Set, parent }
  const queue = [];          // BFS queue
  const bridges = new Set(); // Tables connecting 2+ seeds
  const neighbors = new Set(); // All reachable non-seed tables
  
  // Initialize: all seeds at distance 0
  for (const seed of seedTables) {
    if (!edges.has(seed)) {
      console.warn(`[GRAPH] Seed table "${seed}" not found in graph`);
      continue;
    }
    
    visited.set(seed, {
      distance: 0,
      sources: new Set([seed]),
      parent: null
    });
    queue.push({ node: seed, distance: 0, source: seed });
  }
  
  // BFS traversal
  while (queue.length > 0) {
    const { node, distance, source } = queue.shift();
    
    // Don't exceed max hops
    if (distance >= maxHops) continue;
    
    // Get neighbors (O(1) lookup)
    const nodeNeighbors = edges.get(node);
    if (!nodeNeighbors) continue;
    
    // Explore each neighbor
    for (const neighbor of nodeNeighbors) {
      if (visited.has(neighbor)) {
        // Already visited - check if reached from different source
        const info = visited.get(neighbor);
        
        if (!info.sources.has(source)) {
          info.sources.add(source);
          
          // Node connects 2+ seeds = it's a bridge!
          if (info.sources.size >= 2 && !seeds.has(neighbor)) {
            bridges.add(neighbor);
          }
        }
        // Don't re-queue already visited nodes
      } else {
        // First visit to this node
        visited.set(neighbor, {
          distance: distance + 1,
          sources: new Set([source]),
          parent: node
        });
        
        // Track as neighbor if not a seed
        if (!seeds.has(neighbor)) {
          neighbors.add(neighbor);
        }
        
        // Continue BFS from this node
        queue.push({
          node: neighbor,
          distance: distance + 1,
          source: source
        });
      }
    }
  }
  
  console.log(`[GRAPH] Multi-Source BFS: ${bridges.size} bridges, ${neighbors.size} neighbors from ${seeds.size} seeds (maxHops=${maxHops})`);
  
  return { bridges, neighbors, visited };
}

/**
 * Expand vector search results with graph context
 * 
 * Priority:
 * 1. Bridge tables (connect 2+ seeds) - HIGH priority
 * 2. 1-hop neighbors with most connections - MEDIUM priority
 * 
 * @param {Object} graph - Schema graph { nodes, edges }
 * @param {Array} vectorResults - Results from vector search
 * @param {number} maxHops - Max distance (default: 2)
 * @param {number} maxExpansion - Max tables to add (default: 3)
 * @returns {Array} Expanded results with bridge tables included
 */
export function expandWithGraph(graph, vectorResults, maxHops = 2, maxExpansion = 3) {
  if (!graph || !graph.nodes || !graph.edges) {
    console.warn('[GRAPH] No valid graph provided, returning original results');
    return vectorResults;
  }
  
  const seedTables = vectorResults.map(r => r.table);
  const seedSet = new Set(seedTables);
  
  // Find bridges and neighbors using Multi-Source BFS
  const { bridges, neighbors } = findConnectingTables(graph, seedTables, maxHops);
  
  const expanded = [...vectorResults];
  let added = 0;
  
  // Priority 1: Add bridge tables (most valuable - they connect seeds)
  for (const bridge of bridges) {
    if (added >= maxExpansion) break;
    if (seedSet.has(bridge)) continue;
    
    const metadata = graph.nodes.get(bridge);
    if (metadata) {
      expanded.push({
        table: bridge,
        table_type: metadata.table_type || 'bridge',
        description: metadata.description || `Bridge table connecting query-relevant tables`,
        score: 0,
        columns: metadata.columns || [],
        relationships: metadata.relationships || [],
        profile: metadata.profile || null,
        is_bridge: true,
        common_queries: metadata.common_queries || []
      });
      added++;
      console.log(`[GRAPH] Added bridge table: ${bridge}`);
    }
  }
  
  // Priority 2: Add high-connectivity neighbors ONLY if they connect 2+ seeds.
  // This prevents noise like dim_location appearing for product-only queries.
  // For single-seed scenarios, only add direct FK-related tables.
  if (added < maxExpansion) {
    const rankedNeighbors = [...neighbors]
      .filter(n => !seedSet.has(n))
      .map(n => ({
        table: n,
        connections: countConnectionsToSeeds(graph, n, seedSet)
      }))
      // Only add neighbors that connect to at least 2 seeds (high relevance)
      // OR if there's only 1 seed, add direct 1-hop neighbors that are FK-related
      .filter(n => n.connections >= Math.min(2, seedTables.length))
      .sort((a, b) => b.connections - a.connections);
    
    for (const { table, connections } of rankedNeighbors) {
      if (added >= maxExpansion) break;
      
      const metadata = graph.nodes.get(table);
      if (metadata) {
        expanded.push({
          table,
          table_type: metadata.table_type || 'dimension',
          description: metadata.description,
          score: 0,
          columns: metadata.columns || [],
          relationships: metadata.relationships || [],
          profile: metadata.profile || null,
          is_neighbor: true,
          neighbor_connections: connections,
          common_queries: metadata.common_queries || []
        });
        added++;
        console.log(`[GRAPH] Added neighbor table: ${table} (${connections} seed-connections)`);
      }
    }
  }
  
  if (added > 0) {
    console.log(`[GRAPH] Expanded results: ${vectorResults.length} → ${expanded.length} tables`);
  }
  
  return expanded;
}

/**
 * Count how many seed tables a given table is directly connected to
 * @private
 */
function countConnectionsToSeeds(graph, table, seeds) {
  const neighbors = graph.edges.get(table);
  if (!neighbors) return 0;
  
  let count = 0;
  for (const neighbor of neighbors) {
    if (seeds.has(neighbor)) count++;
  }
  return count;
}

/**
 * Serialize graph for JSON storage
 * Converts Map/Set to plain objects/arrays
 * 
 * @param {Object} graph - { nodes: Map, edges: Map }
 * @returns {Object} JSON-safe representation
 */
export function serializeGraph(graph) {
  const nodes = {};
  const edges = {};
  
  for (const [key, value] of graph.nodes) {
    nodes[key] = value;
  }
  
  for (const [key, value] of graph.edges) {
    edges[key] = [...value]; // Set → Array
  }
  
  return { nodes, edges };
}

/**
 * Deserialize graph from JSON storage
 * Converts plain objects/arrays back to Map/Set
 * 
 * @param {Object} serialized - { nodes: Object, edges: Object }
 * @returns {Object} Graph with Map/Set structures
 */
export function deserializeGraph(serialized) {
  if (!serialized || !serialized.nodes || !serialized.edges) {
    return null;
  }
  
  const nodes = new Map(Object.entries(serialized.nodes));
  const edges = new Map();
  
  for (const [key, value] of Object.entries(serialized.edges)) {
    edges.set(key, new Set(value)); // Array → Set
  }
  
  return { nodes, edges };
}

/**
 * Get graph statistics for debugging
 * 
 * @param {Object} graph - Schema graph
 * @returns {Object} Statistics
 */
export function getGraphStats(graph) {
  const nodeCount = graph.nodes.size;
  const edgeCount = countEdges(graph.edges);
  
  // Find tables with most connections (potential hubs)
  const connectionCounts = [];
  for (const [table, neighbors] of graph.edges) {
    connectionCounts.push({ table, connections: neighbors.size });
  }
  connectionCounts.sort((a, b) => b.connections - a.connections);
  
  // Find isolated tables (no FKs)
  const isolated = connectionCounts.filter(c => c.connections === 0).map(c => c.table);
  
  return {
    nodeCount,
    edgeCount,
    topConnected: connectionCounts.slice(0, 5),
    isolatedTables: isolated
  };
}
