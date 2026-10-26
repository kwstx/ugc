/**
 * ============================================================================
 * Stripe Client Configuration & Helper Module
 * ============================================================================
 * 
 * This module initializes and exports a single, centralized `stripeClient` instance
 * used for all Stripe-related requests across the application.
 * 
 * Requirements handled:
 * 1. Single `stripeClient` initialized using `new Stripe('sk_***')`.
 * 2. Does NOT override or manually specify the stripe version, allowing the
 *    preview/default version (e.g. `2026-09-30.endive`) to be set automatically by the SDK.
 * 3. Provides placeholder comments and helpful, user-friendly errors when
 *    the secret key or webhook secret is missing or unconfigured.
 * 4. Includes compatibility helpers for thin event handling (`parseThinEvent`).
 */

const Stripe = require('stripe');
require('dotenv').config();

// ============================================================================
// STRIPE API KEY PLACEHOLDER & CONFIGURATION
// ============================================================================
// Replace the placeholder below with your real Stripe Secret Key,
// or provide STRIPE_SECRET_KEY in your environment (.env file).
// Test keys start with `sk_test_...` and live keys start with `sk_live_...`.
// You can find your keys at: https://dashboard.stripe.com/test/apikeys
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_PLACEHOLDER_ENTER_YOUR_STRIPE_SECRET_KEY';

// PLACEHOLDER: Enter your Stripe Webhook Signing Secret (e.g. whsec_...)
// Obtained from `stripe listen` CLI output or the Stripe Dashboard Webhooks section.
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_PLACEHOLDER_ENTER_YOUR_WEBHOOK_SECRET';

/**
 * Checks whether the configured Stripe Secret Key is a valid key or still a placeholder.
 * 
 * @returns {{ isConfigured: boolean, message: string }}
 */
function checkStripeConfiguration() {
  if (!STRIPE_SECRET_KEY || STRIPE_SECRET_KEY.trim() === '') {
    return {
      isConfigured: false,
      message: 'STRIPE_SECRET_KEY is empty. Please set your Stripe Secret Key (e.g. sk_test_...) in your .env file or environment variables.'
    };
  }

  if (STRIPE_SECRET_KEY.includes('PLACEHOLDER')) {
    return {
      isConfigured: false,
      message: 'STRIPE_SECRET_KEY is still set to the default placeholder. Please update it in your .env file with your actual secret key from https://dashboard.stripe.com/test/apikeys'
    };
  }

  if (!STRIPE_SECRET_KEY.startsWith('sk_test_') && !STRIPE_SECRET_KEY.startsWith('sk_live_')) {
    return {
      isConfigured: false,
      message: `STRIPE_SECRET_KEY appears invalid (keys start with "sk_test_" or "sk_live_"). Current value starts with: "${STRIPE_SECRET_KEY.slice(0, 7)}..."`
    };
  }

  return {
    isConfigured: true,
    message: 'Stripe Secret Key is configured and ready.'
  };
}

/**
 * Helper guard that throws an informative HTTP 500 / Error if Stripe credentials
 * are missing or unconfigured when an API route is invoked.
 */
function ensureStripeConfigured() {
  const check = checkStripeConfiguration();
  if (!check.isConfigured) {
    const error = new Error(`[Stripe Configuration Error]: ${check.message}`);
    error.status = 500;
    error.code = 'STRIPE_NOT_CONFIGURED';
    throw error;
  }
}

/**
 * Step 1: Initialize the centralized Stripe Client
 * Notice: We do NOT pass apiVersion here so the SDK automatically uses
 * the latest preview / default API version (e.g. 2026-09-30.endive).
 */
const stripeClient = new Stripe(STRIPE_SECRET_KEY);

/**
 * Step 2: Ensure `parseThinEvent` is available on `stripeClient`.
 * 
 * The Stripe V2 API uses "Thin Events", where webhook notification payloads contain
 * minimal data (e.g., event ID, type, and resource identifier) rather than large nested objects.
 * In the Stripe Node SDK, thin event notifications are parsed via `parseEventNotification`.
 * We provide `parseThinEvent` as an alias on `stripeClient` to match documentation conventions.
 */
if (typeof stripeClient.parseThinEvent !== 'function') {
  stripeClient.parseThinEvent = function (payload, header, secret, tolerance) {
    // If stripeClient is not configured, throw descriptive error
    if (!secret || secret.includes('PLACEHOLDER')) {
      console.warn('[Stripe Webhook] Webhook secret is unconfigured or a placeholder.');
    }
    // parseEventNotification verifies signature and constructs the thin event notification
    return this.parseEventNotification(payload, header, secret, tolerance);
  };
}

module.exports = {
  stripeClient,
  checkStripeConfiguration,
  ensureStripeConfigured,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET
};
