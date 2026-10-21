const db = require('../db');
const { resolveSession } = require('../services/authService');
const { getUserBillingState, consumeCredits } = require('../services/billingService');

/**
 * Helper to extract userId/sessionId consistently from request
 */
function resolveBillingUserId(req) {
  const explicitUser = req.headers['x-user-id'] || req.headers['x-session-id'] || req.query?.userId || req.query?.sessionId || req.body?.userId || req.body?.sessionId;
  if (explicitUser) return String(explicitUser).trim();
  const session = resolveSession(req);
  return session.id;
}

/**
 * 5. Feature Gate Middleware
 * Verifies active subscription & plan entitlements on API routes:
 * - requireActiveSubscription: ensures user is in 'trialing' or 'active' subscription state
 * - requireFeatureGate(featureKey): checks boolean/limit entitlements (e.g., 'hasSofiaMcp', 'hasPublicApi', 'socialSetsLimit')
 * - requireCredits(calculateAmountFn, ledgerType): atomically reserves/deducts credits before completing an action
 */
function requireActiveSubscription(req, res, next) {
  try {
    const userId = resolveBillingUserId(req);
    const billing = getUserBillingState(userId);

    if (!billing.subscription || !['trialing', 'active'].includes(billing.subscription.status)) {
      return res.status(403).json({
        success: false,
        code: 'SUBSCRIPTION_REQUIRED',
        error: 'An active or trialing subscription (Starter, Growth, or Scale) is required to access this feature.',
        currentStatus: billing.subscription?.status || 'none'
      });
    }

    req.billing = billing;
    req.userId = userId;
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Middleware factory for checking specific plan entitlements
 * Supported feature keys:
 * - 'hasSofiaMcp' (Growth & Scale only)
 * - 'hasPublicApi' (Scale only)
 * - 'hasAgentSofiaDashboard' (Starter, Growth, Scale)
 * - 'hasOnboardingCall' (Scale only)
 * - 'socialSetsLimit' (Blocks adding a 2nd social set on Starter, 6th on Growth, 11th on Scale)
 */
function requireFeatureGate(featureKey) {
  return (req, res, next) => {
    try {
      const userId = resolveBillingUserId(req);
      const billing = req.billing || getUserBillingState(userId);
      req.billing = billing;
      req.userId = userId;

      if (!billing.subscription || !['trialing', 'active'].includes(billing.subscription.status)) {
        return res.status(403).json({
          success: false,
          code: 'SUBSCRIPTION_REQUIRED',
          error: `An active subscription is required to use ${featureKey}.`
        });
      }

      const ent = billing.entitlements;

      if (featureKey === 'socialSetsLimit') {
        const currentCount = db.prepare('SELECT COUNT(*) as count FROM social_sets WHERE user_id = ?').get(userId).count;
        if (currentCount >= ent.maxSocialSets) {
          return res.status(403).json({
            success: false,
            code: 'SOCIAL_SET_LIMIT_REACHED',
            error: `Your ${ent.name} plan allows up to ${ent.maxSocialSets} social set(s). You currently have ${currentCount}. Upgrade your plan to add more social sets.`,
            planTier: ent.planTier,
            currentCount,
            maxAllowed: ent.maxSocialSets
          });
        }
        return next();
      }

      if (!ent[featureKey]) {
        const requiredTierHint = featureKey === 'hasPublicApi' || featureKey === 'hasOnboardingCall'
          ? 'Scale'
          : 'Growth or Scale';

        return res.status(403).json({
          success: false,
          code: 'ENTITLEMENT_RESTRICTED',
          feature: featureKey,
          planTier: ent.planTier,
          error: `Your current ${ent.name} plan does not include "${featureKey}". Please upgrade to the ${requiredTierHint} plan.`
        });
      }

      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * Middleware factory for atomic credit reservation & deduction
 */
function requireAtomicCredits({ getCost, type = 'clip_purchase', getReferenceId, getDescription }) {
  return (req, res, next) => {
    try {
      const userId = resolveBillingUserId(req);
      const cost = typeof getCost === 'function' ? getCost(req) : Number(getCost);
      const refId = typeof getReferenceId === 'function' ? getReferenceId(req) : null;
      const desc = typeof getDescription === 'function' ? getDescription(req) : `Credit deduction (${type})`;

      const deduction = consumeCredits(userId, cost, type, refId, desc);
      req.creditDeduction = deduction;
      req.userId = userId;
      next();
    } catch (err) {
      if (err.code === 'INSUFFICIENT_CREDITS') {
        return res.status(402).json({
          success: false,
          code: 'INSUFFICIENT_CREDITS',
          error: err.message,
          availableCredits: err.available,
          requiredCredits: err.required
        });
      }
      res.status(400).json({ success: false, error: err.message });
    }
  };
}

module.exports = {
  resolveBillingUserId,
  requireActiveSubscription,
  requireFeatureGate,
  requireAtomicCredits
};
