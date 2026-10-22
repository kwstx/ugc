const express = require('express');
const router = express.Router();
const db = require('../db');
const { calculateClipBundlePricing } = require('../services/libraryPricingEngine');
const { analyzeQueryIntent, scoreClip } = require('../services/linkMatcher');
const { getR2PresignedUploadUrl, isR2Configured } = require('../services/r2Client');

// Helper to format tags from JSON
function parseClip(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    creator: row.creator,
    handle: row.handle,
    category: row.category,
    emotion: row.emotion,
    tags: row.tags ? JSON.parse(row.tags) : [],
    duration: row.duration,
    price: row.price,
    thumbnail: row.thumbnail,
    videoUrl: row.video_url,
    previewUrl: row.preview_url,
    rating: row.rating,
    viewsCount: row.views_count,
    createdAt: row.created_at
  };
}

/**
 * GET /api/library/clips
 * Returns paginated clips with category, tag, creator, and sorting filters
 */
router.get('/clips', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const offset = (page - 1) * limit;

    const { category, emotion, creator, sort = 'popular' } = req.query;

    let whereClauses = [];
    let params = [];

    if (category && category !== 'All clips') {
      whereClauses.push('category = ?');
      params.push(category);
    }

    if (emotion) {
      whereClauses.push('emotion = ?');
      params.push(emotion);
    }

    if (creator) {
      whereClauses.push('(creator LIKE ? OR handle LIKE ?)');
      params.push(`%${creator}%`, `%${creator}%`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Sorting
    let orderSql = 'ORDER BY views_count DESC';
    if (sort === 'newest') orderSql = 'ORDER BY created_at DESC';
    else if (sort === 'price_asc') orderSql = 'ORDER BY price ASC';
    else if (sort === 'price_desc') orderSql = 'ORDER BY price DESC';
    else if (sort === 'duration') orderSql = 'ORDER BY duration ASC';

    // Count query
    const countSql = `SELECT COUNT(*) as total FROM library_clips ${whereSql}`;
    const totalCount = db.prepare(countSql).get(...params).total;

    // Fetch clips
    const listSql = `SELECT * FROM library_clips ${whereSql} ${orderSql} LIMIT ? OFFSET ?`;
    const rows = db.prepare(listSql).all(...params, limit, offset);

    // Fetch active categories with counts
    const categories = db.prepare(`
      SELECT category as name, COUNT(*) as count 
      FROM library_clips 
      GROUP BY category 
      ORDER BY count DESC
    `).all();

    res.json({
      success: true,
      clips: rows.map(parseClip),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit)
      },
      categories
    });
  } catch (err) {
    console.error('Error fetching clips:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/library/clips
 * Upload a creator clip into the public library from Creator Portal
 */
router.post('/clips', (req, res) => {
  try {
    const {
      title,
      creator,
      handle,
      category = 'All clips',
      emotion = 'Reaction',
      tags = [],
      duration = '0:05',
      price = 15.00,
      thumbnail,
      videoUrl,
      previewUrl
    } = req.body;

    if (!title || !creator) {
      return res.status(400).json({ success: false, error: 'Title and creator name are required.' });
    }

    const clipId = 'lib_clip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const parsedTags = Array.isArray(tags) ? JSON.stringify(tags) : JSON.stringify([tags]);

    db.prepare(`
      INSERT INTO library_clips (
        id, title, creator, handle, category, emotion, tags, duration, price,
        thumbnail, video_url, preview_url, rating, views_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '5.0 (New)', 0, CURRENT_TIMESTAMP)
    `).run(
      clipId,
      title,
      creator,
      handle || ('@' + creator.toLowerCase().replace(/\s+/g, '_')),
      category,
      emotion,
      parsedTags,
      duration,
      parseFloat(price) || 15.00,
      thumbnail || 'assets/order/thumb_shocked.png',
      videoUrl || '',
      previewUrl || videoUrl || ''
    );

    const newClip = db.prepare('SELECT * FROM library_clips WHERE id = ?').get(clipId);

    res.json({
      success: true,
      message: 'Clip published to library successfully!',
      clip: parseClip(newClip)
    });
  } catch (err) {
    console.error('Error adding clip to library:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/library/search
 * Intelligent search & Social Link Matcher (Instagram / TikTok hook parsing)
 */
router.get('/search', (req, res) => {
  try {
    const query = req.query.q || '';
    const socialIntent = analyzeQueryIntent(query);

    const allRows = db.prepare('SELECT * FROM library_clips').all();
    const clips = allRows.map(parseClip);

    const scored = clips.map(clip => ({
      clip,
      score: scoreClip(clip, query, socialIntent)
    }));

    // Filter out zero-score items unless query is blank
    const filtered = query.trim() ? scored.filter(s => s.score > 0) : scored;
    filtered.sort((a, b) => b.score - a.score);

    res.json({
      success: true,
      query,
      socialIntent,
      matchedCount: filtered.length,
      clips: filtered.map(f => f.clip)
    });
  } catch (err) {
    console.error('Error in library search:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/library/clips/:id
 * Single clip details & view counter increment
 */
router.get('/clips/:id', (req, res) => {
  try {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM library_clips WHERE id = ?').get(id);

    if (!row) {
      return res.status(404).json({ success: false, error: 'Clip not found' });
    }

    // Increment view count
    db.prepare('UPDATE library_clips SET views_count = views_count + 1 WHERE id = ?').run(id);

    res.json({
      success: true,
      clip: parseClip(row)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/library/categories
 */
router.get('/categories', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT category as name, COUNT(*) as count 
      FROM library_clips 
      GROUP BY category 
      ORDER BY count DESC
    `).all();

    res.json({ success: true, categories: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/library/favorites
 */
router.get('/favorites', (req, res) => {
  try {
    const sessionId = req.query.sessionId || req.headers['x-session-id'] || 'guest_session';
    const rows = db.prepare(`
      SELECT c.* 
      FROM library_favorites f
      JOIN library_clips c ON f.clip_id = c.id
      WHERE f.session_id = ?
      ORDER BY f.created_at DESC
    `).all(sessionId);

    res.json({
      success: true,
      favorites: rows.map(parseClip)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/library/favorites
 * Toggle favorite clip
 */
router.post('/favorites', (req, res) => {
  try {
    const { clipId, sessionId = 'guest_session' } = req.body;
    if (!clipId) return res.status(400).json({ success: false, error: 'clipId is required' });

    const existing = db.prepare('SELECT id FROM library_favorites WHERE session_id = ? AND clip_id = ?').get(sessionId, clipId);

    if (existing) {
      db.prepare('DELETE FROM library_favorites WHERE id = ?').run(existing.id);
      return res.json({ success: true, favorited: false, message: 'Removed from favorites' });
    } else {
      const favId = `fav_${Date.now()}`;
      db.prepare('INSERT INTO library_favorites (id, session_id, clip_id) VALUES (?, ?, ?)').run(favId, sessionId, clipId);
      return res.json({ success: true, favorited: true, message: 'Added to favorites' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/library/clips/:id/download
 * Commercial high-resolution download link delivery
 */
router.get('/clips/:id/download', (req, res) => {
  try {
    const { id } = req.params;
    const clip = db.prepare('SELECT * FROM library_clips WHERE id = ?').get(id);

    if (!clip) {
      return res.status(404).json({ success: false, error: 'Clip not found' });
    }

    const publicUrl = clip.video_url || clip.preview_url;
    res.json({
      success: true,
      clipId: id,
      title: clip.title,
      downloadUrl: publicUrl,
      commercialLicense: 'Standard Commercial Ads License (Unlimited Impressions, No Expiry)',
      format: '1080x1920 9:16 Vertical MP4 (Unedited Native Footage)'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/library/checkout
 * Checkout and Instant Licensing (supports credit wallet deduction at 11 credits/clip or card checkout)
 */
router.post('/checkout', (req, res) => {
  try {
    const { clipIds = [], sessionId = 'guest_session', email = 'customer@example.com', paymentMethod = 'card' } = req.body;

    if (!Array.isArray(clipIds) || clipIds.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one clip must be selected for checkout.' });
    }

    const placeholders = clipIds.map(() => '?').join(',');
    const clips = db.prepare(`SELECT * FROM library_clips WHERE id IN (${placeholders})`).all(...clipIds);

    if (clips.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid clips found for checkout.' });
    }

    const pricing = calculateClipBundlePricing(clips);
    const orderId = 'LIB-' + Math.floor(100000 + Math.random() * 900000);
    const licenseKey = 'LIC-UGC-' + Math.random().toString(36).substring(2, 10).toUpperCase();

    let creditTransaction = null;
    if (paymentMethod === 'credits') {
      const { consumeCredits } = require('../services/billingService');
      const creditsRequired = clips.length * 11; // 11 credits per library clip
      creditTransaction = consumeCredits(
        sessionId,
        creditsRequired,
        'clip_purchase',
        orderId,
        `Purchased ${clips.length} library clip(s) (${orderId})`
      );
    }

    const itemsSummary = clips.map(c => ({
      id: c.id,
      title: c.title,
      creator: c.creator,
      downloadUrl: c.video_url
    }));

    db.prepare(`
      INSERT INTO library_orders (id, session_id, items, subtotal, discount, total, license_key, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')
    `).run(
      orderId,
      sessionId,
      JSON.stringify(itemsSummary),
      pricing.subtotal,
      pricing.discountAmount,
      pricing.total,
      licenseKey
    );

    // Clear cart items for this session
    db.prepare('DELETE FROM cart_items WHERE session_id = ?').run(sessionId);

    res.json({
      success: true,
      message: 'Checkout completed successfully. Commercial license issued.',
      orderId,
      licenseKey,
      email,
      paymentMethod,
      creditTransaction: creditTransaction ? {
        debitedCredits: Math.abs(creditTransaction.ledgerEntry.amount),
        remainingBalance: creditTransaction.wallet.balance,
        ledgerEntryId: creditTransaction.ledgerEntry.id
      } : null,
      pricing,
      items: itemsSummary,
      commercialUsageGrant: 'Full perpetual commercial rights for paid ads across Meta, TikTok, YouTube, and Google.'
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_CREDITS',
        error: err.message,
        availableCredits: err.available,
        requiredCredits: err.required
      });
    }
    console.error('Library checkout error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
