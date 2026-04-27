import dotenv from 'dotenv';
dotenv.config({ override: true });

import express from 'express';
import cors from 'cors';
import { connectMongoDB } from './config/mongodb.js';
import schemaRoutes from './routes/schema.routes.js';
import queryRoutes from './routes/query.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import logsRoutes from './routes/logs.routes.js';
import healthRoutes from './routes/health.routes.js';

const app = express();
const PORT = 8000;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
  next();
});

// Health check
app.use('/api/health', healthRoutes);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/schema', schemaRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/logs', logsRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Connect to MongoDB and start server
async function startServer() {
  try {
    await connectMongoDB();
    
    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════╗
║    Dashboard AI Backend                    ║
║    Running on http://localhost:${PORT}         ║
║    MongoDB: Connected                      ║
╚════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();

