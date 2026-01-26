import mongoose from 'mongoose';

const dbConfigSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Connection details (host, user, password are encrypted)
  host: {
    type: String,
    required: true
  },
  port: {
    type: Number,
    default: 5432
  },
  database: {
    type: String,
    required: true
  },
  user: {
    type: String,
    required: true
  },
  password: {
    type: String,
    required: true
  },
  
  // Sync status
  syncStatus: {
    type: String,
    enum: ['pending', 'syncing', 'completed', 'error'],
    default: 'pending'
  },
  lastSyncedAt: {
    type: Date
  },
  syncError: {
    type: String
  },
  
  // Metadata after extraction
  tableCount: {
    type: Number,
    default: 0
  },
  schemaGraph: {
    type: Object  // Serialized graph
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update updatedAt on save
// Update updatedAt on save
dbConfigSchema.pre('save', function() {
  this.updatedAt = new Date();
});

const DbConfig = mongoose.model('DbConfig', dbConfigSchema);

export default DbConfig;
