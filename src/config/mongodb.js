import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/dashboard_ai';

let isConnected = false;

/**
 * Connect to MongoDB
 */
export async function connectMongoDB() {
  if (isConnected) {
    console.log('[MONGODB] Already connected');
    return;
  }

  try {
    await mongoose.connect(MONGODB_URI);
    isConnected = true;
    console.log('[MONGODB] Connected to database');
  } catch (error) {
    console.error('[MONGODB] Connection error:', error.message);
    throw error;
  }
}

/**
 * Get connection status
 */
export function isMongoConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

export default mongoose;
