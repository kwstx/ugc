/**
 * Library Cart & Bundling Pricing Engine
 * Base price: $15.00 / clip
 * Bundling discounts:
 * - 1 clip: 0% discount ($15.00/ea)
 * - 2-3 clips: 10% discount ($13.50/ea)
 * - 4-5 clips: 15% discount ($12.75/ea)
 * - 6+ clips: 20% discount ($12.00/ea)
 */

function calculateClipBundlePricing(clips = []) {
  const clipList = Array.isArray(clips) ? clips : [];
  const count = clipList.length;

  if (count === 0) {
    return {
      clipCount: 0,
      subtotal: 0.00,
      discountPercent: 0,
      discountAmount: 0.00,
      total: 0.00,
      effectiveRatePerClip: 15.00,
      bundleTierLabel: 'Select clips to bundle'
    };
  }

  // Calculate sum of base prices
  const subtotal = clipList.reduce((acc, c) => acc + (parseFloat(c.price) || 15.00), 0);

  let discountPercent = 0;
  let bundleTierLabel = 'Single clip';

  if (count >= 6) {
    discountPercent = 20;
    bundleTierLabel = 'Pro Bundle (Save 20%)';
  } else if (count >= 4) {
    discountPercent = 15;
    bundleTierLabel = 'Growth Bundle (Save 15%)';
  } else if (count >= 2) {
    discountPercent = 10;
    bundleTierLabel = 'Starter Bundle (Save 10%)';
  }

  const discountAmount = parseFloat(((subtotal * discountPercent) / 100).toFixed(2));
  const total = parseFloat((subtotal - discountAmount).toFixed(2));
  const effectiveRatePerClip = parseFloat((total / count).toFixed(2));

  return {
    clipCount: count,
    subtotal: parseFloat(subtotal.toFixed(2)),
    discountPercent,
    discountAmount,
    total,
    effectiveRatePerClip,
    bundleTierLabel
  };
}

module.exports = {
  calculateClipBundlePricing
};
