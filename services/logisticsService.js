/**
 * Logistics and Physical Shipping Management Service
 * Manages physical product shipments to creators for Full UGC orders,
 * tracking numbers, delivery confirmations, and hold timelines.
 */

const db = require('../db');
const { notify } = require('./notificationService');

/**
 * Updates shipping information for an order
 */
function updateShippingInfo(orderId, shippingData) {
  const order = db.prepare('SELECT * FROM open_orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error(`Order #${orderId} not found.`);
  }

  if (order.format_type === 'reaction') {
    throw new Error('Reaction Video orders do not require physical product shipping. Production starts immediately upon creator acceptance.');
  }

  const carrier = (shippingData.carrier || order.carrier || 'USPS').trim();
  const trackingNumber = (shippingData.trackingNumber || order.tracking_number || '').trim();
  const newStatus = shippingData.status || order.shipping_status || 'pending_shipment';

  const validStatuses = ['not_required', 'pending_shipment', 'in_transit', 'delivered'];
  if (!validStatuses.includes(newStatus)) {
    throw new Error(`Invalid shipping status '${newStatus}'. Must be one of: ${validStatuses.join(', ')}`);
  }

  let deliveredAt = order.shipping_delivered_at;
  let newOrderStatus = order.status;
  let newDueAt = order.due_at;

  // If status transitions to 'delivered', activate production timeline
  if (newStatus === 'delivered' && order.shipping_status !== 'delivered') {
    deliveredAt = new Date().toISOString();
    newOrderStatus = 'in_progress';
    
    // Calculate due date based on turnaround_hours starting from delivery
    const dueTime = new Date();
    dueTime.setHours(dueTime.getHours() + (order.turnaround_hours || 120));
    newDueAt = dueTime.toISOString();

    // Notify creator that product arrived and countdown started
    if (order.assigned_creator_id) {
      notify(
        'creator',
        order.assigned_creator_id,
        order.id,
        'product_delivered',
        'Sample Product Delivered!',
        `The sample for "${order.title}" was marked delivered. Your ${Math.round(order.turnaround_hours / 24)}-day filming period has started (Due: ${dueTime.toLocaleDateString()}).`
      );
    }
  } else if (newStatus === 'in_transit') {
    newOrderStatus = 'shipping';
    if (order.assigned_creator_id) {
      notify(
        'creator',
        order.assigned_creator_id,
        order.id,
        'product_shipped',
        'Sample Product Shipped',
        `Brand shipped your sample via ${carrier} (Tracking: ${trackingNumber || 'Available in portal'}).`
      );
    }
  }

  const updateStmt = db.prepare(`
    UPDATE open_orders
    SET carrier = ?,
        tracking_number = ?,
        shipping_status = ?,
        shipping_delivered_at = ?,
        status = ?,
        due_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  updateStmt.run(
    carrier,
    trackingNumber,
    newStatus,
    deliveredAt,
    newOrderStatus,
    newDueAt,
    orderId
  );

  return {
    success: true,
    orderId,
    carrier,
    trackingNumber,
    shippingStatus: newStatus,
    deliveredAt,
    orderStatus: newOrderStatus,
    dueAt: newDueAt
  };
}

/**
 * Gets creator's verified shipping address for sample product delivery
 */
function getCreatorShippingAddress(creatorId) {
  const creator = db.prepare('SELECT id, name, shipping_address FROM creators WHERE id = ?').get(creatorId);
  if (!creator) return null;

  let address = null;
  try {
    address = creator.shipping_address ? JSON.parse(creator.shipping_address) : null;
  } catch (e) {
    address = null;
  }

  return {
    creatorId: creator.id,
    creatorName: creator.name,
    address: address || {
      street: '100 Studio Way #2B',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      country: 'USA'
    }
  };
}

module.exports = {
  updateShippingInfo,
  getCreatorShippingAddress
};
