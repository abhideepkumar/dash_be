
import { generateAllMetadata } from '../src/services/metadataGenerator.js';

// Mock raw schemas
const mockSchemas = [
  {
    table: 'users',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'email', type: 'varchar', nullable: false },
      { name: 'created_at', type: 'timestamp', nullable: true }
    ],
    foreignKeys: [],
    primaryKeys: ['id']
  },
  {
    table: 'orders',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'user_id', type: 'uuid', nullable: false },
      { name: 'amount', type: 'decimal', nullable: false }
    ],
    foreignKeys: [
      { column: 'user_id', references: 'users.id' }
    ],
    primaryKeys: ['id']
  }
];

async function testMetadataGeneration() {
  console.log('Testing metadata generation...');
  try {
    const enriched = await generateAllMetadata(mockSchemas, (table) => {
      console.log(`Processing ${table}...`);
    });

    console.log('\n--- Result ---');
    console.log(JSON.stringify(enriched, null, 2));

    // Validation
    const ordersTable = enriched.find(t => t.table === 'orders');
    if (!ordersTable) throw new Error('Orders table not found in result');

    if (!Array.isArray(ordersTable.foreign_keys)) {
      throw new Error('foreign_keys is not an array');
    }
    
    // Check if it's array of strings
    if (ordersTable.foreign_keys.length > 0 && typeof ordersTable.foreign_keys[0] !== 'string') {
      throw new Error('foreign_keys elements are not strings: ' + JSON.stringify(ordersTable.foreign_keys));
    }

    console.log('\n✅ Verification SUCCESS: Output format matches requirements.');
  } catch (error) {
    console.error('\n❌ Verification FAILED:', error);
    process.exit(1);
  }
}

testMetadataGeneration();
