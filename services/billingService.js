const crypto = require('crypto');
const db = require('../db');
const { notify } = require('./notificationService');

/**
 * 1. Payment & Subscription Provider Configuration (Stripe Billing + Local Simulator)
 * Products & Prices Setup:
 * - Starter ($280/mo or $224/mo billed yearly at $2,688/yr) -> 370 monthly credits, +70 free/qtr
 * - Growth ($880/mo or $704/mo billed yearly at $8,448/yr)  -> 1,500 monthly credits, +210 free/qtr
 * - Scale ($2,980/mo or $2,384/mo billed yearly at $28,608/yr) -> 3,700 monthly credits, +650 free/qtr
 */
const STRIPE_PRODUCTS = {
  starter: {
    productId: process.env.STRIPE_PRODUCT_STARTER || 'prod_sofia_starter',
    name: 'Starter',
    tagline: 'Your first viral test',
    prices: {
      month: {
        priceId: process.env.STRIPE_PRICE_STARTER_MONTHLY || 'price_starter_monthly_280',
        unitAmountCents: 28000,
        displayMonthlyUsd: 280,
        interval: 'month'
      },
      year: {
        priceId: process.env.STRIPE_PRICE_STARTER_YEARLY || 'price_starter_yearly_2688',
        unitAmountCents: 268800, // $224/mo * 12 (Save 20%)
        displayMonthlyUsd: 224,
        interval: 'year'
      }
    }
  },
  growth: {
    productId: process.env.STRIPE_PRODUCT_GROWTH || 'prod_sofia_growth',
    name: 'Growth',
    tagline: 'For teams shipping ads every week',
    popular: true,
    prices: {
      month: {
        priceId: process.env.STRIPE_PRICE_GROWTH_MONTHLY || 'price_growth_monthly_880',
        unitAmountCents: 88000,
        displayMonthlyUsd: 880,
        interval: 'month'
      },
      year: {
        priceId: process.env.STRIPE_PRICE_GROWTH_YEARLY || 'price_growth_yearly_8448',
        unitAmountCents: 844800, // $704/mo * 12 (Save 20%)
        displayMonthlyUsd: 704,
        interval: 'year'
      }
    }
  },
  scale: {
    productId: process.env.STRIPE_PRODUCT_SCALE || 'prod_sofia_scale',
    name: 'Scale',
    tagline: 'For studios and agencies',
    prices: {
      month: {
        priceId: process.env.STRIPE_PRICE_SCALE_MONTHLY || 'price_scale_monthly_2980',
        unitAmountCents: 298000,
        displayMonthlyUsd: 2980,
        interval: 'month'
      },
      year: {
        priceId: process.env.STRIPE_PRICE_SCALE_YEARLY || 'price_scale_yearly_28608',
        unitAmountCents: 2860800, // $2,384/mo * 12 (Save 20%)
        displayMonthlyUsd: 2384,
        interval: 'year'
      }
    }
  }
};

/**
 * Helper: Execute a callback inside an atomic SQLite IMMEDIATE transaction
 * (Equivalent to PostgreSQL SELECT ... FOR UPDATE row-level lock)
 */
function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    throw err;
  }
}

/**
 * Ensure user has a credit_wallets row and return it
 */
function ensureWallet(userId, orgId = null) {
  let wallet = db.prepare('SELECT * FROM credit_wallets WHERE user_id = ?').get(userId);
  if (!wallet) {
    const walletId = 'wal_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
      INSERT INTO credit_wallets (id, user_id, org_id, balance, lifetime_earned, lifetime_spent, updated_at)
      VALUES (?, ?, ?, 0, 0, 0, CURRENT_TIMESTAMP)
    `).run(walletId, userId, orgId);
    wallet = db.prepare('SELECT * FROM credit_wallets WHERE user_id = ?').get(userId);
  }
  return wallet;
}

/**
 * Append-only Credit Ledger Deposit (Atomic)
 */
function grantCredits(userId, amount, type, referenceId, description = '') {
  if (amount <= 0) {
    throw new Error('Grant amount must be positive.');
  }

  return withTransaction(() => {
    const wallet = ensureWallet(userId);

    // Idempotency guard: if referenceId + type already exists in credit_ledger, do not double-grant
    if (referenceId) {
      const existingEntry = db.prepare(`
        SELECT * FROM credit_ledger WHERE reference_id = ? AND type = ? AND user_id = ?
      `).get(referenceId, type, userId);
      if (existingEntry) {
        return {
          alreadyProcessed: true,
          wallet: db.prepare('SELECT * FROM credit_wallets WHERE id = ?').get(wallet.id),
          ledgerEntry: existingEntry
        };
      }
    }

    const newBalance = wallet.balance + amount;
    const newLifetimeEarned = wallet.lifetime_earned + amount;

    db.prepare(`
      UPDATE credit_wallets
      SET balance = ?, lifetime_earned = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newBalance, newLifetimeEarned, wallet.id);

    const ledgerId = 'led_' + crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO credit_ledger (id, user_id, wallet_id, amount, balance_after, type, reference_id, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(ledgerId, userId, wallet.id, amount, newBalance, type, referenceId || null, description);

    return {
      alreadyProcessed: false,
      wallet: db.prepare('SELECT * FROM credit_wallets WHERE id = ?').get(wallet.id),
      ledgerEntry: db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(ledgerId)
    };
  });
}

/**
 * 5. Atomic Credit Reservation & Consumption
 * Prevents concurrent double-spending via BEGIN IMMEDIATE TRANSACTION + balance check + append-only ledger
 */
function consumeCredits(userId, amount, type, referenceId, description = '') {
  const cost = Math.abs(parseInt(amount, 10));
  if (isNaN(cost) || cost <= 0) {
    throw new Error('Credit consumption amount must be a positive integer.');
  }

  const validTypes = ['clip_purchase', 'custom_order', 'expiration'];
  if (!validTypes.includes(type)) {
    throw new Error(`Invalid debit ledger type "${type}". Must be one of: ${validTypes.join(', ')}`);
  }

  return withTransaction(() => {
    const wallet = ensureWallet(userId);

    if (wallet.balance < cost) {
      const err = new Error(`Insufficient credits. Available: ${wallet.balance} credits, Required: ${cost} credits.`);
      err.code = 'INSUFFICIENT_CREDITS';
      err.available = wallet.balance;
      err.required = cost;
      throw err;
    }

    const newBalance = wallet.balance - cost;
    const newLifetimeSpent = wallet.lifetime_spent + cost;

    db.prepare(`
      UPDATE credit_wallets
      SET balance = ?, lifetime_spent = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newBalance, newLifetimeSpent, wallet.id);

    const ledgerId = 'led_' + crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO credit_ledger (id, user_id, wallet_id, amount, balance_after, type, reference_id, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(ledgerId, userId, wallet.id, -cost, newBalance, type, referenceId || null, description);

    return {
      wallet: db.prepare('SELECT * FROM credit_wallets WHERE id = ?').get(wallet.id),
      ledgerEntry: db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(ledgerId)
    };
  });
}

/**
 * Get Plan Entitlements by Tier
 */
function getPlanEntitlements(planTier) {
  const norm = String(planTier || 'starter').toLowerCase();
  const row = db.prepare('SELECT * FROM entitlements WHERE plan_tier = ?').get(norm);
  if (!row) return null;
  return {
    planTier: row.plan_tier,
    name: row.name,
    monthlyPriceUsd: row.monthly_price_usd,
    yearlyMonthlyPriceUsd: row.yearly_monthly_price_usd,
    yearlyTotalPriceUsd: row.yearly_total_price_usd,
    monthlyCredits: row.monthly_credits,
    quarterlyBonusCredits: row.quarterly_bonus_credits,
    approxClips: row.approx_clips,
    clipCreditCost: row.clip_credit_cost,
    maxSocialSets: row.max_social_sets,
    hasSofiaMcp: Boolean(row.has_sofia_mcp),
    hasAgentSofiaDashboard: Boolean(row.has_agent_sofia_dashboard),
    hasPublicApi: Boolean(row.has_public_api),
    hasOnboardingCall: Boolean(row.has_onboarding_call),
    customOrderDiscountPct: row.custom_order_discount_pct,
    trialDays: row.trial_days,
    stripeProduct: STRIPE_PRODUCTS[row.plan_tier]
  };
}

/**
 * Get all Catalog Plans + Prices + Entitlements
 */
function getAllPlansCatalog() {
  const rows = db.prepare(`
    SELECT * FROM entitlements
    ORDER BY monthly_price_usd ASC
  `).all();
  return rows.map(r => getPlanEntitlements(r.plan_tier));
}

/**
 * Resolve Price ID or (planTier + billingInterval) to canonical plan config
 */
function resolvePlanFromInput({ priceId, planTier, billingInterval }) {
  if (priceId) {
    for (const [tier, product] of Object.entries(STRIPE_PRODUCTS)) {
      if (product.prices.month.priceId === priceId) {
        return { planTier: tier, billingInterval: 'month', priceConfig: product.prices.month, product };
      }
      if (product.prices.year.priceId === priceId) {
        return { planTier: tier, billingInterval: 'year', priceConfig: product.prices.year, product };
      }
    }
  }

  const normTier = ['starter', 'growth', 'scale'].includes(String(planTier).toLowerCase())
    ? String(planTier).toLowerCase()
    : 'growth';
  const normInterval = (String(billingInterval).toLowerCase() === 'year' || String(billingInterval).toLowerCase() === 'yearly')
    ? 'year'
    : 'month';

  const product = STRIPE_PRODUCTS[normTier];
  return {
    planTier: normTier,
    billingInterval: normInterval,
    priceConfig: product.prices[normInterval],
    product
  };
}

/**
 * Get User Subscription, Wallet, Ledger, and Active Entitlements
 */
function getUserBillingState(userId) {
  const subscription = db.prepare(`
    SELECT * FROM subscriptions
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(userId);

  const wallet = ensureWallet(userId);
  const recentLedger = db.prepare(`
    SELECT * FROM credit_ledger
    WHERE user_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 25
  `).all(userId);

  const socialSets = db.prepare(`
    SELECT * FROM social_sets
    WHERE user_id = ?
    ORDER BY created_at ASC
  `).all(userId);

  const isSubActive = subscription && ['trialing', 'active'].includes(subscription.status);
  const entitlements = isSubActive ? getPlanEntitlements(subscription.plan_tier) : {
    planTier: 'free',
    name: 'No Active Plan',
    monthlyCredits: 0,
    quarterlyBonusCredits: 0,
    clipCreditCost: 11,
    maxSocialSets: 0,
    hasSofiaMcp: false,
    hasAgentSofiaDashboard: false,
    hasPublicApi: false,
    hasOnboardingCall: false,
    customOrderDiscountPct: 0
  };

  return {
    userId,
    subscription: subscription ? {
      id: subscription.id,
      userId: subscription.user_id,
      orgId: subscription.org_id,
      stripeCustomerId: subscription.stripe_customer_id,
      stripeSubscriptionId: subscription.stripe_subscription_id,
      planTier: subscription.plan_tier,
      billingInterval: subscription.billing_interval,
      status: subscription.status,
      trialEnd: subscription.trial_end,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      lastMonthlyGrantAt: subscription.last_monthly_grant_at,
      lastQuarterlyGrantAt: subscription.last_quarterly_grant_at,
      createdAt: subscription.created_at,
      updatedAt: subscription.updated_at
    } : null,
    wallet: {
      id: wallet.id,
      balance: wallet.balance,
      lifetimeEarned: wallet.lifetime_earned,
      lifetimeSpent: wallet.lifetime_spent,
      approxClipsRemaining: Math.floor(wallet.balance / 11),
      updatedAt: wallet.updated_at
    },
    entitlements,
    socialSets: {
      used: socialSets.length,
      limit: entitlements.maxSocialSets,
      items: socialSets
    },
    ledger: recentLedger.map(l => ({
      id: l.id,
      amount: l.amount,
      balanceAfter: l.balance_after,
      type: l.type,
      referenceId: l.reference_id,
      description: l.description,
      createdAt: l.created_at
    }))
  };
}

/**
 * Create Stripe Checkout Session (Supports real Stripe SDK if STRIPE_SECRET_KEY is configured,
 * or built-in local Stripe Checkout Simulator with 7-day trial & instant webhook provisioning)
 */
async function createCheckoutSession({ userId, orgId, planTier, billingInterval, priceId, successUrl, cancelUrl, simulateImmediateActivation = true }) {
  const resolved = resolvePlanFromInput({ priceId, planTier, billingInterval });
  const planEntitlements = getPlanEntitlements(resolved.planTier);
  const checkoutSessionId = 'cs_test_' + crypto.randomBytes(12).toString('hex');
  const customerId = 'cus_' + crypto.createHash('md5').update(userId).digest('hex').substring(0, 14);
  const stripeSubId = 'sub_' + crypto.randomBytes(10).toString('hex');

  // If live Stripe Secret Key is provided in .env, create a real Stripe Checkout Session via REST API
  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('client_reference_id', userId);
    params.append('line_items[0][price]', resolved.priceConfig.priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('subscription_data[trial_period_days]', String(planEntitlements.trialDays || 7));
    params.append('subscription_data[metadata][user_id]', userId);
    params.append('subscription_data[metadata][plan_tier]', resolved.planTier);
    params.append('subscription_data[metadata][billing_interval]', resolved.billingInterval);
    params.append('success_url', successUrl || 'http://localhost:3000/pricing.html?checkout=success&session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', cancelUrl || 'http://localhost:3000/pricing.html?checkout=canceled');

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const sessionData = await response.json();
    if (!response.ok) {
      throw new Error(sessionData.error?.message || 'Failed to create Stripe Checkout Session');
    }
    return {
      mode: 'stripe_live',
      sessionId: sessionData.id,
      checkoutUrl: sessionData.url,
      planTier: resolved.planTier,
      billingInterval: resolved.billingInterval
    };
  }

  // Built-in Stripe Checkout & Webhook Provisioning Flow (for local/dev & instant testing)
  if (simulateImmediateActivation) {
    // Trigger 1: checkout.session.completed (starts 7-day trial & unlocks entitlements)
    processStripeWebhookEvent({
      id: 'evt_checkout_' + checkoutSessionId,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: checkoutSessionId,
          customer: customerId,
          subscription: stripeSubId,
          client_reference_id: userId,
          metadata: {
            user_id: userId,
            org_id: orgId || null,
            plan_tier: resolved.planTier,
            billing_interval: resolved.billingInterval
          }
        }
      }
    });

    // Trigger 2: invoice.paid (deposits initial monthly credit grant + first quarterly bonus)
    processStripeWebhookEvent({
      id: 'evt_inv_initial_' + stripeSubId,
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_' + crypto.randomBytes(8).toString('hex'),
          customer: customerId,
          subscription: stripeSubId,
          billing_reason: 'subscription_create',
          amount_paid: resolved.priceConfig.unitAmountCents,
          lines: {
            data: [
              {
                price: {
                  id: resolved.priceConfig.priceId,
                  recurring: { interval: resolved.billingInterval }
                }
              }
            ]
          }
        }
      }
    });
  }

  const redirectUrl = successUrl || `/pricing.html?checkout=success&plan=${resolved.planTier}&interval=${resolved.billingInterval}&session_id=${checkoutSessionId}`;

  return {
    mode: 'stripe_simulated',
    sessionId: checkoutSessionId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSubId,
    checkoutUrl: redirectUrl,
    planTier: resolved.planTier,
    billingInterval: resolved.billingInterval,
    trialDays: planEntitlements.trialDays,
    priceUsd: resolved.priceConfig.displayMonthlyUsd,
    billedTotalUsd: resolved.priceConfig.unitAmountCents / 100
  };
}

/**
 * Create Stripe Customer Portal Session for self-service upgrades, downgrades, and "cancel anytime"
 */
async function createCustomerPortalSession({ userId, returnUrl }) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(userId);
  if (!sub) {
    throw new Error('No subscription found for this account.');
  }

  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
    const params = new URLSearchParams();
    params.append('customer', sub.stripe_customer_id);
    params.append('return_url', returnUrl || 'http://localhost:3000/pricing.html');

    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const portalData = await response.json();
    if (!response.ok) {
      throw new Error(portalData.error?.message || 'Failed to create Customer Portal session');
    }
    return {
      mode: 'stripe_live',
      portalUrl: portalData.url
    };
  }

  return {
    mode: 'stripe_simulated',
    portalSessionId: 'bps_' + crypto.randomBytes(8).toString('hex'),
    portalUrl: returnUrl || `/pricing.html?portal=open&sub=${sub.stripe_subscription_id}`,
    subscription: sub
  };
}

/**
 * Verify Stripe Webhook Signature (HMAC-SHA256)
 */
function verifyStripeSignature(rawBody, signatureHeader, webhookSecret) {
  if (!webhookSecret) return true; // Dev mode without secret
  if (!signatureHeader) {
    throw new Error('Missing Stripe-Signature header');
  }

  const parts = signatureHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  if (!parts.t || !parts.v1) {
    throw new Error('Invalid Stripe-Signature header format');
  }

  const payloadToSign = `${parts.t}.${typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)}`;
  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(payloadToSign, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expectedSig, 'hex');
  const receivedBuf = Buffer.from(parts.v1, 'hex');
  if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    throw new Error('Webhook signature verification failed');
  }

  return true;
}

/**
 * 3. Webhook Processing Engine with Idempotency Keys
 * Handles:
 * - checkout.session.completed
 * - invoice.paid
 * - invoice.payment_failed
 * - customer.subscription.updated
 * - customer.subscription.deleted
 */
function processStripeWebhookEvent(event) {
  if (!event || !event.id || !event.type) {
    throw new Error('Invalid Stripe webhook event payload: id and type are required.');
  }

  // Check idempotency table first
  const existingEvent = db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(event.id);
  if (existingEvent) {
    return {
      idempotentReplay: true,
      eventId: event.id,
      eventType: event.type,
      processedAt: existingEvent.processed_at
    };
  }

  const dataObject = event.data?.object || {};
  let resultSummary = {};

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = dataObject.client_reference_id || dataObject.metadata?.user_id || 'guest_session';
      const orgId = dataObject.metadata?.org_id || null;
      const resolved = resolvePlanFromInput({
        priceId: dataObject.price_id,
        planTier: dataObject.metadata?.plan_tier || 'growth',
        billingInterval: dataObject.metadata?.billing_interval || 'month'
      });

      const stripeCustomerId = dataObject.customer || ('cus_' + crypto.randomBytes(6).toString('hex'));
      const stripeSubscriptionId = dataObject.subscription || ('sub_' + crypto.randomBytes(8).toString('hex'));

      const now = new Date();
      const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const periodEnd = new Date(now);
      if (resolved.billingInterval === 'year') {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      // Cancel any old active subscriptions for this user before inserting/updating
      db.prepare(`
        UPDATE subscriptions SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND stripe_subscription_id != ?
      `).run(userId, stripeSubscriptionId);

      const subId = 'subrec_' + crypto.randomBytes(6).toString('hex');
      db.prepare(`
        INSERT INTO subscriptions (
          id, user_id, org_id, stripe_customer_id, stripe_subscription_id,
          plan_tier, billing_interval, status, trial_end,
          current_period_start, current_period_end, cancel_at_period_end,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'trialing', ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(stripe_subscription_id) DO UPDATE SET
          plan_tier = excluded.plan_tier,
          billing_interval = excluded.billing_interval,
          status = 'trialing',
          trial_end = excluded.trial_end,
          current_period_end = excluded.current_period_end,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        subId,
        userId,
        orgId,
        stripeCustomerId,
        stripeSubscriptionId,
        resolved.planTier,
        resolved.billingInterval,
        trialEnd.toISOString(),
        now.toISOString(),
        periodEnd.toISOString()
      );

      ensureWallet(userId, orgId);

      notify(
        'brand',
        userId,
        null,
        'subscription_trial_started',
        `${resolved.product.name} Plan 7-Day Free Trial Activated`,
        `Your ${resolved.product.name} (${resolved.billingInterval}ly) subscription is now trialing. Full plan entitlements are unlocked.`
      );

      resultSummary = {
        action: 'provisioned_trial_subscription',
        userId,
        planTier: resolved.planTier,
        billingInterval: resolved.billingInterval,
        stripeSubscriptionId,
        trialEnd: trialEnd.toISOString()
      };
      break;
    }

    case 'invoice.paid': {
      const stripeSubId = dataObject.subscription;
      const invoiceId = dataObject.id || ('in_' + crypto.randomBytes(6).toString('hex'));

      let sub = stripeSubId
        ? db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubId)
        : null;

      if (!sub && dataObject.customer) {
        sub = db.prepare('SELECT * FROM subscriptions WHERE stripe_customer_id = ? ORDER BY updated_at DESC LIMIT 1').get(dataObject.customer);
      }

      if (!sub && dataObject.user_id) {
        sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(dataObject.user_id);
      }

      if (!sub) {
        throw new Error(`Subscription not found for invoice ${invoiceId}`);
      }

      const planEntitlements = getPlanEntitlements(sub.plan_tier);
      const nowIso = new Date().toISOString();

      // Advance period end and mark active (or keep trialing if within trial window and initial invoice)
      const newStatus = dataObject.keep_trialing ? 'trialing' : 'active';
      const nextPeriodEnd = new Date();
      if (sub.billing_interval === 'year') {
        nextPeriodEnd.setFullYear(nextPeriodEnd.getFullYear() + 1);
      } else {
        nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);
      }

      // Grant Monthly Base Credits (370, 1,500, or 3,700)
      const monthlyGrant = grantCredits(
        sub.user_id,
        planEntitlements.monthlyCredits,
        'monthly_grant',
        invoiceId,
        `${planEntitlements.name} Plan monthly credit allocation (${planEntitlements.monthlyCredits} credits)`
      );

      // If this is the initial subscription creation or a quarterly boundary, also grant the quarterly bonus (+70, +210, +650)
      let quarterlyGrant = null;
      const shouldGrantQuarterly = !sub.last_quarterly_grant_at ||
        ((Date.now() - new Date(sub.last_quarterly_grant_at).getTime()) >= 85 * 24 * 60 * 60 * 1000);

      if (shouldGrantQuarterly && planEntitlements.quarterlyBonusCredits > 0) {
        quarterlyGrant = grantCredits(
          sub.user_id,
          planEntitlements.quarterlyBonusCredits,
          'quarterly_bonus',
          `${invoiceId}_qtr`,
          `${planEntitlements.name} Plan quarterly bonus (+${planEntitlements.quarterlyBonusCredits} free credits/qtr)`
        );
      }

      db.prepare(`
        UPDATE subscriptions
        SET status = ?,
            current_period_start = ?,
            current_period_end = ?,
            last_monthly_grant_at = ?,
            last_quarterly_grant_at = COALESCE(?, last_quarterly_grant_at),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        newStatus,
        nowIso,
        nextPeriodEnd.toISOString(),
        nowIso,
        quarterlyGrant ? nowIso : null,
        sub.id
      );

      notify(
        'brand',
        sub.user_id,
        null,
        'credits_deposited',
        `${planEntitlements.monthlyCredits + (quarterlyGrant ? planEntitlements.quarterlyBonusCredits : 0)} Credits Deposited`,
        `Invoice ${invoiceId} paid: +${planEntitlements.monthlyCredits} monthly credits${quarterlyGrant ? ` and +${planEntitlements.quarterlyBonusCredits} quarterly bonus credits` : ''} added to your wallet.`
      );

      resultSummary = {
        action: 'invoice_paid_credits_deposited',
        userId: sub.user_id,
        planTier: sub.plan_tier,
        monthlyCreditsGranted: planEntitlements.monthlyCredits,
        quarterlyBonusGranted: quarterlyGrant ? planEntitlements.quarterlyBonusCredits : 0,
        newBalance: (quarterlyGrant ? quarterlyGrant.wallet.balance : monthlyGrant.wallet.balance)
      };
      break;
    }

    case 'customer.subscription.updated': {
      const stripeSubId = dataObject.id;
      const sub = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubId);
      if (!sub) {
        throw new Error(`Subscription ${stripeSubId} not found for update`);
      }

      const incomingPriceId = dataObject.items?.data?.[0]?.price?.id || dataObject.price_id;
      const resolved = resolvePlanFromInput({
        priceId: incomingPriceId,
        planTier: dataObject.metadata?.plan_tier || dataObject.plan_tier || sub.plan_tier,
        billingInterval: dataObject.metadata?.billing_interval || dataObject.billing_interval || sub.billing_interval
      });

      const oldEntitlements = getPlanEntitlements(sub.plan_tier);
      const newEntitlements = getPlanEntitlements(resolved.planTier);
      const newStatus = dataObject.status || sub.status;
      const cancelAtPeriodEnd = dataObject.cancel_at_period_end ? 1 : 0;

      db.prepare(`
        UPDATE subscriptions
        SET plan_tier = ?,
            billing_interval = ?,
            status = ?,
            cancel_at_period_end = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(resolved.planTier, resolved.billingInterval, newStatus, cancelAtPeriodEnd, sub.id);

      // If upgrading mid-cycle to a higher tier, grant the prorated difference in monthly credits immediately
      let upgradeCreditDiff = 0;
      if (newEntitlements.monthlyCredits > oldEntitlements.monthlyCredits) {
        upgradeCreditDiff = newEntitlements.monthlyCredits - oldEntitlements.monthlyCredits;
        grantCredits(
          sub.user_id,
          upgradeCreditDiff,
          'monthly_grant',
          `upgrade_${event.id}`,
          `Mid-cycle upgrade credit top-up (${oldEntitlements.name} -> ${newEntitlements.name}: +${upgradeCreditDiff} credits)`
        );
      }

      resultSummary = {
        action: 'subscription_updated',
        userId: sub.user_id,
        previousTier: sub.plan_tier,
        newTier: resolved.planTier,
        billingInterval: resolved.billingInterval,
        status: newStatus,
        cancelAtPeriodEnd: Boolean(cancelAtPeriodEnd),
        upgradeCreditDiff
      };
      break;
    }

    case 'customer.subscription.deleted': {
      const stripeSubId = dataObject.id;
      const sub = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubId);
      if (!sub) {
        throw new Error(`Subscription ${stripeSubId} not found for deletion`);
      }

      db.prepare(`
        UPDATE subscriptions
        SET status = 'canceled', cancel_at_period_end = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sub.id);

      notify(
        'brand',
        sub.user_id,
        null,
        'subscription_canceled',
        'Subscription Canceled',
        `Your ${sub.plan_tier.toUpperCase()} subscription has been canceled.`
      );

      resultSummary = {
        action: 'subscription_canceled',
        userId: sub.user_id,
        stripeSubscriptionId: stripeSubId
      };
      break;
    }

    case 'invoice.payment_failed': {
      const stripeSubId = dataObject.subscription;
      const sub = db.prepare('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?').get(stripeSubId);
      if (!sub) {
        throw new Error(`Subscription ${stripeSubId} not found for failed payment`);
      }

      db.prepare(`
        UPDATE subscriptions
        SET status = 'past_due', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sub.id);

      notify(
        'brand',
        sub.user_id,
        null,
        'payment_failed',
        'Subscription Payment Failed',
        'We could not process your recurring payment. Please update your payment method in the Billing Portal to keep your plan active.'
      );

      resultSummary = {
        action: 'marked_past_due',
        userId: sub.user_id,
        stripeSubscriptionId: stripeSubId
      };
      break;
    }

    default:
      resultSummary = { action: 'ignored_unhandled_event_type', eventType: event.type };
  }

  // Record processed webhook event for idempotency
  db.prepare(`
    INSERT INTO webhook_events (id, provider, event_type, payload, status, processed_at)
    VALUES (?, 'stripe', ?, ?, 'processed', CURRENT_TIMESTAMP)
  `).run(event.id, event.type, JSON.stringify(event));

  return {
    idempotentReplay: false,
    eventId: event.id,
    eventType: event.type,
    result: resultSummary
  };
}

module.exports = {
  STRIPE_PRODUCTS,
  withTransaction,
  ensureWallet,
  grantCredits,
  consumeCredits,
  getPlanEntitlements,
  getAllPlansCatalog,
  resolvePlanFromInput,
  getUserBillingState,
  createCheckoutSession,
  createCustomerPortalSession,
  verifyStripeSignature,
  processStripeWebhookEvent
};
