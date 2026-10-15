/**
 * Rate and Pricing Engine
 * Protects tier calculations and ensures correct volume discounts per video count.
 */

function calculatePricing(quantity, creatorCount = 2) {
  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1) {
    throw new Error('Invalid video quantity. Must be at least 1.');
  }

  const validCreatorCount = Math.max(1, parseInt(creatorCount, 10) || 1);

  let rate = 30.00;
  let discountLabel = 'Starter ($30.00 / video)';
  let discountPercent = 0;

  if (qty >= 20) {
    rate = 25.00;
    discountLabel = 'Save 16.7% ($25.00 / video)';
    discountPercent = 16.7;
  } else if (qty >= 10) {
    rate = 27.50;
    discountLabel = 'Save 8.3% ($27.50 / video)';
    discountPercent = 8.3;
  }

  const total = parseFloat((qty * rate).toFixed(2));
  const perCreator = Math.max(1, Math.ceil(qty / validCreatorCount));

  return {
    quantity: qty,
    creatorCount: validCreatorCount,
    rate: parseFloat(rate.toFixed(2)),
    total,
    perCreator,
    discountPercent,
    discountLabel
  };
}

module.exports = {
  calculatePricing
};
