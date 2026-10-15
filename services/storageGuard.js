const fs = require('fs');
const path = require('path');
const db = require('../db');

// Thresholds to ensure 100% adherence to Cloudflare Free Tier
const CLOUDFLARE_FREE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
const HARD_STORAGE_CAP_BYTES = 8 * 1024 * 1024 * 1024;      // 8 GB (2 GB safety buffer)
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;               // 15 MB max per file
const CLASS_A_MONTHLY_LIMIT = 1_000_000;                     // 1 Million Class A writes/mo
const CLASS_A_CIRCUIT_BREAKER = 800_000;                     // 80% cutoff = 800,000
const CLASS_B_MONTHLY_LIMIT = 10_000_000;                    // 10 Million Class B reads/mo
const CLASS_B_CIRCUIT_BREAKER = 8_000_000;                   // 80% cutoff = 8,000,000
const RETENTION_DAYS = 30;                                   // 30 days retention for draft uploads

function getCurrentYearMonth() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Increment and record Class A (writes/puts/deletes) or Class B (reads/gets) operations
 */
function recordOperation(type = 'class_a', count = 1) {
  try {
    const ym = getCurrentYearMonth();
    const existing = db.prepare('SELECT * FROM usage_metrics WHERE year_month = ?').get(ym);

    if (existing) {
      if (type === 'class_a') {
        db.prepare('UPDATE usage_metrics SET class_a_ops = class_a_ops + ?, last_updated = CURRENT_TIMESTAMP WHERE year_month = ?').run(count, ym);
      } else {
        db.prepare('UPDATE usage_metrics SET class_b_ops = class_b_ops + ?, last_updated = CURRENT_TIMESTAMP WHERE year_month = ?').run(count, ym);
      }
    } else {
      const a = (type === 'class_a') ? count : 0;
      const b = (type === 'class_b') ? count : 0;
      db.prepare('INSERT INTO usage_metrics (year_month, class_a_ops, class_b_ops) VALUES (?, ?, ?)').run(ym, a, b);
    }
  } catch (err) {
    console.error('Failed to record storage operation metric:', err);
  }
}

/**
 * Get current month operations metrics
 */
function getMonthlyMetrics() {
  const ym = getCurrentYearMonth();
  const row = db.prepare('SELECT * FROM usage_metrics WHERE year_month = ?').get(ym);
  return {
    yearMonth: ym,
    classAOps: row ? row.class_a_ops : 0,
    classBOps: row ? row.class_b_ops : 0
  };
}

/**
 * Total storage currently tracked in DB
 */
function getTotalStorageUsed() {
  const row = db.prepare('SELECT COALESCE(SUM(size), 0) as totalBytes, COUNT(*) as fileCount FROM uploads').get();
  return {
    totalBytes: Number(row.totalBytes || 0),
    fileCount: Number(row.fileCount || 0)
  };
}

/**
 * Check if circuit breaker is tripped
 */
function checkCircuitBreaker() {
  const metrics = getMonthlyMetrics();
  const isClassATripped = metrics.classAOps >= CLASS_A_CIRCUIT_BREAKER;
  const isClassBTripped = metrics.classBOps >= CLASS_B_CIRCUIT_BREAKER;

  return {
    tripped: isClassATripped || isClassBTripped,
    isClassATripped,
    isClassBTripped,
    classAOps: metrics.classAOps,
    classAThreshold: CLASS_A_CIRCUIT_BREAKER,
    classBOps: metrics.classBOps,
    classBThreshold: CLASS_B_CIRCUIT_BREAKER
  };
}

/**
 * Validates whether an incoming upload is permitted under the 8GB cap, 15MB file size, and circuit breaker
 */
function validateIncomingUpload(fileSizeBytes = 0) {
  // 1. Check single file size limit (15 MB)
  if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
    return {
      allowed: false,
      code: 'FILE_TOO_LARGE',
      error: `File size exceeds the 15 MB free tier safety limit. Uploaded size: ${(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB.`
    };
  }

  // 2. Check Monthly Request Circuit Breaker (80% threshold)
  const cb = checkCircuitBreaker();
  if (cb.tripped) {
    return {
      allowed: false,
      code: 'CIRCUIT_BREAKER_ACTIVE',
      error: `Monthly request circuit breaker is active to protect Cloudflare Free limits (Class A: ${cb.classAOps}/${cb.classAThreshold}, Class B: ${cb.classBOps}/${cb.classBThreshold}). New operations paused until next billing cycle.`
    };
  }

  // 3. Check Hard Storage Cap (8 GB)
  const storage = getTotalStorageUsed();
  const projectedTotal = storage.totalBytes + fileSizeBytes;

  if (projectedTotal > HARD_STORAGE_CAP_BYTES) {
    const currentGb = (storage.totalBytes / (1024 * 1024 * 1024)).toFixed(2);
    const capGb = (HARD_STORAGE_CAP_BYTES / (1024 * 1024 * 1024)).toFixed(2);
    return {
      allowed: false,
      code: 'STORAGE_CAP_REACHED',
      error: `Storage hard cap reached (${currentGb} GB / ${capGb} GB limit). New uploads blocked to protect your Cloudflare Free tier.`
    };
  }

  return {
    allowed: true,
    currentUsageGb: (storage.totalBytes / (1024 * 1024 * 1024)).toFixed(3),
    headroomGb: ((HARD_STORAGE_CAP_BYTES - projectedTotal) / (1024 * 1024 * 1024)).toFixed(3)
  };
}

/**
 * Automatic Retention Cleanup:
 * Deletes uploads older than 30 days from physical storage and SQLite database
 */
function runRetentionCleanup() {
  try {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const uploadsDir = path.join(__dirname, '..', 'uploads');

    // Find uploads older than retention cutoff
    const oldUploads = db.prepare('SELECT id, filename, size FROM uploads WHERE created_at < ?').all(cutoffDate);

    let deletedFiles = 0;
    let reclaimedBytes = 0;

    const deleteStmt = db.prepare('DELETE FROM uploads WHERE id = ?');

    for (const file of oldUploads) {
      const filePath = path.join(uploadsDir, file.filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn(`Could not delete file ${file.filename}:`, e.message);
        }
      }
      deleteStmt.run(file.id);
      deletedFiles++;
      reclaimedBytes += Number(file.size || 0);
      recordOperation('class_a', 1); // Delete counts as 1 Class A op
    }

    const reclaimedMb = (reclaimedBytes / (1024 * 1024)).toFixed(2);
    console.log(`[Retention Cleanup] Completed. Purged ${deletedFiles} files older than ${RETENTION_DAYS} days (${reclaimedMb} MB reclaimed).`);

    return {
      success: true,
      deletedFiles,
      reclaimedBytes,
      reclaimedMb
    };
  } catch (err) {
    console.error('[Retention Cleanup] Error during automated cleanup:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Live quota status report
 */
function getStorageQuotaReport() {
  const storage = getTotalStorageUsed();
  const metrics = getMonthlyMetrics();
  const cb = checkCircuitBreaker();

  const usedBytes = storage.totalBytes;
  const hardCapBytes = HARD_STORAGE_CAP_BYTES;
  const cloudflareLimitBytes = CLOUDFLARE_FREE_LIMIT_BYTES;

  const usedGb = usedBytes / (1024 * 1024 * 1024);
  const hardCapGb = hardCapBytes / (1024 * 1024 * 1024);
  const cloudflareLimitGb = cloudflareLimitBytes / (1024 * 1024 * 1024);

  const percentOfHardCap = ((usedBytes / hardCapBytes) * 100).toFixed(1);
  const percentOfCloudflare = ((usedBytes / cloudflareLimitBytes) * 100).toFixed(1);

  const classAPercentOfCap = ((metrics.classAOps / CLASS_A_CIRCUIT_BREAKER) * 100).toFixed(1);
  const classBPercentOfCap = ((metrics.classBOps / CLASS_B_CIRCUIT_BREAKER) * 100).toFixed(1);

  return {
    status: cb.tripped ? 'circuit_breaker_paused' : 'healthy',
    storage: {
      usedBytes,
      usedMb: (usedBytes / (1024 * 1024)).toFixed(2),
      usedGb: usedGb.toFixed(3),
      hardCapGb,
      cloudflareFreeLimitGb: cloudflareLimitGb,
      percentOfHardCap: `${percentOfHardCap}%`,
      percentOfCloudflareLimit: `${percentOfCloudflare}%`,
      remainingSafeBufferGb: (hardCapGb - usedGb).toFixed(3),
      totalFreeHeadroomGb: (cloudflareLimitGb - usedGb).toFixed(3),
      fileCount: storage.fileCount
    },
    limits: {
      maxFileSizeMb: MAX_FILE_SIZE_BYTES / (1024 * 1024),
      retentionPolicyDays: RETENTION_DAYS
    },
    monthlyOperations: {
      billingCycle: metrics.yearMonth,
      classA: {
        currentOps: metrics.classAOps,
        circuitBreakerCap: CLASS_A_CIRCUIT_BREAKER,
        freeTierLimit: CLASS_A_MONTHLY_LIMIT,
        percentOfBreaker: `${classAPercentOfCap}%`,
        status: cb.isClassATripped ? 'TRIPPED' : 'NORMAL'
      },
      classB: {
        currentOps: metrics.classBOps,
        circuitBreakerCap: CLASS_B_CIRCUIT_BREAKER,
        freeTierLimit: CLASS_B_MONTHLY_LIMIT,
        percentOfBreaker: `${classBPercentOfCap}%`,
        status: cb.isClassBTripped ? 'TRIPPED' : 'NORMAL'
      }
    },
    circuitBreakerActive: cb.tripped
  };
}

module.exports = {
  HARD_STORAGE_CAP_BYTES,
  MAX_FILE_SIZE_BYTES,
  CLOUDFLARE_FREE_LIMIT_BYTES,
  recordOperation,
  getTotalStorageUsed,
  getMonthlyMetrics,
  checkCircuitBreaker,
  validateIncomingUpload,
  runRetentionCleanup,
  getStorageQuotaReport
};
