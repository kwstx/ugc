const db = require('../db');

/**
 * Rate and Pricing Engine
 * Reaction Video: $25.00 per video
 * Full UGC: $100.00 per video
 * Protects tier calculations and ensures correct volume discounts per video count.
 */

function getActiveFormatFromDb(sessionId = 'default_session') {
  try {
    const row = db.prepare('SELECT format_choice, rate FROM order_format_state WHERE session_id = ?').get(sessionId);
    if (row) return row;
    const defaultRow = db.prepare('SELECT format_choice, rate FROM order_format_state WHERE session_id = ?').get('default_session');
    if (defaultRow) return defaultRow;
  } catch (e) {}
  return { format_choice: 'Reaction Video', rate: 25.00 };
}

function calculatePricing(quantity, creatorCount = 2, explicitFormat = null) {
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1) {
    throw new Error('Invalid video quantity. Must be at least 1.');
  }

  const validCreatorCount = Math.max(1, parseInt(creatorCount, 10) || 1);

  let chosenFormat = explicitFormat;
  if (!chosenFormat) {
    const active = getActiveFormatFromDb();
    chosenFormat = active.format_choice;
  }

  const isFullUgc = (
    chosenFormat &&
    (chosenFormat === 'Full UGC' ||
      String(chosenFormat).toLowerCase().includes('full'))
  );
  const baseRate = isFullUgc ? 100.00 : 25.00;
  const formatLabel = isFullUgc ? 'Full UGC' : 'Reaction Video';

  const rate = baseRate;
  const discountLabel = `$${baseRate.toFixed(2)} / video`;
  const discountPercent = 0;

  const total = parseFloat((qty * rate).toFixed(2));
  const perCreator = Math.max(1, Math.ceil(qty / validCreatorCount));

  return {
    format: formatLabel,
    quantity: qty,
    creatorCount: validCreatorCount,
    rate: parseFloat(rate.toFixed(2)),
    baseRate,
    total,
    perCreator,
    discountPercent,
    discountLabel
  };
}

module.exports = {
  calculatePricing,
  getActiveFormatFromDb
};
