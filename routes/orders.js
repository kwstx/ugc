const express = require('express');
const router = express.Router();
const db = require('../db');
const { calculatePricing } = require('../services/pricingEngine');
const { checkCreatorsAvailability } = require('../services/creatorService');
const { analyzeAndValidateOrder, verifyDeliverableQuality } = require('../services/formatAnalyzer');
const { createEscrowHold, releaseEscrow, refundEscrow } = require('../services/escrowService');
const { getMatchingCreators, claimOpenOrder } = require('../services/creatorEngine');
const { updateShippingInfo, getCreatorShippingAddress } = require('../services/logisticsService');
const { notify, getNotifications, markAsRead } = require('../services/notificationService');
const { resolveSession, getBrandAccountSummary } = require('../services/authService');
const {
  getOrCreateDraftOrder,
  updateDraftOrder,
  getReactionBriefViewData,
  submitAndLockReactionBrief,
  parseDraftOrder
} = require('../services/draftOrderService');

function generateOrderId() {
  return 'ORD-' + Math.floor(100000 + Math.random() * 900000);
}

/**
 * POST /api/orders/open
 * Accepts, analyzes format, validates prerequisites, and creates an open marketplace order with escrow
 */
router.post('/open', (req, res) => {
  try {
    const session = resolveSession(req);
    const analysis = analyzeAndValidateOrder(req.body);

    if (!analysis.valid) {
      return res.status(400).json({
        success: false,
        error: 'Order validation failed.',
        validationErrors: analysis.errors
      });
    }

    const orderId = req.body.id || generateOrderId();
    const sessionId = session.id;

    // Check active subscription entitlements for custom_order_discount_pct (5% Growth, 10% Scale)
    const { getUserBillingState, consumeCredits } = require('../services/billingService');
    const billingState = getUserBillingState(sessionId);
    const customDiscountPct = billingState.entitlements?.customOrderDiscountPct || 0;

    let finalTotal = analysis.total;
    if (customDiscountPct > 0) {
      finalTotal = parseFloat((analysis.total * (1 - customDiscountPct / 100)).toFixed(2));
    }

    // If paying with subscription credits, atomically reserve & deduct from credit_wallets & credit_ledger
    let creditTransaction = null;
    if (req.body.paymentMethod === 'credits') {
      const creditCost = Math.max(1, Math.round(finalTotal));
      creditTransaction = consumeCredits(
        sessionId,
        creditCost,
        'custom_order',
        orderId,
        `Custom order "${analysis.title}" (${orderId})${customDiscountPct > 0 ? ` with ${customDiscountPct}% ${billingState.entitlements.name} discount` : ''}`
      );
    }

    // Calculate due date if reaction (starts immediately)
    let dueAt = null;
    let initialStatus = 'open';
    let shippingStatus = analysis.requiresShipping ? 'pending_shipment' : 'not_required';

    if (analysis.formatType === 'reaction') {
      const dueDate = new Date();
      dueDate.setHours(dueDate.getHours() + analysis.turnaroundHours);
      dueAt = dueDate.toISOString();
    }

    // Insert order into open_orders table
    const insertStmt = db.prepare(`
      INSERT INTO open_orders (
        id, session_id, brand_name, title, format_type,
        format_link, source_media_url, layout_instruction, details,
        script, requires_shipping, shipping_product_name, shipping_status,
        creator_pay, platform_fee, total, escrow_status,
        status, turnaround_hours, due_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    insertStmt.run(
      orderId,
      sessionId,
      analysis.brandName,
      analysis.title,
      analysis.formatType,
      analysis.formatLink,
      analysis.sourceMediaUrl,
      analysis.layoutInstruction,
      analysis.details,
      analysis.script,
      analysis.requiresShipping ? 1 : 0,
      analysis.shippingProductName,
      shippingStatus,
      analysis.creatorPay,
      analysis.platformFee,
      finalTotal,
      initialStatus,
      analysis.turnaroundHours,
      dueAt
    );

    // Initialize escrow hold upfront
    const escrow = createEscrowHold(orderId, finalTotal, analysis.brandName, req.body.paymentMethod || 'card');

    // Notify matching creators about new open brief
    const recommendedCreators = getMatchingCreators(analysis.formatType);
    for (const creator of recommendedCreators.slice(0, 3)) {
      notify(
        'creator',
        creator.id,
        orderId,
        'order_published',
        `New ${analysis.formatLabel} Brief Available!`,
        `"${analysis.title}" by ${analysis.brandName} is open for claiming ($${analysis.creatorPay.toFixed(2)} payout).`
      );
    }

    // Notify brand of successful publishing & escrow lock
    notify(
      'brand',
      sessionId,
      orderId,
      'order_published',
      'Open Order Published & Escrow Held',
      `Your ${analysis.formatLabel} brief is live. Escrow of $${finalTotal.toFixed(2)} is secured and will be released only upon video approval.`
    );

    res.json({
      success: true,
      orderId,
      sessionId,
      status: initialStatus,
      formatAnalysis: {
        formatType: analysis.formatType,
        formatLabel: analysis.formatLabel,
        layoutInstruction: analysis.layoutInstruction,
        requiresShipping: analysis.requiresShipping,
        shippingStatus,
        turnaroundHours: analysis.turnaroundHours,
        slaDescription: analysis.slaDescription,
        dueAt
      },
      pricing: {
        creatorPay: analysis.creatorPay,
        platformFee: analysis.platformFee,
        subtotal: analysis.total,
        customOrderDiscountPct: customDiscountPct,
        total: finalTotal
      },
      creditTransaction: creditTransaction ? {
        debitedCredits: Math.abs(creditTransaction.ledgerEntry.amount),
        remainingBalance: creditTransaction.wallet.balance,
        ledgerEntryId: creditTransaction.ledgerEntry.id
      } : null,
      escrow: {
        status: escrow.escrowStatus,
        paymentIntentId: escrow.paymentIntentId,
        guarantee: escrow.escrowGuarantee
      },
      recommendedCreators: recommendedCreators.slice(0, 4),
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    if (error.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_CREDITS',
        error: error.message,
        availableCredits: error.available,
        requiredCredits: error.required
      });
    }
    console.error('Error creating open order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/open
 * Retrieves open marketplace orders with optional filtering by format and status
 */
router.get('/open', (req, res) => {
  try {
    const { formatType, status, sessionId } = req.query;
    let query = 'SELECT * FROM open_orders WHERE 1=1';
    const params = [];

    if (formatType) {
      const norm = formatType.toLowerCase().includes('full') ? 'full_ugc' : 'reaction';
      query += ' AND format_type = ?';
      params.push(norm);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (sessionId) {
      query += ' AND session_id = ?';
      params.push(sessionId);
    }

    query += ' ORDER BY created_at DESC LIMIT 50';
    const orders = db.prepare(query).all(...params);

    res.json({
      success: true,
      count: orders.length,
      orders: orders.map(o => ({
        id: o.id,
        sessionId: o.session_id,
        brandName: o.brand_name,
        title: o.title,
        formatType: o.format_type,
        formatLink: o.format_link,
        layoutInstruction: o.layout_instruction,
        requiresShipping: Boolean(o.requires_shipping),
        shippingStatus: o.shipping_status,
        creatorPay: o.creator_pay,
        platformFee: o.platform_fee,
        total: o.total,
        escrowStatus: o.escrow_status,
        status: o.status,
        assignedCreatorId: o.assigned_creator_id,
        assignedCreatorName: o.assigned_creator_name,
        turnaroundHours: o.turnaround_hours,
        dueAt: o.due_at,
        createdAt: o.created_at
      }))
    });
  } catch (error) {
    console.error('Error fetching open orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/account/summary
 * Brand authentication & order history dashboard summary
 */
router.get('/account/summary', (req, res) => {
  try {
    const session = resolveSession(req);
    const summary = getBrandAccountSummary(session.id);
    res.json({
      success: true,
      account: summary
    });
  } catch (error) {
    console.error('Error fetching account summary:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/orders/:id/claim
 * Creator claims an open order (checks format eligibility and applicant cap)
 */
router.post('/:id/claim', (req, res) => {
  try {
    const { id } = req.params;
    const { creatorId, pitch } = req.body;

    if (!creatorId) {
      return res.status(400).json({ success: false, error: 'creatorId is required to claim an order.' });
    }

    const claimResult = claimOpenOrder(id, creatorId, pitch);
    res.json({
      success: true,
      ...claimResult
    });
  } catch (error) {
    console.error('Error claiming order:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/orders/:id/shipping
 * Brand updates physical shipping details for Full UGC orders
 */
router.put('/:id/shipping', (req, res) => {
  try {
    const { id } = req.params;
    const result = updateShippingInfo(id, req.body);
    res.json({
      success: true,
      shipping: result
    });
  } catch (error) {
    console.error('Error updating shipping:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/orders/:id/deliverable
 * Creator submits finished video deliverable with automated format-tailored quality check
 */
router.post('/:id/deliverable', (req, res) => {
  try {
    const { id } = req.params;
    const { creatorId, videoUrl, notes, previewThumbnail } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, error: 'videoUrl is required for deliverable submission.' });
    }

    const order = db.prepare('SELECT * FROM open_orders WHERE id = ?').get(id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    // Run format-tailored deliverable quality verification
    const verificationReport = verifyDeliverableQuality(order.format_type, { videoUrl, notes });

    const deliverableId = 'deliv_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const insertDeliverable = db.prepare(`
      INSERT INTO order_deliverables (
        id, order_id, creator_id, video_url, preview_thumbnail,
        notes, format_type, verification_report, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', CURRENT_TIMESTAMP)
    `);

    insertDeliverable.run(
      deliverableId,
      id,
      creatorId || order.assigned_creator_id || 'creator_unknown',
      videoUrl,
      previewThumbnail || null,
      notes || null,
      order.format_type,
      JSON.stringify(verificationReport)
    );

    // Update order status to 'in_review'
    db.prepare("UPDATE open_orders SET status = 'in_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

    // Notify brand
    notify(
      'brand',
      order.session_id || 'brand_client',
      id,
      'deliverable_submitted',
      'Creator Submitted Video Deliverable! 🎬',
      `A new video submission for "${order.title}" is ready for your review. Quality Score: ${verificationReport.score}/100.`
    );

    res.json({
      success: true,
      deliverableId,
      orderId: id,
      orderStatus: 'in_review',
      verificationReport,
      submittedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error submitting deliverable:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/orders/:id/review-submission
 * Brand approves deliverable (triggers escrow release to creator) or requests revision
 */
router.post('/:id/review-submission', (req, res) => {
  try {
    const { id } = req.params;
    const { action, feedback } = req.body; // 'approve' or 'request_revision'

    const order = db.prepare('SELECT * FROM open_orders WHERE id = ?').get(id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    if (action === 'approve') {
      // Release escrow funds to creator
      const escrowRelease = releaseEscrow(id, order.assigned_creator_id, order.session_id);

      // Update latest deliverable status to 'approved'
      db.prepare(`
        UPDATE order_deliverables 
        SET status = 'approved', brand_feedback = ?, reviewed_at = CURRENT_TIMESTAMP 
        WHERE order_id = ? AND status = 'submitted'
      `).run(feedback || 'Approved by brand client', id);

      return res.json({
        success: true,
        action: 'approved',
        orderId: id,
        orderStatus: 'completed',
        escrowRelease,
        message: 'Video deliverable approved and escrow payment released to creator.'
      });

    } else if (action === 'request_revision') {
      db.prepare(`
        UPDATE order_deliverables 
        SET status = 'revision_requested', brand_feedback = ?, reviewed_at = CURRENT_TIMESTAMP 
        WHERE order_id = ? AND status = 'submitted'
      `).run(feedback || 'Revision requested', id);

      // Revert order status to 'in_progress'
      db.prepare("UPDATE open_orders SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

      // Notify creator
      if (order.assigned_creator_id) {
        notify(
          'creator',
          order.assigned_creator_id,
          id,
          'revision_requested',
          'Revision Requested for Brief',
          `The brand requested revisions for "${order.title}": "${feedback || 'Please adjust the hook and delivery.'}"`
        );
      }

      return res.json({
        success: true,
        action: 'revision_requested',
        orderId: id,
        orderStatus: 'in_progress',
        feedback,
        message: 'Revision request sent to creator.'
      });
    } else {
      return res.status(400).json({ success: false, error: "Invalid action. Must be 'approve' or 'request_revision'." });
    }
  } catch (error) {
    console.error('Error reviewing submission:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/:id/matching-creators
 * Returns recommended creators for this order's format
 */
router.get('/:id/matching-creators', (req, res) => {
  try {
    const { id } = req.params;
    const order = db.prepare('SELECT * FROM open_orders WHERE id = ?').get(id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    const creators = getMatchingCreators(order.format_type);
    res.json({
      success: true,
      orderId: id,
      formatType: order.format_type,
      creators
    });
  } catch (error) {
    console.error('Error fetching matching creators:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/orders/payment-webhook
 * Simulates Stripe payment gateway webhook for escrow authorization / payout confirmations
 */
router.post('/payment-webhook', (req, res) => {
  try {
    const { eventType, paymentIntentId, orderId } = req.body;
    console.log(`[Stripe Webhook Received] Event: ${eventType}, Intent: ${paymentIntentId}, Order: ${orderId}`);

    res.json({
      received: true,
      eventType: eventType || 'payment_intent.succeeded',
      processedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/orders/create
 * Legacy endpoint: Creates and finalizes an order directly from the brief
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
 * POST /api/orders/format
 * Save format choice ('Reaction Video' / 'Full UGC') to backend
 */
router.post('/format', (req, res) => {
  try {
    const session = resolveSession(req);
    const { format, formatKey } = req.body;

    const isFull = (formatKey === 'full' || format === 'Full UGC' || format === 'full_ugc');
    const formatChoice = isFull ? 'Full UGC' : 'Reaction Video';
    const key = isFull ? 'full' : 'reaction';
    const rate = isFull ? 100.00 : 25.00;

    const upsertStmt = db.prepare(`
      INSERT INTO order_format_state (session_id, format_choice, format_key, rate, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        format_choice = excluded.format_choice,
        format_key = excluded.format_key,
        rate = excluded.rate,
        updated_at = CURRENT_TIMESTAMP
    `);

    // Save for current session
    upsertStmt.run(session.id, formatChoice, key, rate);
    // Also save for default session for shared access
    upsertStmt.run('default_session', formatChoice, key, rate);

    res.json({
      success: true,
      format: formatChoice,
      formatKey: key,
      rate
    });
  } catch (error) {
    console.error('Error saving order format:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/format
 * Retrieve active format choice and rate from backend
 */
router.get('/format', (req, res) => {
  try {
    const session = resolveSession(req);
    let row = db.prepare('SELECT format_choice, format_key, rate FROM order_format_state WHERE session_id = ?').get(session.id);
    if (!row) {
      row = db.prepare('SELECT format_choice, format_key, rate FROM order_format_state WHERE session_id = ?').get('default_session');
    }

    if (row) {
      const minVideos = row.format_key === 'full' ? 1 : 5;
      return res.json({
        success: true,
        format: row.format_choice,
        formatKey: row.format_key,
        minVideos,
        rate: row.rate
      });
    }

    res.json({
      success: true,
      format: 'Reaction Video',
      formatKey: 'reaction',
      minVideos: 5,
      rate: 25.00
    });
  } catch (error) {
    console.error('Error getting order format:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/orders/session
 * Reliably sync format, selected creators, enforce minimum order rules (5 videos min for reaction),
 * and calculate pricing tiers on the server.
 */
router.post('/session', (req, res) => {
  try {
    const session = resolveSession(req);
    const {
      format = 'Reaction Video',
      formatKey = 'reaction',
      selectedCreators = [],
      qty = 6
    } = req.body;

    const isFull = (formatKey === 'full' || format === 'Full UGC' || format === 'full_ugc');
    const formatChoice = isFull ? 'Full UGC' : 'Reaction Video';
    const key = isFull ? 'full' : 'reaction';
    const minVideos = isFull ? 1 : 5;

    const creatorsList = Array.isArray(selectedCreators) ? selectedCreators : [];
    const creatorCount = Math.max(1, creatorsList.length);
    const requestedQty = parseInt(qty, 10);
    const effectiveQty = Math.max(minVideos, isNaN(requestedQty) ? 6 : requestedQty);

    const pricing = calculatePricing(effectiveQty, creatorCount, formatChoice);

    const upsertSessionStmt = db.prepare(`
      INSERT INTO order_session_state (
        session_id, format_choice, format_key, selected_creators,
        qty, rate, min_videos, pricing_data, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        format_choice = excluded.format_choice,
        format_key = excluded.format_key,
        selected_creators = excluded.selected_creators,
        qty = excluded.qty,
        rate = excluded.rate,
        min_videos = excluded.min_videos,
        pricing_data = excluded.pricing_data,
        updated_at = CURRENT_TIMESTAMP
    `);

    const jsonCreators = JSON.stringify(creatorsList);
    const jsonPricing = JSON.stringify(pricing);

    upsertSessionStmt.run(session.id, formatChoice, key, jsonCreators, effectiveQty, pricing.rate, minVideos, jsonPricing);
    upsertSessionStmt.run('default_session', formatChoice, key, jsonCreators, effectiveQty, pricing.rate, minVideos, jsonPricing);

    // Keep order_format_state in sync as well
    const upsertFormatStmt = db.prepare(`
      INSERT INTO order_format_state (session_id, format_choice, format_key, rate, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        format_choice = excluded.format_choice,
        format_key = excluded.format_key,
        rate = excluded.rate,
        updated_at = CURRENT_TIMESTAMP
    `);
    upsertFormatStmt.run(session.id, formatChoice, key, pricing.rate);
    upsertFormatStmt.run('default_session', formatChoice, key, pricing.rate);

    res.json({
      success: true,
      sessionId: session.id,
      format: formatChoice,
      formatKey: key,
      selectedCreators: creatorsList,
      creatorCount,
      qty: effectiveQty,
      minVideos,
      rate: pricing.rate,
      pricing
    });
  } catch (error) {
    console.error('Error saving order session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/session
 * Retrieve active session state (format, selected creators, minimums, pricing)
 */
router.get('/session', (req, res) => {
  try {
    const session = resolveSession(req);
    let row = db.prepare('SELECT * FROM order_session_state WHERE session_id = ?').get(session.id);
    if (!row) {
      row = db.prepare('SELECT * FROM order_session_state WHERE session_id = ?').get('default_session');
    }

    if (row) {
      let selectedCreators = [];
      let pricing = null;
      try { selectedCreators = JSON.parse(row.selected_creators || '[]'); } catch (e) {}
      try { pricing = JSON.parse(row.pricing_data || 'null'); } catch (e) {}

      if (!pricing) {
        pricing = calculatePricing(row.qty, Math.max(1, selectedCreators.length), row.format_choice);
      }

      return res.json({
        success: true,
        sessionId: row.session_id,
        format: row.format_choice,
        formatKey: row.format_key,
        selectedCreators,
        creatorCount: selectedCreators.length || 2,
        qty: row.qty,
        minVideos: row.min_videos || (row.format_key === 'full' ? 1 : 5),
        rate: row.rate,
        pricing,
        updatedAt: row.updated_at
      });
    }

    // Default fallback
    const defaultPricing = calculatePricing(6, 2, 'Reaction Video');
    res.json({
      success: true,
      sessionId: session.id,
      format: 'Reaction Video',
      formatKey: 'reaction',
      selectedCreators: [],
      creatorCount: 2,
      qty: 6,
      minVideos: 5,
      rate: 25.00,
      pricing: defaultPricing
    });
  } catch (error) {
    console.error('Error getting order session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/orders/draft
 * 1. Unified Draft Order State: Persists selections from creators and order pages
 */
router.post('/draft', (req, res) => {
  try {
    const session = resolveSession(req);
    const {
      orderId,
      format,
      creatorIds,
      selectedCreators,
      qty,
      turnaroundHours,
      layoutPreference,
      sourceAssetUrl,
      timestampsCallouts,
      reactionStyleGuidelines,
      brandName,
      aboutBrand,
      filmingInstructions,
      concepts,
      hooks,
      talkingPoints
    } = req.body;

    const draft = getOrCreateDraftOrder({
      orderId,
      sessionId: session.id,
      format: format || 'reaction'
    });

    let effectiveCreatorIds = undefined;
    if (Array.isArray(creatorIds)) {
      effectiveCreatorIds = creatorIds;
    } else if (Array.isArray(selectedCreators)) {
      effectiveCreatorIds = selectedCreators.map(c => typeof c === 'object' ? c.id : c).filter(Boolean);
    }

    const updated = updateDraftOrder(draft.id, {
      format,
      creatorIds: effectiveCreatorIds,
      qty,
      turnaroundHours,
      layoutPreference,
      sourceAssetUrl,
      timestampsCallouts,
      reactionStyleGuidelines,
      brandName,
      aboutBrand,
      filmingInstructions,
      concepts,
      hooks,
      talkingPoints
    });

    res.json({
      success: true,
      message: 'Draft order saved to unified state.',
      orderId: draft.id,
      draft: updated.draft,
      pricing: updated.pricing
    });
  } catch (error) {
    console.error('Error updating draft order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/draft
 * Retrieves latest unified draft order for active session
 */
router.get('/draft', (req, res) => {
  try {
    const session = resolveSession(req);
    const format = req.query.format || 'reaction';
    const draft = getOrCreateDraftOrder({ sessionId: session.id, format });

    res.json({
      success: true,
      draft
    });
  } catch (error) {
    console.error('Error getting draft order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/orders/draft/brief
 * GET /api/orders/:order_id/brief
 * 3. Dedicated Endpoint for the Edit Brief View (?format=reaction)
 * Performs verification, fresh rate lookup, authoritative pricing, and reaction brief customization
 */
const handleGetBriefView = (req, res) => {
  try {
    const session = resolveSession(req);
    const orderId = (req.params.order_id && req.params.order_id !== 'draft') ? req.params.order_id : null;
    const format = req.query.format || 'reaction';

    const data = getReactionBriefViewData({
      orderId,
      sessionId: session.id,
      format
    });

    res.json(data);
  } catch (error) {
    console.error('Error generating reaction brief view:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

router.get('/draft/brief', handleGetBriefView);
router.get('/:order_id/brief', handleGetBriefView);

/**
 * POST /api/orders/draft/brief
 * POST /api/orders/:order_id/brief
 * PATCH /api/orders/:order_id/brief
 * 5. Final Brief Submission & Validation
 * Validates mandatory reaction brief fields, locks pricing snapshot, and advances status to ready_for_checkout
 */
const handleSubmitBrief = (req, res) => {
  try {
    const session = resolveSession(req);
    const orderId = (req.params.order_id && req.params.order_id !== 'draft')
      ? req.params.order_id
      : (req.body.orderId || getOrCreateDraftOrder({ sessionId: session.id }).id);

    const result = submitAndLockReactionBrief(orderId, req.body, session);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('Error finalizing brief submission:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

router.post('/draft/brief', handleSubmitBrief);
router.post('/:order_id/brief', handleSubmitBrief);
router.patch('/:order_id/brief', handleSubmitBrief);

/**
 * GET /api/orders/:id
 * Retrieve order details (supports both open_orders and brief-based orders)
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;

    // First check open_orders
    const openOrder = db.prepare('SELECT * FROM open_orders WHERE id = ?').get(id);

    if (openOrder) {
      // Fetch claims, deliverables, and notifications for this order
      const claims = db.prepare('SELECT * FROM order_claims WHERE order_id = ?').all(id);
      const deliverables = db.prepare('SELECT * FROM order_deliverables WHERE order_id = ? ORDER BY created_at DESC').all(id);

      let creatorShipping = null;
      if (openOrder.requires_shipping && openOrder.assigned_creator_id) {
        creatorShipping = getCreatorShippingAddress(openOrder.assigned_creator_id);
      }

      return res.json({
        success: true,
        type: 'open_order',
        order: {
          id: openOrder.id,
          sessionId: openOrder.session_id,
          brandName: openOrder.brand_name,
          title: openOrder.title,
          formatType: openOrder.format_type,
          formatLabel: openOrder.format_type === 'reaction' ? 'Reaction Video' : 'Full UGC',
          formatLink: openOrder.format_link,
          sourceMediaUrl: openOrder.source_media_url,
          layoutInstruction: openOrder.layout_instruction,
          details: openOrder.details,
          script: openOrder.script,
          requiresShipping: Boolean(openOrder.requires_shipping),
          shippingProductName: openOrder.shipping_product_name,
          carrier: openOrder.carrier,
          trackingNumber: openOrder.tracking_number,
          shippingStatus: openOrder.shipping_status,
          shippingDeliveredAt: openOrder.shipping_delivered_at,
          creatorShippingAddress: creatorShipping ? creatorShipping.address : null,
          creatorPay: openOrder.creator_pay,
          platformFee: openOrder.platform_fee,
          total: openOrder.total,
          escrowStatus: openOrder.escrow_status,
          paymentIntentId: openOrder.payment_intent_id,
          status: openOrder.status,
          assignedCreatorId: openOrder.assigned_creator_id,
          assignedCreatorName: openOrder.assigned_creator_name,
          assignedAt: openOrder.assigned_at,
          turnaroundHours: openOrder.turnaround_hours,
          dueAt: openOrder.due_at,
          createdAt: openOrder.created_at,
          claims: claims.map(c => ({
            id: c.id,
            creatorId: c.creator_id,
            creatorName: c.creator_name,
            pitch: c.pitch,
            status: c.status,
            createdAt: c.created_at
          })),
          deliverables: deliverables.map(d => ({
            id: d.id,
            creatorId: d.creator_id,
            videoUrl: d.video_url,
            previewThumbnail: d.preview_thumbnail,
            notes: d.notes,
            status: d.status,
            verificationReport: d.verification_report ? JSON.parse(d.verification_report) : null,
            brandFeedback: d.brand_feedback,
            createdAt: d.created_at,
            reviewedAt: d.reviewed_at
          }))
        }
      });
    }

    // Fall back to brief-based orders
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    res.json({
      success: true,
      type: 'brief_order',
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
