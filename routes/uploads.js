const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const {
  MAX_FILE_SIZE_BYTES,
  validateIncomingUpload,
  recordOperation,
  getStorageQuotaReport,
  runRetentionCleanup
} = require('../services/storageGuard');

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const uniqueName = `asset_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
    cb(null, uniqueName);
  }
});

// Configure Multer with 15 MB file size restriction
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES } // 15MB limit strictly enforced
});

/**
 * Middleware to check pre-upload limits before receiving large buffers
 */
function preUploadCheck(req, res, next) {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_FILE_SIZE_BYTES) {
    return res.status(400).json({
      success: false,
      code: 'FILE_TOO_LARGE',
      error: `File size exceeds the 15 MB limit. Header reported ${(contentLength / (1024 * 1024)).toFixed(2)} MB.`
    });
  }

  // Pre-validate with estimated size
  const check = validateIncomingUpload(contentLength);
  if (!check.allowed) {
    return res.status(403).json({
      success: false,
      code: check.code,
      error: check.error
    });
  }

  next();
}

/**
 * GET /api/uploads/quota
 * Returns live breakdown of storage used, remaining buffer to 8GB, and circuit breaker status
 */
router.get('/quota', (req, res) => {
  try {
    recordOperation('class_b', 1); // Reading quota counts as 1 Class B read
    const report = getStorageQuotaReport();
    res.json({ success: true, ...report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/uploads
 * Multipart file upload for brand assets, logos, and reference clips
 * Protected by 15MB file size limit, 8GB storage cap, and monthly circuit breaker
 */
router.post('/', preUploadCheck, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          code: 'FILE_TOO_LARGE',
          error: 'File size exceeds maximum allowed limit of 15 MB.'
        });
      }
      return res.status(400).json({ success: false, error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    // Verify exact uploaded file size against limits
    const validation = validateIncomingUpload(req.file.size);
    if (!validation.allowed) {
      // Clean up file if it exceeded quota
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}

      return res.status(403).json({
        success: false,
        code: validation.code,
        error: validation.error
      });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const uploadId = `upload_${Date.now()}`;

    const insertStmt = db.prepare(`
      INSERT INTO uploads (id, filename, original_name, mimetype, size, url)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      uploadId,
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      fileUrl
    );

    // Record 1 Class A operation (Put/Write)
    recordOperation('class_a', 1);

    res.json({
      success: true,
      file: {
        id: uploadId,
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        sizeMb: (req.file.size / (1024 * 1024)).toFixed(2),
        url: fileUrl
      },
      quotaStatus: {
        currentUsageGb: validation.currentUsageGb,
        headroomGb: validation.headroomGb
      }
    });
  });
});

/**
 * POST /api/uploads/presigned-url
 * Generates an upload URL for client-side direct S3/R2/Cloud Storage upload
 * Validates against circuit breaker and storage cap before issuing URL
 */
router.post('/presigned-url', (req, res) => {
  try {
    const { filename, contentType, expectedSizeBytes = 0 } = req.body;
    if (!filename) {
      return res.status(400).json({ success: false, error: 'Filename is required.' });
    }

    if (expectedSizeBytes > MAX_FILE_SIZE_BYTES) {
      return res.status(400).json({
        success: false,
        code: 'FILE_TOO_LARGE',
        error: 'Declared file size exceeds the 15 MB limit.'
      });
    }

    const validation = validateIncomingUpload(expectedSizeBytes);
    if (!validation.allowed) {
      return res.status(403).json({
        success: false,
        code: validation.code,
        error: validation.error
      });
    }

    const ext = path.extname(filename);
    const uniqueKey = `brief-assets/${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;

    const presignedUrl = `/api/uploads`;
    const publicUrl = `/uploads/${path.basename(uniqueKey)}`;

    // Presigned request creation counts as 1 Class A metadata write
    recordOperation('class_a', 1);

    res.json({
      success: true,
      uploadUrl: presignedUrl,
      key: uniqueKey,
      publicUrl: publicUrl,
      maxSizeBytes: MAX_FILE_SIZE_BYTES,
      expiresInSeconds: 3600
    });
  } catch (error) {
    console.error('Error generating presigned upload URL:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/uploads/cleanup
 * Trigger automated or manual 30-day retention cleanup
 */
router.post('/cleanup', (req, res) => {
  try {
    const result = runRetentionCleanup();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
