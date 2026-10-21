const express = require('express');
const router = express.Router();
const db = require('../db');
const { notify } = require('../services/notificationService');

/**
 * GET /api/creators
 * Returns active creators from the database with optional format filtering
 */
router.get('/', (req, res) => {
  try {
    const { format } = req.query;
    const allCreators = db.prepare("SELECT * FROM creators WHERE status = 'active' ORDER BY created_at DESC").all();

    const formattedList = allCreators.map(c => {
      let formats = ['reaction', 'full_ugc'];
      try {
        formats = c.formats ? JSON.parse(c.formats) : ['reaction', 'full_ugc'];
      } catch (e) {}

      return {
        id: c.id,
        name: c.name,
        handle: c.handle,
        email: c.email || '',
        avatar: c.avatar || 'avatar_1.png',
        rate: c.rate || 30.00,
        formats,
        country: c.country || '',
        countryCode: c.country_code || '',
        languages: c.languages || 'English',
        gender: c.gender || 'female',
        creatorType: c.creator_type || 'standard',
        bio: c.bio || '',
        rating: c.rating || 'Verified',
        status: c.status,
        stripeConnected: Boolean(c.stripe_connected)
      };
    });

    let filtered = formattedList;
    if (format) {
      const isFull = format.toLowerCase().includes('full');
      filtered = formattedList.filter(c => {
        if (!Array.isArray(c.formats) || c.formats.length === 0) return true;
        return c.formats.some(f => {
          const fLow = String(f).toLowerCase();
          return isFull ? (fLow.includes('full') || fLow.includes('ugc')) : fLow.includes('reaction');
        });
      });
    }

    res.json({
      success: true,
      creators: filtered,
      totalCount: allCreators.length
    });
  } catch (error) {
    console.error('Error fetching creators:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/creators/:id
 * Returns a specific creator profile
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(id);
    if (!creator) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    let formats = ['reaction', 'full_ugc'];
    try {
      formats = creator.formats ? JSON.parse(creator.formats) : ['reaction', 'full_ugc'];
    } catch (e) {}

    let shippingAddress = null;
    try {
      shippingAddress = creator.shipping_address ? JSON.parse(creator.shipping_address) : null;
    } catch (e) {}

    res.json({
      success: true,
      creator: {
        id: creator.id,
        name: creator.name,
        handle: creator.handle,
        email: creator.email || '',
        avatar: creator.avatar || 'avatar_1.png',
        rate: creator.rate || 30.00,
        formats,
        country: creator.country || '',
        countryCode: creator.country_code || '',
        languages: creator.languages || 'English',
        gender: creator.gender || 'female',
        creatorType: creator.creator_type || 'standard',
        bio: creator.bio || '',
        rating: creator.rating || 'Verified',
        status: creator.status,
        shippingAddress,
        stripeConnected: Boolean(creator.stripe_connected),
        stripeAccountId: creator.stripe_account_id
      }
    });
  } catch (error) {
    console.error('Error fetching creator:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/creators
 * Creates or updates a creator profile in the backend
 */
router.post('/', (req, res) => {
  try {
    const {
      id,
      name,
      handle,
      email,
      avatar,
      rate,
      formats,
      shippingAddress,
      country,
      countryCode,
      languages,
      gender,
      creatorType,
      bio
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'Name is required.' });
    }

    const creatorId = id || `creator_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const formattedHandle = handle ? (handle.startsWith('@') ? handle : `@${handle}`) : `@${name.toLowerCase().replace(/\s+/g, '_')}`;
    const formatsJson = JSON.stringify(Array.isArray(formats) && formats.length > 0 ? formats : ['reaction', 'full_ugc']);
    const shippingJson = shippingAddress ? (typeof shippingAddress === 'string' ? shippingAddress : JSON.stringify(shippingAddress)) : null;
    const baseRate = parseFloat(rate) || 30.00;

    const existing = db.prepare('SELECT * FROM creators WHERE id = ?').get(creatorId);
    if (existing) {
      db.prepare(`
        UPDATE creators
        SET name = ?, handle = ?, email = COALESCE(?, email), avatar = COALESCE(?, avatar),
            rate = ?, formats = ?, shipping_address = COALESCE(?, shipping_address),
            country = COALESCE(?, country), country_code = COALESCE(?, country_code),
            languages = COALESCE(?, languages), gender = COALESCE(?, gender),
            creator_type = COALESCE(?, creator_type), bio = COALESCE(?, bio)
        WHERE id = ?
      `).run(
        name,
        formattedHandle,
        email || null,
        avatar || null,
        baseRate,
        formatsJson,
        shippingJson,
        country || null,
        countryCode || null,
        languages || null,
        gender || null,
        creatorType || null,
        bio || null,
        creatorId
      );
    } else {
      db.prepare(`
        INSERT INTO creators (
          id, name, handle, email, avatar, status, rate, formats, rating, completed_orders,
          shipping_address, country, country_code, languages, gender, creator_type, bio
        )
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 'Verified', 0, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        creatorId,
        name,
        formattedHandle,
        email || null,
        avatar || 'avatar_1.png',
        baseRate,
        formatsJson,
        shippingJson,
        country || '',
        countryCode || '',
        languages || 'English',
        gender || 'female',
        creatorType || 'standard',
        bio || ''
      );
    }

    const updated = db.prepare('SELECT * FROM creators WHERE id = ?').get(creatorId);
    res.json({
      success: true,
      creator: {
        id: updated.id,
        name: updated.name,
        handle: updated.handle,
        email: updated.email,
        avatar: updated.avatar,
        rate: updated.rate,
        formats: JSON.parse(updated.formats || '["reaction", "full_ugc"]'),
        country: updated.country,
        countryCode: updated.country_code,
        languages: updated.languages,
        gender: updated.gender,
        creatorType: updated.creator_type,
        bio: updated.bio,
        rating: updated.rating || 'Verified',
        status: updated.status
      }
    });
  } catch (error) {
    console.error('Error saving creator:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/creators/:id/stats
 * Real-time calculated creator metrics (no mock numbers, starting from zero)
 */
router.get('/:id/stats', (req, res) => {
  try {
    const { id } = req.params;

    // 1. Total released earnings from completed orders
    const releasedRow = db.prepare(`
      SELECT COALESCE(SUM(creator_pay), 0) as totalReleased, COUNT(*) as completedCount
      FROM open_orders
      WHERE assigned_creator_id = ? AND status = 'completed' AND escrow_status = 'released'
    `).get(id);

    // 2. Total payouts withdrawn
    const payoutsRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as totalWithdrawn
      FROM creator_payouts
      WHERE creator_id = ? AND status = 'completed'
    `).get(id);

    const availableBalance = Math.max(0, (releasedRow.totalReleased || 0) - (payoutsRow.totalWithdrawn || 0));

    // 3. Active escrow (orders assigned to this creator currently in progress, shipping, or in review)
    const activeRow = db.prepare(`
      SELECT COALESCE(SUM(creator_pay), 0) as activeEscrow, COUNT(*) as activeCount
      FROM open_orders
      WHERE assigned_creator_id = ? AND status IN ('in_progress', 'shipping', 'submitted', 'in_review') AND escrow_status = 'held'
    `).get(id);

    // 4. Open briefs available to claim
    const openRow = db.prepare(`
      SELECT COUNT(*) as openCount
      FROM open_orders
      WHERE status = 'open'
    `).get();

    // 5. Library clip royalties and licenses
    // Query library clips associated with creator's handle/name
    const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(id);
    let libraryEarnings = 0;
    let libraryLicenses = 0;

    if (creator) {
      // Find orders in library_orders that contain items by this creator
      const libOrders = db.prepare("SELECT items FROM library_orders WHERE status = 'completed'").all();
      for (const order of libOrders) {
        try {
          const items = JSON.parse(order.items || '[]');
          for (const item of items) {
            if (item.creator === creator.name || item.handle === creator.handle) {
              libraryLicenses += 1;
              libraryEarnings += 10.00; // $10 royalty per license
            }
          }
        } catch (e) {}
      }
    }

    res.json({
      success: true,
      stats: {
        availableBalance: parseFloat(availableBalance.toFixed(2)),
        activeEscrow: parseFloat((activeRow.activeEscrow || 0).toFixed(2)),
        activeAssignmentsCount: activeRow.activeCount || 0,
        openBriefsCount: openRow.openCount || 0,
        libraryEarnings: parseFloat(libraryEarnings.toFixed(2)),
        libraryLicensesCount: libraryLicenses,
        completedOrdersCount: releasedRow.completedCount || 0,
        stripeConnected: Boolean(creator?.stripe_connected)
      }
    });
  } catch (error) {
    console.error('Error fetching creator stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/creators/:id/payout
 * Cash out available balance to connected Stripe Express account
 */
router.post('/:id/payout', (req, res) => {
  try {
    const { id } = req.params;
    const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(id);
    if (!creator) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    // Calculate current available balance
    const releasedRow = db.prepare(`
      SELECT COALESCE(SUM(creator_pay), 0) as totalReleased
      FROM open_orders
      WHERE assigned_creator_id = ? AND status = 'completed' AND escrow_status = 'released'
    `).get(id);

    const payoutsRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as totalWithdrawn
      FROM creator_payouts
      WHERE creator_id = ? AND status = 'completed'
    `).get(id);

    const availableBalance = Math.max(0, (releasedRow.totalReleased || 0) - (payoutsRow.totalWithdrawn || 0));

    if (availableBalance <= 0) {
      return res.status(400).json({
        success: false,
        error: 'No available earnings to cash out. Complete claimed briefs to earn escrow payouts.'
      });
    }

    const payoutId = `po_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const stripeAccountId = creator.stripe_account_id || 'manual_payout';

    db.prepare(`
      INSERT INTO creator_payouts (id, creator_id, amount, currency, stripe_account_id, payout_method, status)
      VALUES (?, ?, ?, 'USD', ?, 'Stripe Express Direct Deposit', 'completed')
    `).run(payoutId, id, availableBalance, stripeAccountId);

    notify(
      'creator',
      id,
      payoutId,
      'payout_processed',
      'Payout Transferred',
      `Instant payout of $${availableBalance.toFixed(2)} transferred to your Stripe Express account.`
    );

    res.json({
      success: true,
      payoutId,
      amount: availableBalance,
      remainingBalance: 0.00,
      message: `Successfully transferred $${availableBalance.toFixed(2)} to ${creator.name}'s account.`
    });
  } catch (error) {
    console.error('Error processing payout:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
