/**
 * Creator Marketplace and Recommendation Engine
 * Matches creators to open briefs based on format specialties,
 * handles order claiming, applicant caps, and prevents over-subscription.
 */

const db = require('../db');
const { notify } = require('./notificationService');

/**
 * Retrieves recommended creators filtered by format capability
 */
function getMatchingCreators(formatType) {
  const normFormat = (formatType || '').toLowerCase().includes('full') ? 'full_ugc' : 'reaction';
  const creators = db.prepare("SELECT * FROM creators WHERE status = 'active'").all();

  const matched = [];
  for (const c of creators) {
    let formats = ['reaction'];
    try {
      formats = c.formats ? JSON.parse(c.formats) : ['reaction'];
    } catch (e) {}

    if (formats.includes(normFormat)) {
      matched.push({
        id: c.id,
        name: c.name,
        handle: c.handle,
        avatar: c.avatar,
        rate: c.rate,
        rating: c.rating || '5.0 (20)',
        completedOrders: c.completed_orders || 0,
        specialties: formats,
        isFormatMatch: true
      });
    }
  }

  // Sort by rating / completed orders
  matched.sort((a, b) => (b.completedOrders || 0) - (a.completedOrders || 0));
  return matched;
}

/**
 * Handles a creator claiming or applying for an open order
 */
function claimOpenOrder(orderId, creatorId, pitch = '') {
  const order = db.prepare('SELECT * FROM open_orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error(`Order #${orderId} not found.`);
  }

  if (order.status !== 'open') {
    throw new Error(`Order #${orderId} is no longer open for claims (Current status: ${order.status}).`);
  }

  // Check creator existence & format eligibility
  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(creatorId);
  if (!creator) {
    throw new Error(`Creator #${creatorId} not found.`);
  }

  let creatorFormats = ['reaction'];
  try {
    creatorFormats = creator.formats ? JSON.parse(creator.formats) : ['reaction'];
  } catch (e) {}

  if (!creatorFormats.includes(order.format_type)) {
    throw new Error(`Creator "${creator.name}" specializes in ${creatorFormats.join(', ')}, but this order requires ${order.format_type}.`);
  }

  // Check existing claims to enforce applicant cap
  const existingClaims = db.prepare('SELECT COUNT(*) as count FROM order_claims WHERE order_id = ?').get(orderId).count;
  const maxApplicants = order.max_applicants || 3;
  if (existingClaims >= maxApplicants) {
    throw new Error(`Applicant cap reached (${maxApplicants} creators have already applied). Over-subscription prevented.`);
  }

  // Record application
  const claimId = 'claim_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  db.prepare(`
    INSERT INTO order_claims (id, order_id, creator_id, creator_name, pitch, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'assigned', CURRENT_TIMESTAMP)
  `).run(claimId, orderId, creator.id, creator.name, pitch || 'Ready to produce this UGC brief.');

  // Calculate turnaround deadline
  let newStatus = 'in_progress';
  let dueAt = null;

  if (order.format_type === 'reaction') {
    // Reaction starts immediately: 36 hours
    const dueDate = new Date();
    dueDate.setHours(dueDate.getHours() + (order.turnaround_hours || 36));
    dueAt = dueDate.toISOString();
    newStatus = 'in_progress';
  } else {
    // Full UGC: If shipping required, wait for delivery
    if (order.requires_shipping && order.shipping_status !== 'delivered') {
      newStatus = 'shipping';
      dueAt = null; // Will start when sample arrives
    } else {
      const dueDate = new Date();
      dueDate.setHours(dueDate.getHours() + (order.turnaround_hours || 120));
      dueAt = dueDate.toISOString();
      newStatus = 'in_progress';
    }
  }

  // Update order assignment
  db.prepare(`
    UPDATE open_orders
    SET assigned_creator_id = ?,
        assigned_creator_name = ?,
        assigned_at = CURRENT_TIMESTAMP,
        status = ?,
        due_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(creator.id, creator.name, newStatus, dueAt, orderId);

  // Notify brand
  notify(
    'brand',
    order.session_id || 'brand_client',
    order.id,
    'creator_claimed',
    'Creator Assigned to Your Brief! 🎉',
    `${creator.name} accepted your ${order.format_type === 'reaction' ? 'Reaction Video' : 'Full UGC'} brief ("${order.title}"). Production status: ${newStatus}.`
  );

  return {
    success: true,
    orderId,
    creatorId: creator.id,
    creatorName: creator.name,
    status: newStatus,
    turnaroundHours: order.turnaround_hours,
    dueAt,
    applicantNumber: existingClaims + 1,
    maxApplicants
  };
}

module.exports = {
  getMatchingCreators,
  claimOpenOrder
};
