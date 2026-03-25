'use strict';

require('dotenv').config();
const config = require('./config');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const schoolRoutes   = require('./routes/schoolRoutes');
const studentRoutes  = require('./routes/studentRoutes');
const paymentRoutes  = require('./routes/paymentRoutes');
const feeRoutes      = require('./routes/feeRoutes');
const reportRoutes   = require('./routes/reportRoutes');
const { runConsistencyCheck } = require('./controllers/consistencyController');
const { startPolling, stopPolling } = require('./services/transactionService');
const { startRetryWorker, stopRetryWorker, isRetryWorkerRunning } = require('./services/retryService');
const { startConsistencyScheduler } = require('./services/consistencyScheduler');
const { initializeRetryQueue, setupMonitoring, getSystemStatus } = require('./config/retryQueueSetup');
const database = require('./config/database');
const { concurrentPaymentProcessor } = require('./services/concurrentPaymentProcessor');
const { createConcurrentRequestMiddleware } = require('./middleware/concurrentRequestHandler');
const { requestLogger } = require('./middleware/requestLogger');

const app = express();

app.use(cors());
app.use(express.json());
app.use(requestLogger());

const concurrentMiddleware = createConcurrentRequestMiddleware({
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
    halfOpenSuccessThreshold: 2
  },
  queue: {
    maxConcurrent: 50,
    maxSize: 1000,
    defaultTimeoutMs: 30000
  },
  rateLimit: {
    windowMs: 60000,
    maxRequests: 100
  },
  deduplicationTtlMs: 60000
});

app.use(concurrentMiddleware.rateLimiter((req) => req.ip));
app.use(concurrentMiddleware.requestQueue());

app.use((req, res, next) => {
  res.setTimeout(config.REQUEST_TIMEOUT_MS, () => {
    const err = new Error(`Request timed out after ${config.REQUEST_TIMEOUT_MS}ms`);
    err.code = 'REQUEST_TIMEOUT';
    next(err);
  });
  next();
});

async function gracefulShutdown(signal) {
  console.log(`[App] ${signal} received, shutting down gracefully`);
  
  stopPolling();
  if (startRetryWorker && startRetryWorker.stop) {
    startRetryWorker.stop();
  }
  
  try {
    await database.disconnect();
    console.log('[App] Database disconnected');
  } catch (error) {
    console.error('[App] Error disconnecting database:', error.message);
  }
  
  process.exit(0);
}

async function initializeDatabase() {
  try {
    await database.connect();
    console.log('MongoDB connected with connection pooling');
    return true;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    return false;
  }
}

async function initializeServices() {
  startPolling();
  startConsistencyScheduler();
  startRetryWorker();

  try {
    await initializeRetryQueue(app);
    setupMonitoring(60000);
    console.log('All services initialized successfully');
  } catch (error) {
    console.error('Failed to initialize retry queue system:', error);
  }
}

app.use('/api/schools', schoolRoutes);
app.use('/api/students',  studentRoutes);
app.use('/api/payments',  paymentRoutes);
app.use('/api/fees',      feeRoutes);
app.use('/api/reports',   reportRoutes);
app.get('/api/consistency', runConsistencyCheck);

app.get('/health', async (req, res) => {
  try {
    const retryQueueStatus = await getSystemStatus();
    res.json({
      status: 'ok',
      retryQueue: retryQueueStatus,
      timestamp: new Date.now().toISOString(),
    });
  } catch (error) {
    res.json({
      status: 'ok',
      retryQueue: { error: error.message },
      timestamp: new Date.now().toISOString(),
    });
  }
});

app.use((err, req, res, next) => {
  const statusMap = {
    TX_FAILED:              400,
    MISSING_MEMO:           400,
    INVALID_DESTINATION:    400,
    UNSUPPORTED_ASSET:      400,
    VALIDATION_ERROR:       400,
    MISSING_SCHOOL_CONTEXT: 400,
    MISSING_IDEMPOTENCY_KEY:400,
    DUPLICATE_TX:           409,
    DUPLICATE_SCHOOL:       409,
    DUPLICATE_STUDENT:      409,
    NOT_FOUND:              404,
    SCHOOL_NOT_FOUND:       404,
    STELLAR_NETWORK_ERROR:  502,
    REQUEST_TIMEOUT:        503,
  };
  const status = statusMap[err.code] || err.status || 500;
  console.error(`[${err.code || 'ERROR'}] ${err.message}`);
  res.status(status).json({ error: err.message, code: err.code || 'INTERNAL_ERROR' });
});

async function startApp() {
  const dbConnected = await initializeDatabase();
  
  if (!dbConnected) {
    console.error('Failed to connect to database. Exiting...');
    process.exit(1);
  }
  
  await initializeServices();
  
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  
  const PORT = config.PORT;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  
  console.log('Application startup complete');
}

startApp();

module.exports = app;
