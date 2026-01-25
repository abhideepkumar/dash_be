// Load environment variables FIRST (before any other imports)
// import 'dotenv/config'; // REMOVED: Hardcoding env vars

import express from 'express';
import cors from 'cors';
import schemaRoutes from './routes/schema.routes.js';
import queryRoutes from './routes/query.routes.js';

const app = express();
const PORT = 8000;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'Dashboard AI Backend'
  });
});

// Routes
app.use('/api/schema', schemaRoutes);
app.use('/api/query', queryRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║    Dashboard AI Backend                    ║
║    Running on http://localhost:${PORT}         ║
╚════════════════════════════════════════════╝
  `);
});
