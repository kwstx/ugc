/**
 * ============================================================================
 * Stripe Connect Integration Router
 * ============================================================================
 * 
 * This router demonstrates the end-to-end Stripe Connect workflow:
 * 1. Creating Connected Accounts using the Stripe V2 Accounts API
 *    (Platform is responsible for pricing and fee collection: fees_collector and losses_collector = 'application')
 * 2. Onboarding Connected Accounts using Stripe V2 Account Links
 * 3. Inspecting live account onboarding and readiness status directly from the Accounts API
 * 4. Listening for V2 Thin Webhook events (e.g., requirements and capability updates)
 * 5. Creating platform-level products mapped to connected accounts
 * 6. Storefront catalog of products and connected sellers
 * 7. Processing charges via Destination Charges with application fees using Hosted Checkout
 * 
 * All requests strictly use `stripeClient` and automatic API versioning.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const {
  stripeClient,
  checkStripeConfiguration,
  ensureStripeConfigured,
  STRIPE_WEBHOOK_SECRET
} = require('../services/stripeClient');

/**
 * Helper to build the base URL for redirects (Account Links, Checkout return/cancel URLs)
 */
function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
  return `${protocol}://${host}`;
}

// ============================================================================
// 1. CONFIGURATION & STATUS CHECK
// ============================================================================

/**
 * GET /api/connect/config
 * Returns the current configuration status of Stripe in the application.
 * Helpful for frontends to display setup banners or warnings if keys are missing.
 */
router.get('/config', (req, res) => {
  const config = checkStripeConfiguration();
  res.json({
    success: true,
    configured: config.isConfigured,
    message: config.message,
    webhookSecretConfigured: Boolean(STRIPE_WEBHOOK_SECRET && !STRIPE_WEBHOOK_SECRET.includes('PLACEHOLDER'))
  });
});

// ============================================================================
// 2. CREATING CONNECTED ACCOUNTS
// ============================================================================

/**
 * POST /api/connect/accounts
 * 
 * Creates a connected account using the Stripe V2 Core Accounts API.
 * The platform is responsible for pricing and fee collection:
 * - fees_collector: 'application'
 * - losses_collector: 'application'
 * 
 * IMPORTANT:
 * - Only the specified V2 properties are used.
 * - Never pass `type` at top level (Do NOT use top-level type: 'express' or 'standard' or 'custom').
 * - Maps the created Stripe account ID to the user record in the local database.
 */
router.post('/accounts', async (req, res) => {
  try {
    // Step A: Ensure Stripe API credentials are valid
    ensureStripeConfigured();

    const { displayName, email, userId } = req.body || {};

    // Validate user input
    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ success: false, error: 'displayName is required.' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, error: 'email is required.' });
    }

    const resolvedUserId = (userId && String(userId).trim()) || `usr_${crypto.randomBytes(6).toString('hex')}`;

    console.log(`[Stripe Connect] Creating V2 Connected Account for ${displayName} (${email})...`);

    // Step B: Create connected account via Stripe V2 Accounts API
    // Strictly adhere to the required V2 configuration parameters:
    const account = await stripeClient.v2.core.accounts.create({
      display_name: displayName.trim(),
      contact_email: email.trim(),
      identity: {
        country: 'us',
      },
      dashboard: 'express',
      defaults: {
        responsibilities: {
          fees_collector: 'application',
          losses_collector: 'application',
        },
      },
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: {
              stripe_transfers: {
                requested: true,
              },
            },
          },
        },
      },
    });

    console.log(`[Stripe Connect] Successfully created V2 Connected Account: ${account.id}`);

    // Step C: Persist mapping between our platform user and the Stripe Account ID in the database
    db.prepare(`
      INSERT OR REPLACE INTO connect_accounts (id, user_id, display_name, email, country, dashboard, updated_at)
      VALUES (?, ?, ?, ?, 'us', 'express', CURRENT_TIMESTAMP)
    `).run(account.id, resolvedUserId, displayName.trim(), email.trim());

    // Optional: Also link to creators table if user exists as a creator
    try {
      db.prepare(`
        UPDATE creators
        SET stripe_account_id = ?, stripe_connected = 1
        WHERE id = ? OR email = ?
      `).run(account.id, resolvedUserId, email.trim());
    } catch (e) {
      // Non-fatal if creator row doesn't exist
    }

    res.json({
      success: true,
      account: {
        id: account.id,
        displayName: account.display_name,
        contactEmail: account.contact_email,
        userId: resolvedUserId,
        created: account.created
      }
    });
  } catch (err) {
    console.error('[Stripe Connect] Error creating connected account:', err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      code: err.code || 'ACCOUNT_CREATION_FAILED'
    });
  }
});

// ============================================================================
// 3. ONBOARDING CONNECTED ACCOUNTS & ACCOUNT STATUS
// ============================================================================

/**
 * POST /api/connect/accounts/:accountId/onboard
 * 
 * Generates an Account Link via the V2 Account Links API.
 * Redirects the connected user to the Stripe Express onboarding flow.
 */
router.post('/accounts/:accountId/onboard', async (req, res) => {
  try {
    ensureStripeConfigured();

    const { accountId } = req.params;
    if (!accountId || !accountId.startsWith('acct_')) {
      return res.status(400).json({ success: false, error: 'A valid Stripe Account ID starting with "acct_" is required.' });
    }

    const baseUrl = getBaseUrl(req);
    const refreshUrl = `${baseUrl}/connect/onboard_refresh.html?accountId=${encodeURIComponent(accountId)}`;
    const returnUrl = `${baseUrl}/connect/onboard_complete.html?accountId=${encodeURIComponent(accountId)}`;

    console.log(`[Stripe Connect] Creating V2 Account Link for onboarding: ${accountId}`);

    // Create the V2 Account Link using the account_onboarding use_case
    const accountLink = await stripeClient.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['recipient'],
          refresh_url: refreshUrl,
          return_url: returnUrl,
        },
      },
    });

    res.json({
      success: true,
      accountId,
      url: accountLink.url
    });
  } catch (err) {
    console.error('[Stripe Connect] Error creating account link:', err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      code: err.code || 'ACCOUNT_LINK_CREATION_FAILED'
    });
  }
});

/**
 * GET /api/connect/accounts/:accountId/status
 * 
 * Inspects onboarding status directly from the Stripe V2 Accounts API.
 * As requested, this endpoint NEVER reads status from the local database —
 * it always retrieves live state from Stripe directly.
 * 
 * Computes:
 * - readyToReceivePayments: whether transfers capability is active
 * - requirementsStatus: status of minimum deadline requirements
 * - onboardingComplete: true if not currently_due or past_due
 */
router.get('/accounts/:accountId/status', async (req, res) => {
  try {
    ensureStripeConfigured();

    const { accountId } = req.params;
    if (!accountId || !accountId.startsWith('acct_')) {
      return res.status(400).json({ success: false, error: 'A valid Stripe Account ID (acct_...) is required.' });
    }

    // Step A: Retrieve live account state directly from the Stripe V2 API
    const account = await stripeClient.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.recipient", "requirements"],
    });

    // Step B: Calculate capability and requirement readiness flags
    const readyToReceivePayments = account?.configuration
      ?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";

    const requirementsStatus =
      account.requirements?.summary?.minimum_deadline?.status;

    const onboardingComplete =
      requirementsStatus !== "currently_due" && requirementsStatus !== "past_due";

    res.json({
      success: true,
      accountId: account.id,
      displayName: account.display_name,
      contactEmail: account.contact_email,
      readyToReceivePayments: Boolean(readyToReceivePayments),
      onboardingComplete: Boolean(onboardingComplete),
      requirementsStatus: requirementsStatus || 'none',
      details: {
        capabilities: account.configuration?.recipient?.capabilities || {},
        requirementsSummary: account.requirements?.summary || {},
        minimumDeadline: account.requirements?.summary?.minimum_deadline || null
      }
    });
  } catch (err) {
    console.error(`[Stripe Connect] Error retrieving live status for ${req.params.accountId}:`, err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      code: err.code || 'ACCOUNT_STATUS_RETRIEVAL_FAILED'
    });
  }
});

/**
 * GET /api/connect/accounts
 * 
 * Returns all connected accounts stored in the platform database,
 * along with their live Stripe API status.
 */
router.get('/accounts', async (req, res) => {
  try {
    const accounts = db.prepare(`
      SELECT * FROM connect_accounts ORDER BY created_at DESC
    `).all();

    const config = checkStripeConfiguration();

    // If Stripe is configured, enrich each account with live status from the Stripe API
    let enriched = [];
    if (config.isConfigured) {
      enriched = await Promise.all(
        accounts.map(async (acc) => {
          try {
            const liveAccount = await stripeClient.v2.core.accounts.retrieve(acc.id, {
              include: ["configuration.recipient", "requirements"],
            });
            const readyToReceivePayments = liveAccount?.configuration
              ?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
            const requirementsStatus =
              liveAccount.requirements?.summary?.minimum_deadline?.status;
            const onboardingComplete =
              requirementsStatus !== "currently_due" && requirementsStatus !== "past_due";

            return {
              ...acc,
              live: {
                readyToReceivePayments: Boolean(readyToReceivePayments),
                onboardingComplete: Boolean(onboardingComplete),
                requirementsStatus: requirementsStatus || 'none'
              }
            };
          } catch (apiErr) {
            return {
              ...acc,
              liveError: apiErr.message,
              live: {
                readyToReceivePayments: false,
                onboardingComplete: false,
                requirementsStatus: 'error_retrieving'
              }
            };
          }
        })
      );
    } else {
      enriched = accounts.map(acc => ({
        ...acc,
        live: {
          readyToReceivePayments: false,
          onboardingComplete: false,
          requirementsStatus: 'api_unconfigured'
        }
      }));
    }

    res.json({
      success: true,
      configured: config.isConfigured,
      accounts: enriched
    });
  } catch (err) {
    console.error('[Stripe Connect] Error listing accounts:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 4. CREATING PLATFORM PRODUCTS
// ============================================================================

/**
 * POST /api/connect/products
 * 
 * Creates a product at the PLATFORM level using the Stripe Products API.
 * The product is created on the platform account (not on the connected account).
 * The mapping to the destination connected account is stored in:
 * - Product metadata (`metadata: { connected_account_id }`)
 * - The platform database table (`connect_products`)
 */
router.post('/products', async (req, res) => {
  try {
    ensureStripeConfigured();

    const { name, description, priceInCents, currency = 'usd', connectedAccountId } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Product name is required.' });
    }
    const unitAmount = parseInt(priceInCents, 10);
    if (isNaN(unitAmount) || unitAmount <= 0) {
      return res.status(400).json({ success: false, error: 'A positive priceInCents is required (e.g., 2900 for $29.00).' });
    }
    if (!connectedAccountId || !connectedAccountId.startsWith('acct_')) {
      return res.status(400).json({ success: false, error: 'A valid connectedAccountId (acct_...) is required to assign product proceeds.' });
    }

    console.log(`[Stripe Products] Creating platform product "${name}" mapped to seller ${connectedAccountId}...`);

    // Step A: Create product in Stripe using the platform Products API
    const product = await stripeClient.products.create({
      name: name.trim(),
      description: description ? description.trim() : undefined,
      default_price_data: {
        unit_amount: unitAmount,
        currency: currency.toLowerCase(),
      },
      metadata: {
        connected_account_id: connectedAccountId,
      },
    });

    console.log(`[Stripe Products] Created product: ${product.id} (Price: ${product.default_price})`);

    // Step B: Persist mapping in the local database
    db.prepare(`
      INSERT INTO connect_products (id, name, description, price_in_cents, currency, connected_account_id, stripe_price_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      product.id,
      name.trim(),
      description ? description.trim() : '',
      unitAmount,
      currency.toLowerCase(),
      connectedAccountId,
      typeof product.default_price === 'string' ? product.default_price : (product.default_price?.id || null)
    );

    res.json({
      success: true,
      product: {
        id: product.id,
        name: product.name,
        description: product.description,
        priceInCents: unitAmount,
        currency: currency.toLowerCase(),
        connectedAccountId,
        defaultPrice: product.default_price
      }
    });
  } catch (err) {
    console.error('[Stripe Products] Error creating product:', err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      code: err.code || 'PRODUCT_CREATION_FAILED'
    });
  }
});

/**
 * GET /api/connect/products
 * 
 * Returns all products created on the platform, joining their mapped connected seller account.
 */
router.get('/products', (req, res) => {
  try {
    const products = db.prepare(`
      SELECT 
        p.*, 
        a.display_name as seller_name, 
        a.email as seller_email
      FROM connect_products p
      LEFT JOIN connect_accounts a ON p.connected_account_id = a.id
      ORDER BY p.created_at DESC
    `).all();

    res.json({
      success: true,
      products
    });
  } catch (err) {
    console.error('[Stripe Products] Error listing products:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 5. PROCESSING CHARGES (DESTINATION CHARGES WITH APPLICATION FEES)
// ============================================================================

/**
 * POST /api/connect/checkout
 * 
 * Initiates a Stripe Hosted Checkout Session using a Destination Charge:
 * - Customers pay the platform.
 * - Platform collects an application fee (`application_fee_amount`).
 * - Remaining funds automatically transfer to the connected seller account (`transfer_data: { destination: accountId }`).
 */
router.post('/checkout', async (req, res) => {
  try {
    ensureStripeConfigured();

    const { productId, quantity = 1, feePercentage = 10 } = req.body || {};

    if (!productId) {
      return res.status(400).json({ success: false, error: 'productId is required.' });
    }

    // Retrieve product details and connected account destination from database
    const product = db.prepare('SELECT * FROM connect_products WHERE id = ?').get(productId);
    if (!product) {
      return res.status(404).json({ success: false, error: `Product not found with id ${productId}` });
    }

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const subtotalCents = product.price_in_cents * qty;

    // Calculate application fee (default: 10% platform take)
    const feePct = Math.min(100, Math.max(0, parseFloat(feePercentage) || 10));
    const applicationFeeAmount = Math.round((subtotalCents * feePct) / 100);

    const baseUrl = getBaseUrl(req);
    const successUrl = `${baseUrl}/connect/success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/connect/storefront.html?canceled=true`;

    console.log(`[Stripe Checkout] Creating Destination Charge session for product ${product.name}:`);
    console.log(`  Destination: ${product.connected_account_id}`);
    console.log(`  Subtotal: $${(subtotalCents / 100).toFixed(2)}`);
    console.log(`  Application Fee: $${(applicationFeeAmount / 100).toFixed(2)}`);

    // Create the Stripe Checkout session with Destination Charge
    const session = await stripeClient.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: product.currency || 'usd',
            unit_amount: product.price_in_cents,
            product_data: {
              name: product.name,
              description: product.description || undefined,
            },
          },
          quantity: qty,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFeeAmount,
        transfer_data: {
          destination: product.connected_account_id,
        },
      },
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        product_id: product.id,
        connected_account_id: product.connected_account_id,
        application_fee_cents: String(applicationFeeAmount)
      }
    });

    // Record order in local database
    db.prepare(`
      INSERT INTO connect_orders (id, product_id, connected_account_id, amount_cents, application_fee_cents, currency, quantity, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
    `).run(
      session.id,
      product.id,
      product.connected_account_id,
      subtotalCents,
      applicationFeeAmount,
      product.currency || 'usd',
      qty
    );

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });
  } catch (err) {
    console.error('[Stripe Checkout] Error creating checkout session:', err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message,
      code: err.code || 'CHECKOUT_CREATION_FAILED'
    });
  }
});

/**
 * GET /api/connect/checkout/session/:sessionId
 * 
 * Retrieves details for a completed or pending checkout session,
 * expanding payment_intent to verify destination transfer and application fee.
 */
router.get('/checkout/session/:sessionId', async (req, res) => {
  try {
    ensureStripeConfigured();

    const { sessionId } = req.params;
    if (!sessionId || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ success: false, error: 'Invalid checkout session ID (must start with cs_).' });
    }

    const session = await stripeClient.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'line_items'],
    });

    // Update local order status if paid
    if (session.payment_status === 'paid') {
      db.prepare(`
        UPDATE connect_orders
        SET status = 'paid', payment_intent_id = ?, customer_email = ?
        WHERE id = ?
      `).run(
        typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
        session.customer_details?.email || null,
        sessionId
      );
    }

    // Enrich with database product / seller info
    const orderRecord = db.prepare('SELECT * FROM connect_orders WHERE id = ?').get(sessionId);
    let sellerInfo = null;
    let productInfo = null;

    if (orderRecord) {
      sellerInfo = db.prepare('SELECT * FROM connect_accounts WHERE id = ?').get(orderRecord.connected_account_id);
      productInfo = db.prepare('SELECT * FROM connect_products WHERE id = ?').get(orderRecord.product_id);
    }

    res.json({
      success: true,
      session: {
        id: session.id,
        paymentStatus: session.payment_status,
        status: session.status,
        amountTotal: session.amount_total,
        currency: session.currency,
        customerEmail: session.customer_details?.email,
        paymentIntent: session.payment_intent
      },
      order: orderRecord,
      seller: sellerInfo,
      product: productInfo
    });
  } catch (err) {
    console.error('[Stripe Checkout] Error retrieving session:', err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================================================
// 6. THIN WEBHOOK LISTENER FOR REQUIREMENTS & CAPABILITY CHANGES
// ============================================================================

/**
 * POST /api/connect/webhook
 * 
 * Listens for V2 Thin Events forwarded from Stripe (e.g. via Stripe CLI or Dashboard).
 * Thin events contain a lightweight notification payload with an event ID.
 * The handler verifies the notification, then retrieves the full event data via:
 * `await stripeClient.v2.core.events.retrieve(thinEvent.id)`
 * 
 * Key event types handled:
 * - v2.core.account[requirements].updated
 * - v2.core.account[.recipient].capability_status_updated
 */
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = STRIPE_WEBHOOK_SECRET;

  try {
    // Step A: Parse and verify the Thin Event notification
    // Note: rawBody is preserved in server.js verify middleware
    const payload = req.rawBody || req.body;

    let thinEvent;
    if (webhookSecret && !webhookSecret.includes('PLACEHOLDER') && sig) {
      // Use client.parseThinEvent (delegates to SDK's parseEventNotification)
      thinEvent = stripeClient.parseThinEvent(payload, sig, webhookSecret);
    } else {
      // If webhook secret is not set, allow parsing payload directly for local development testing
      console.warn('[Stripe Webhook] Notice: Signature verification bypassed because STRIPE_WEBHOOK_SECRET is not configured.');
      thinEvent = typeof payload === 'string' ? JSON.parse(payload) : payload;
    }

    console.log(`[Stripe Webhook] Received Thin Event Notification. ID: ${thinEvent.id}`);

    // Step B: Retrieve the full event data from the Stripe V2 Core API
    let fullEvent;
    try {
      fullEvent = await stripeClient.v2.core.events.retrieve(thinEvent.id);
    } catch (retrieveErr) {
      console.warn(`[Stripe Webhook] Could not retrieve full event via API (${retrieveErr.message}). Using notification body fallback.`);
      fullEvent = thinEvent;
    }

    const eventType = fullEvent.type || thinEvent.type;
    console.log(`[Stripe Webhook] Processing full V2 Event: ${eventType} (${fullEvent.id || thinEvent.id})`);

    // Step C: Dispatch handler based on event.type
    switch (eventType) {
      case 'v2.core.account[requirements].updated': {
        const accountId = fullEvent.related_object?.id || fullEvent.context?.account;
        console.log(`[Stripe Webhook] Requirements updated for account: ${accountId}`);
        console.log(`  Details:`, JSON.stringify(fullEvent.data || {}));
        // Respond to update events by noting requirements changes
        break;
      }

      case 'v2.core.account[.recipient].capability_status_updated': {
        const accountId = fullEvent.related_object?.id || fullEvent.context?.account;
        console.log(`[Stripe Webhook] Capability status updated for recipient account: ${accountId}`);
        console.log(`  Details:`, JSON.stringify(fullEvent.data || {}));
        break;
      }

      default:
        console.log(`[Stripe Webhook] Handled general V2 event: ${eventType}`);
        break;
    }

    // Step D: Store event in connect_webhook_logs table for UI inspection
    try {
      db.prepare(`
        INSERT OR REPLACE INTO connect_webhook_logs (id, type, related_account_id, payload, received_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        fullEvent.id || thinEvent.id,
        eventType,
        fullEvent.related_object?.id || fullEvent.context?.account || null,
        JSON.stringify(fullEvent)
      );
    } catch (dbErr) {
      console.warn('[Stripe Webhook] Note saving event to database:', dbErr.message);
    }

    // Acknowledge receipt to Stripe
    res.json({
      received: true,
      eventId: fullEvent.id || thinEvent.id,
      type: eventType,
      handled: true
    });
  } catch (err) {
    console.error('[Stripe Webhook] Webhook error:', err.message);
    res.status(400).json({
      received: false,
      error: `Webhook Error: ${err.message}`
    });
  }
});

/**
 * GET /api/connect/webhook/logs
 * 
 * Returns the recent Thin Webhook events received by this application.
 * Makes it easy to test and verify webhook delivery from the UI.
 */
router.get('/webhook/logs', (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT * FROM connect_webhook_logs ORDER BY received_at DESC LIMIT 30
    `).all();

    const parsedLogs = logs.map(l => {
      let parsed = null;
      try {
        parsed = JSON.parse(l.payload);
      } catch (e) {}
      return {
        ...l,
        parsed
      };
    });

    res.json({
      success: true,
      logs: parsedLogs
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
