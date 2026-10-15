/**
 * Escrow and Payment Processing Service
 * Handles upfront payment authorization, escrow holds, and verified creator payouts
 */

const db = require('../db');
const { notify } = require('./notificationService');

/**
 * Creates upfront escrow deposit
 */
function createEscrowHold(orderId, totalAmount, brandName = 'Brand Client', paymentMethod = 'card_mock') {
  const paymentIntentId = 'pi_escrow_' + Date.now() + '_' + Math.floor(1000 + Math.random() * 9000);

  // Update order escrow status to 'held'
  const updateStmt = db.prepare(`
    UPDATE open_orders
    SET escrow_status = 'held',
        payment_intent_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  updateStmt.run(paymentIntentId, orderId);

  return {
    success: true,
    orderId,
    totalAmount,
    escrowStatus: 'held',
    paymentIntentId,
    paymentMethod,
    depositTimestamp: new Date().toISOString(),
    escrowGuarantee: '100% money-back guarantee. Funds released only upon final brand approval.'
  };
}

/**
 * Releases escrow funds directly to creator upon deliverable approval
 */
function releaseEscrow(orderId, creatorId, brandSessionId = null) {
  const order = db.prepare('SELECT * FROM open_orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error(`Order #${orderId} not found.`);
  }

  if (order.escrow_status === 'released') {
    return {
      success: true,
      alreadyReleased: true,
      orderId,
      creatorPayout: order.creator_pay,
      platformFee: order.platform_fee,
      message: 'Escrow has already been released for this order.'
    };
  }

  const payoutReference = 'po_creator_' + Date.now() + '_' + Math.floor(1000 + Math.random() * 9000);

  // Update order escrow status
  db.prepare(`
    UPDATE open_orders
    SET escrow_status = 'released',
        status = 'completed',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(orderId);

  // Increment creator completed orders
  try {
    db.prepare('UPDATE creators SET completed_orders = completed_orders + 1 WHERE id = ?').run(creatorId || order.assigned_creator_id);
  } catch (err) {}

  // Dispatch notifications
  if (creatorId || order.assigned_creator_id) {
    const targetCreatorId = creatorId || order.assigned_creator_id;
    notify(
      'creator',
      targetCreatorId,
      order.id,
      'escrow_released',
      'Escrow Funds Released! 💰',
      `Brand approved your submission for "${order.title}". $${order.creator_pay.toFixed(2)} has been paid out (Ref: ${payoutReference}).`
    );
  }

  if (order.session_id) {
    notify(
      'brand',
      order.session_id,
      order.id,
      'escrow_released',
      'Order Completed & Payout Released',
      `Your approved order "${order.title}" is complete. Creator received $${order.creator_pay.toFixed(2)}. Platform fee: $${order.platform_fee.toFixed(2)}.`
    );
  }

  return {
    success: true,
    orderId,
    creatorId: creatorId || order.assigned_creator_id,
    creatorPayout: order.creator_pay,
    platformFee: order.platform_fee,
    totalEscrow: order.total,
    payoutReference,
    status: 'released',
    timestamp: new Date().toISOString()
  };
}

/**
 * Refunds escrow to client (e.g. if cancelled before creator claims)
 */
function refundEscrow(orderId, reason = 'Order cancelled') {
  const order = db.prepare('SELECT * FROM open_orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error(`Order #${orderId} not found.`);
  }

  if (order.escrow_status === 'released') {
    throw new Error('Cannot refund escrow that has already been released to the creator.');
  }

  const refundId = 'ref_' + Date.now() + '_' + Math.floor(1000 + Math.random() * 9000);

  db.prepare(`
    UPDATE open_orders
    SET escrow_status = 'refunded',
        status = 'cancelled',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(orderId);

  return {
    success: true,
    orderId,
    refundAmount: order.total,
    refundId,
    reason,
    status: 'refunded',
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  createEscrowHold,
  releaseEscrow,
  refundEscrow
};
