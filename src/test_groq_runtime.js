import dotenv from 'dotenv';
dotenv.config({ override: true });

import { generateSQL } from './services/queryProcessor.js';
import { generateAllMetadata } from './services/metadataGenerator.js';

async function testRuntimeConfig() {
  console.log('Testing Groq Runtime Configuration...');
  console.log('Current GROQ_API_KEY from process.env:', process.env.GROQ_API_KEY ? 'Present' : 'Missing');

  const dummyTable = [{
    table: 'test_table',
    description: 'A test table',
    columns: [{ name: 'id', type: 'integer', meaning: 'primary key' }]
  }];

  try {
    console.log('\n1. Testing queryProcessor.generateSQL...');
    const sql = await generateSQL('show all from test_table', dummyTable);
    console.log('✅ queryProcessor SUCCESS');
  } catch (err) {
    console.error('❌ queryProcessor FAILED:', err.message);
  }

  try {
    console.log('\n2. Testing metadataGenerator.generateAllMetadata...');
    const metadata = await generateAllMetadata([{
      table: 'test_table',
      columns: [{ name: 'id', type: 'integer' }],
      primaryKeys: ['id'],
      foreignKeys: []
    }]);
    console.log('✅ metadataGenerator SUCCESS');
  } catch (err) {
    console.error('❌ metadataGenerator FAILED:', err.message);
  }
}

testRuntimeConfig();
