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

  // Conversational context — stores the history of (query, sql) pairs that were
  // passed in with this request, enabling follow-up tracing and replay.
  conversationHistory: {
    type: [{
      query: { type: String },
      sql: { type: String }
    }],
    default: []
  },

  // True when this log entry is a follow-up to a prior query in the same panel
  isFollowUp: {
    type: Boolean,
    default: false
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
