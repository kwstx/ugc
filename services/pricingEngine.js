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

function getTierConfigs(count) {
  if (count === 1) {
    return { tier1: 5, tier2: 10, tier3: 20, inc: 5 };
  }
  return {
    tier1: count * 3,
    tier2: count * 5,
    tier3: count * 10,
    inc: count * 3
  };
}

function calculatePricing(quantity, creatorCount = 2, explicitFormat = null) {
  let qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1) {
    qty = 5;
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
  const minVideos = isFullUgc ? 1 : 5;

  // Enforce minimum order rule (minimum 5 videos for Reaction Video)
  if (qty < minVideos) {
    qty = minVideos;
  }

  const tiers = getTierConfigs(validCreatorCount);
  let rate = baseRate;
  let discountLabel = `Starter ($${baseRate.toFixed(2)} / video)`;
  let discountPercent = 0;

  if (qty >= tiers.tier3) {
    rate = parseFloat((baseRate * (1 - 0.1666666667)).toFixed(2));
    discountLabel = `Save 16.7% ($${rate.toFixed(2)} / video)`;
    discountPercent = 16.7;
  } else if (qty >= tiers.tier2) {
    rate = parseFloat((baseRate * (1 - 0.0833333333)).toFixed(2));
    discountLabel = `Save 8.3% ($${rate.toFixed(2)} / video)`;
    discountPercent = 8.3;
  }

  const total = parseFloat((qty * rate).toFixed(2));
  const perCreator = Math.max(1, Math.ceil(qty / validCreatorCount));

  return {
    format: formatLabel,
    quantity: qty,
    minVideos,
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
