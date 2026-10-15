const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./db');
const briefsRouter = require('./routes/briefs');
const ordersRouter = require('./routes/orders');
const uploadsRouter = require('./routes/uploads');
const aiRouter = require('./routes/ai');
const libraryRouter = require('./routes/library');
const cartRouter = require('./routes/cart');
const notificationsRouter = require('./routes/notifications');
const { runRetentionCleanup, getStorageQuotaReport } = require('./services/storageGuard');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS & JSON parsing
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// API Routes
app.use('/api/briefs', briefsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/library', libraryRouter);
app.use('/api/cart', cartRouter);
app.use('/api/notifications', notificationsRouter);

// Storage Quota and Cloudflare Free-Tier Safeguard Monitoring Endpoint
app.get('/api/storage/quota', (req, res) => {
  try {
    const report = getStorageQuotaReport();
    res.json({ success: true, ...report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  try {
    const creatorCount = db.prepare('SELECT COUNT(*) as count FROM creators').get().count;
    const briefCount = db.prepare('SELECT COUNT(*) as count FROM briefs').get().count;
    const orderCount = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
    const quotaReport = getStorageQuotaReport();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      stats: {
        creators: creatorCount,
        briefs: briefCount,
        orders: orderCount
      },
      storageQuota: {
        usedMb: quotaReport.storage.usedMb,
        hardCapGb: quotaReport.storage.hardCapGb,
        remainingBufferGb: quotaReport.storage.remainingSafeBufferGb,
        circuitBreakerActive: quotaReport.circuitBreakerActive
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Serve frontend static files from root directory
app.use(express.static(__dirname));

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// Run automated retention cleanup on startup and once every 24 hours
try {
  runRetentionCleanup();
  setInterval(() => {
    runRetentionCleanup();
  }, 24 * 60 * 60 * 1000);
} catch (err) {
  console.error('Failed to initialize retention cleanup background job:', err);
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`DansUGC Backend running at http://localhost:${PORT}`);
    console.log(`Edit Brief: http://localhost:${PORT}/edit_brief.html`);
    console.log(`API Health: http://localhost:${PORT}/api/health`);
    console.log(`Storage Quota: http://localhost:${PORT}/api/storage/quota`);
    console.log(`===============================================`);
  });
}

module.exports = app;
