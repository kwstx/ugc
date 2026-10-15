/**
 * Notification and Webhook Service
 * Dispatches automated alerts to brands and creators on order lifecycle events
 */

const db = require('../db');

function generateNotificationId() {
  return 'notif_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

/**
 * Sends and records an in-app notification & simulates webhook dispatch
 */
function notify(recipientType, recipientId, orderId, eventType, title, message) {
  try {
    const id = generateNotificationId();
    const insertStmt = db.prepare(`
      INSERT INTO notifications (id, recipient_type, recipient_id, order_id, event_type, title, message, read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
    `);

    insertStmt.run(id, recipientType, recipientId, orderId || null, eventType, title, message);

    console.log(`[Notification dispatched] [${eventType}] To ${recipientType} (${recipientId}): "${title}"`);

    return {
      id,
      recipientType,
      recipientId,
      orderId,
      eventType,
      title,
      message,
      read: 0,
      createdAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('Failed to record notification:', err);
    return null;
  }
}

/**
 * Retrieve notifications for a brand session or creator
 */
function getNotifications(recipientType, recipientId, limit = 20) {
  try {
    const stmt = db.prepare(`
      SELECT * FROM notifications
      WHERE recipient_type = ? AND (recipient_id = ? OR recipient_id = 'all')
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(recipientType, recipientId, limit);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    return [];
  }
}

/**
 * Mark notification as read
 */
function markAsRead(notificationId) {
  try {
    const stmt = db.prepare('UPDATE notifications SET read = 1 WHERE id = ?');
    stmt.run(notificationId);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  notify,
  getNotifications,
  markAsRead
};
