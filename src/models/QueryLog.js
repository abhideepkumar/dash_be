import mongoose from 'mongoose';

const stepSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    enum: ['enhance', 'vector_search', 'graph_expand', 'sql_generate', 'sql_execute', 'ui_generate']
  },
  startedAt: {
    type: Date,
    required: true
  },
  completedAt: {
    type: Date
  },
  durationMs: {
    type: Number
  },
  input: {
    type: mongoose.Schema.Types.Mixed
  },
  output: {
    type: mongoose.Schema.Types.Mixed
  },
  error: {
    type: String
  }
}, { _id: false });

const queryLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  requestId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Input
  originalQuery: {
    type: String,
    required: true
  },
  sessionId: {
    type: String,
    required: true
  },
  
  // Processing steps
  steps: [stepSchema],
  
  // Final results
  generatedSQL: {
    type: String
  },
  rowCount: {
    type: Number
  },
  uiSpec: {
    type: mongoose.Schema.Types.Mixed
  },
  
  // Status
  status: {
    type: String,
    enum: ['pending', 'completed', 'error'],
    default: 'pending'
  },
  errorMessage: {
    type: String
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  completedAt: {
    type: Date
  },
  totalDurationMs: {
    type: Number
  }
});

// Index for querying by user and date
queryLogSchema.index({ userId: 1, createdAt: -1 });

const QueryLog = mongoose.model('QueryLog', queryLogSchema);

export default QueryLog;
