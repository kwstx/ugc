const express = require('express');
const router = express.Router();
const db = require('../db');
const { calculateClipBundlePricing } = require('../services/libraryPricingEngine');

function getSessionId(req) {
  return req.query.sessionId || req.headers['x-session-id'] || req.body.sessionId || 'guest_session';
}

/**
 * GET /api/cart
 * Returns current cart items and dynamic bundle pricing calculation
 */
router.get('/', (req, res) => {
  try {
    const sessionId = getSessionId(req);
    const rows = db.prepare(`
      SELECT c.* 
      FROM cart_items i
      JOIN library_clips c ON i.clip_id = c.id
      WHERE i.session_id = ?
      ORDER BY i.created_at ASC
    `).all(sessionId);

    const clips = rows.map(r => ({
      id: r.id,
      title: r.title,
      creator: r.creator,
      handle: r.handle,
      category: r.category,
      price: r.price,
      duration: r.duration,
      thumbnail: r.thumbnail,
      videoUrl: r.video_url
    }));

    const pricing = calculateClipBundlePricing(clips);

    res.json({
      success: true,
      sessionId,
      items: clips,
      pricing
    });
  } catch (err) {
    console.error('Error fetching cart:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/cart/items
 * Add a clip to cart
 */
router.post('/items', (req, res) => {
  try {
    const { clipId } = req.body;
    const sessionId = getSessionId(req);

    if (!clipId) {
      return res.status(400).json({ success: false, error: 'clipId is required.' });
    }

    const clip = db.prepare('SELECT id FROM library_clips WHERE id = ?').get(clipId);
    if (!clip) {
      return res.status(404).json({ success: false, error: 'Clip not found.' });
    }

    // Check if already in cart
    const existing = db.prepare('SELECT id FROM cart_items WHERE session_id = ? AND clip_id = ?').get(sessionId, clipId);
    if (!existing) {
      const cartItemId = `cart_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      db.prepare('INSERT INTO cart_items (id, session_id, clip_id) VALUES (?, ?, ?)').run(cartItemId, sessionId, clipId);
    }

    // Return updated cart
    const rows = db.prepare(`
      SELECT c.* 
      FROM cart_items i
      JOIN library_clips c ON i.clip_id = c.id
      WHERE i.session_id = ?
    `).all(sessionId);

    const pricing = calculateClipBundlePricing(rows);

    res.json({
      success: true,
      message: 'Clip added to cart.',
      itemCount: rows.length,
      pricing
    });
  } catch (err) {
    console.error('Error adding to cart:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/cart/items/:clipId
 * Remove a clip from cart
 */
router.delete('/items/:clipId', (req, res) => {
  try {
    const { clipId } = req.params;
    const sessionId = getSessionId(req);

    db.prepare('DELETE FROM cart_items WHERE session_id = ? AND clip_id = ?').run(sessionId, clipId);

    const rows = db.prepare(`
      SELECT c.* 
      FROM cart_items i
      JOIN library_clips c ON i.clip_id = c.id
      WHERE i.session_id = ?
    `).all(sessionId);

    const pricing = calculateClipBundlePricing(rows);

    res.json({
      success: true,
      message: 'Clip removed from cart.',
      itemCount: rows.length,
      pricing
    });
  } catch (err) {
    console.error('Error removing from cart:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/cart/bundle-price
 * Quick calculation for an array of clip IDs
 */
router.post('/bundle-price', (req, res) => {
  try {
    const { clipIds = [] } = req.body;
    if (!Array.isArray(clipIds) || clipIds.length === 0) {
      return res.json({
        success: true,
        pricing: calculateClipBundlePricing([])
      });
    }

    const placeholders = clipIds.map(() => '?').join(',');
    const clips = db.prepare(`SELECT price FROM library_clips WHERE id IN (${placeholders})`).all(...clipIds);

    const pricing = calculateClipBundlePricing(clips);

    res.json({
      success: true,
      pricing
    });
  } catch (err) {
    console.error('Error calculating bundle price:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
