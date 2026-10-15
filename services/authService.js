/**
 * Authentication and Session Management Service
 * Provides brand login, cross-device session tracking, and account order history
 */

const db = require('../db');

function generateSessionId() {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
}

/**
 * Resolves or creates a session for the request
 */
function resolveSession(req) {
  const authHeader = req.headers['authorization'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-session-id']) {
    token = req.headers['x-session-id'].trim();
  } else if (req.query && req.query.sessionId) {
    token = req.query.sessionId.trim();
  } else if (req.body && req.body.sessionId) {
    token = req.body.sessionId.trim();
  }

  const brandName = (req.body && req.body.brandName) || (req.query && req.query.brandName) || 'Brand Client';

  if (token) {
    const existing = db.prepare('SELECT * FROM brand_sessions WHERE id = ?').get(token);
    if (existing) {
      db.prepare('UPDATE brand_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(token);
      return existing;
    }
  }

  // Generate new session
  const newSessionId = token || generateSessionId();
  const apiKey = 'key_' + Math.random().toString(36).substring(2, 12);
  
  db.prepare(`
    INSERT OR REPLACE INTO brand_sessions (id, brand_name, api_key, created_at, last_active_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(newSessionId, brandName, apiKey);

  return {
    id: newSessionId,
    brand_name: brandName,
    api_key: apiKey,
    isNew: true
  };
}

/**
 * Retrieves brand account profile and active orders
 */
function getBrandAccountSummary(sessionId) {
  const session = db.prepare('SELECT * FROM brand_sessions WHERE id = ?').get(sessionId);
  if (!session) {
    return null;
  }

  const orders = db.prepare(`
    SELECT * FROM open_orders 
    WHERE session_id = ? 
    ORDER BY created_at DESC
  `).all(sessionId);

  const totalSpent = orders
    .filter(o => o.status === 'completed' || o.escrow_status === 'held')
    .reduce((sum, o) => sum + (o.total || 0), 0);

  return {
    sessionId: session.id,
    brandName: session.brand_name,
    email: session.email || null,
    totalOrders: orders.length,
    activeOrdersCount: orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length,
    totalEscrowActive: orders.filter(o => o.escrow_status === 'held').reduce((sum, o) => sum + (o.total || 0), 0),
    totalSpent,
    orders: orders.map(o => ({
      id: o.id,
      title: o.title,
      formatType: o.format_type,
      status: o.status,
      escrowStatus: o.escrow_status,
      total: o.total,
      assignedCreator: o.assigned_creator_name || 'Seeking Creator',
      createdAt: o.created_at
    }))
  };
}

module.exports = {
  resolveSession,
  getBrandAccountSummary
};
