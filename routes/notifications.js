const express = require('express');
const router = express.Router();
const { getNotifications, markAsRead } = require('../services/notificationService');
const { resolveSession } = require('../services/authService');

/**
 * GET /api/notifications
 * Retrieves notifications for the brand session or creator
 */
router.get('/', (req, res) => {
  try {
    const session = resolveSession(req);
    const recipientType = req.query.type || 'brand';
    const recipientId = req.query.recipientId || session.id;

    const list = getNotifications(recipientType, recipientId, parseInt(req.query.limit) || 20);
    res.json({
      success: true,
      recipientType,
      recipientId,
      notifications: list
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/notifications/:id/read
 * Mark notification as read
 */
router.post('/:id/read', (req, res) => {
  try {
    const { id } = req.params;
    const success = markAsRead(id);
    res.json({ success });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
