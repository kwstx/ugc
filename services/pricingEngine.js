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

/**
 * Lookup verified creator info & current base rate from database
 */
function getCreatorPricingInfo(creatorIdOrObj) {
  const id = typeof creatorIdOrObj === 'object' ? creatorIdOrObj.id : creatorIdOrObj;
  if (!id) return null;
  try {
    const creator = db.prepare('SELECT id, name, handle, avatar, status, rate, formats FROM creators WHERE id = ?').get(id);
    if (creator) {
      let formats = ['reaction'];
      try { formats = JSON.parse(creator.formats || '["reaction"]'); } catch (e) {}
      return {
        id: creator.id,
        name: creator.name,
        handle: creator.handle || `@${creator.name.toLowerCase()}_ugc`,
        avatar: creator.avatar,
        status: creator.status || 'active',
        available: creator.status === 'active',
        rate: parseFloat(creator.rate) || 25.00,
        formats
      };
    }
  } catch (e) {
    console.warn('Error fetching creator pricing info:', e.message);
  }
  if (typeof creatorIdOrObj === 'object') {
    return {
      id: creatorIdOrObj.id || 'creator_unknown',
      name: creatorIdOrObj.name || 'Creator',
      handle: creatorIdOrObj.handle || '@creator_ugc',
      avatar: creatorIdOrObj.avatar || 'creator_avatar.png',
      status: 'active',
      available: true,
      rate: 25.00,
      formats: ['reaction']
    };
  }
  return null;
}

/**
 * Authoritative Server-Side Pricing Engine
 * Calculates itemized pricing using fresh database creator rates, format multipliers,
 * turnaround premiums, volume discounts, licensing fees, and platform fees.
 */
function calculateAuthoritativePricing({
  creatorIds = [],
  quantity = 6,
  format = 'reaction',
  turnaroundHours = 48,
  licensingTier = 'standard',
  customDiscountPct = 0
}) {
  const isFullUgc = String(format).toLowerCase().includes('full');
  const formatKey = isFullUgc ? 'full' : 'reaction';
  const formatLabel = isFullUgc ? 'Full UGC' : 'Reaction Video';
  const minVideos = isFullUgc ? 1 : 5;

  let qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < minVideos) {
    qty = minVideos;
  }

  // Resolve verified creator records from database
  const idList = Array.isArray(creatorIds) ? creatorIds : [];
  const verifiedCreators = [];
  for (const c of idList) {
    const info = getCreatorPricingInfo(c);
    if (info) verifiedCreators.push(info);
  }

  const creatorCount = Math.max(1, verifiedCreators.length);
  const tiers = getTierConfigs(creatorCount);

  // Volume discount calculation
  let volumeDiscountPct = 0;
  let discountLabel = 'Starter order';
  if (qty >= tiers.tier3) {
    volumeDiscountPct = 16.7;
    discountLabel = 'Save 16.7% / video';
  } else if (qty >= tiers.tier2) {
    volumeDiscountPct = 8.3;
    discountLabel = 'Save 8.3% / video';
  }

  // Allocate videos per creator
  const basePerCreator = Math.floor(qty / creatorCount);
  let remainder = qty % creatorCount;

  let creatorBaseSubtotal = 0;
  const creatorLineItems = [];

  if (verifiedCreators.length > 0) {
    verifiedCreators.forEach((creator) => {
      const assignedVideos = basePerCreator + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;

      // Base rate for format: for reaction format, use creator.rate (or min 25.00)
      const baseRate = isFullUgc ? Math.max(100.00, creator.rate * 3) : Math.max(25.00, creator.rate);
      const lineCost = parseFloat((assignedVideos * baseRate).toFixed(2));
      creatorBaseSubtotal += lineCost;

      creatorLineItems.push({
        id: creator.id,
        name: creator.name,
        handle: creator.handle,
        avatar: creator.avatar,
        status: creator.status,
        available: creator.available,
        baseRate,
        assignedVideos,
        subtotal: lineCost
      });
    });
  } else {
    // Default placeholder rate if no creators picked yet
    const defaultRate = isFullUgc ? 100.00 : 25.00;
    creatorBaseSubtotal = parseFloat((qty * defaultRate).toFixed(2));
  }

  creatorBaseSubtotal = parseFloat(creatorBaseSubtotal.toFixed(2));

  // Volume discount amount
  const volumeDiscountAmount = parseFloat((creatorBaseSubtotal * (volumeDiscountPct / 100)).toFixed(2));
  const subtotalAfterVolume = parseFloat((creatorBaseSubtotal - volumeDiscountAmount).toFixed(2));

  // Turnaround premium (15% if rush <= 24 hours, standard 48h has 0%)
  const turnaroundHoursNum = parseInt(turnaroundHours, 10) || 48;
  const isRushTurnaround = turnaroundHoursNum <= 24;
  const turnaroundPremium = isRushTurnaround ? parseFloat((subtotalAfterVolume * 0.15).toFixed(2)) : 0.00;

  // Format licensing fee (standard ad license included $0; extended broadcast license $49 flat)
  const isExtendedLicensing = licensingTier === 'extended_commercial' || licensingTier === 'broadcast';
  const licensingFee = isExtendedLicensing ? 49.00 : 0.00;

  // Custom order subscription discount (e.g. 5% Growth, 10% Scale)
  const customDiscountAmount = (customDiscountPct > 0)
    ? parseFloat((subtotalAfterVolume * (customDiscountPct / 100)).toFixed(2))
    : 0.00;

  // Platform fee: 5% of net order spend (minimum $5.00)
  const netBeforePlatform = subtotalAfterVolume - customDiscountAmount + turnaroundPremium + licensingFee;
  const platformFee = parseFloat((Math.max(5.00, netBeforePlatform * 0.05)).toFixed(2));

  // Tax: 0% standard export digital service
  const tax = 0.00;

  // Grand Total
  const total = parseFloat((netBeforePlatform + platformFee + tax).toFixed(2));
  const effectiveRatePerVideo = parseFloat((total / qty).toFixed(2));

  return {
    format: formatLabel,
    formatKey,
    quantity: qty,
    minVideos,
    creatorCount,
    perCreator: Math.max(1, Math.ceil(qty / creatorCount)),
    turnaroundHours: turnaroundHoursNum,
    isRushTurnaround,
    licensingTier,
    discountLabel,
    volumeDiscountPercent: volumeDiscountPct,
    volumeDiscountAmount,
    customDiscountPercent: customDiscountPct,
    customDiscountAmount,
    turnaroundPremium,
    licensingFee,
    creatorBaseSubtotal,
    subtotal: subtotalAfterVolume,
    platformFee,
    tax,
    total,
    effectiveRatePerVideo,
    creators: creatorLineItems,
    currency: 'USD'
  };
}

module.exports = {
  calculatePricing,
  calculateAuthoritativePricing,
  getCreatorPricingInfo,
  getActiveFormatFromDb
};

