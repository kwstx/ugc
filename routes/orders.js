const express = require('express');
const router = express.Router();
const db = require('../db');
const { calculatePricing } = require('../services/pricingEngine');
const { checkCreatorsAvailability } = require('../services/creatorService');

function generateOrderId() {
  return 'ORD-' + Math.floor(100000 + Math.random() * 900000);
}

/**
 * POST /api/orders/create
 * Creates and finalizes an order directly from the brief
 */
router.post('/create', (req, res) => {
  try {
    const {
      briefId,
      sessionId,
      brandName,
      qty,
      selectedCreators = [],
      concepts = []
    } = req.body;

    if (!brandName) {
      return res.status(400).json({ success: false, error: 'Brand name is required to create an order.' });
    }

    const orderId = generateOrderId();
    const pricing = calculatePricing(qty || 6, selectedCreators.length || 2);
    const creatorStatus = checkCreatorsAvailability(selectedCreators);

    const insertOrder = db.prepare(`
      INSERT INTO orders (
        id, brief_id, session_id, status, brand_name,
        qty, rate, total, per_creator, selected_creators, concepts
      ) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)
    `);

    insertOrder.run(
      orderId,
      briefId || null,
      sessionId || 'guest_session',
      brandName.trim(),
      pricing.quantity,
      pricing.rate,
      pricing.total,
      pricing.perCreator,
      JSON.stringify(creatorStatus.creators),
      JSON.stringify(concepts)
    );

    // If briefId was provided, update brief status to 'ordered'
    if (briefId) {
      db.prepare("UPDATE briefs SET status = 'ordered', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(briefId);
    }

    res.json({
      success: true,
      orderId,
      status: 'confirmed',
      pricing,
      creators: creatorStatus.creators,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/:id
 * Retrieve order details
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    res.json({
      success: true,
      order: {
        id: order.id,
        briefId: order.brief_id,
        status: order.status,
        brandName: order.brand_name,
        qty: order.qty,
        rate: order.rate,
        total: order.total,
        perCreator: order.per_creator,
        selectedCreators: order.selected_creators ? JSON.parse(order.selected_creators) : [],
        concepts: order.concepts ? JSON.parse(order.concepts) : [],
        createdAt: order.created_at
      }
    });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
