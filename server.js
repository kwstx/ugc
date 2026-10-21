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
const { billingRouter, stripeWebhookHandler } = require('./routes/billing');
const authRouter = require('./routes/auth');
const creatorsRouter = require('./routes/creators');
const { runRecurringCreditDripJob } = require('./services/subscriptionCron');
const { runRetentionCleanup, getStorageQuotaReport } = require('./services/storageGuard');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS & JSON parsing (preserve rawBody for Stripe Webhook HMAC signature verification)
app.use(cors());
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ensure uploads folder exists
const isVercel = process.env.VERCEL === '1' || process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;
const uploadsDir = isVercel ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (err) {
    console.warn('Could not create uploads directory:', err.message);
  }
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
app.use('/api/billing', billingRouter);
app.use('/api/auth', authRouter);
app.use('/api/creators', creatorsRouter);
app.post('/api/webhooks/stripe', stripeWebhookHandler);

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
    const activeSubsCount = db.prepare("SELECT COUNT(*) as count FROM subscriptions WHERE status IN ('trialing', 'active')").get().count;
    const quotaReport = getStorageQuotaReport();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      stats: {
        creators: creatorCount,
        briefs: briefCount,
        orders: orderCount,
        activeSubscriptions: activeSubsCount
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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static(__dirname));

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// Run automated retention cleanup + subscription credit drip worker on startup and once every 24 hours
try {
  runRetentionCleanup();
  runRecurringCreditDripJob();
  if (!isVercel) {
    setInterval(() => {
      runRetentionCleanup();
      runRecurringCreditDripJob();
    }, 24 * 60 * 60 * 1000);
  }
} catch (err) {
  console.error('Failed to initialize background jobs:', err);
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`Sofia Backend running at http://localhost:${PORT}`);
    console.log(`Pricing & Subscriptions: http://localhost:${PORT}/pricing.html`);
    console.log(`Edit Brief: http://localhost:${PORT}/edit_brief.html`);
    console.log(`API Health: http://localhost:${PORT}/api/health`);
    console.log(`Storage Quota: http://localhost:${PORT}/api/storage/quota`);
    console.log(`===============================================`);
  });
}

module.exports = app;
