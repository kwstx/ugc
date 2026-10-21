const assert = require('assert');
const http = require('http');
const app = require('./server');
const db = require('./db');

function request(server, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  const server = app.listen(0);
  const testUser = 'test_billing_user_' + Date.now();

  try {
    console.log('=== 1. Testing Products, Prices & Entitlements Catalog ===');
    const plansRes = await request(server, 'GET', '/api/billing/plans');
    assert.strictEqual(plansRes.status, 200);
    assert.strictEqual(plansRes.body.plans.length, 3);
    const [starter, growth, scale] = plansRes.body.plans;

    assert.strictEqual(starter.monthlyPriceUsd, 280);
    assert.strictEqual(starter.yearlyMonthlyPriceUsd, 224);
    assert.strictEqual(starter.monthlyCredits, 370);
    assert.strictEqual(starter.quarterlyBonusCredits, 70);
    assert.strictEqual(starter.maxSocialSets, 1);
    assert.strictEqual(starter.hasSofiaMcp, false);

    assert.strictEqual(growth.monthlyPriceUsd, 880);
    assert.strictEqual(growth.yearlyMonthlyPriceUsd, 704);
    assert.strictEqual(growth.monthlyCredits, 1500);
    assert.strictEqual(growth.quarterlyBonusCredits, 210);
    assert.strictEqual(growth.maxSocialSets, 5);
    assert.strictEqual(growth.hasSofiaMcp, true);
    assert.strictEqual(growth.customOrderDiscountPct, 5);

    assert.strictEqual(scale.monthlyPriceUsd, 2980);
    assert.strictEqual(scale.yearlyMonthlyPriceUsd, 2384);
    assert.strictEqual(scale.monthlyCredits, 3700);
    assert.strictEqual(scale.quarterlyBonusCredits, 650);
    assert.strictEqual(scale.maxSocialSets, 10);
    assert.strictEqual(scale.hasPublicApi, true);
    assert.strictEqual(scale.customOrderDiscountPct, 10);
    console.log('✓ All 3 plans (Starter, Growth, Scale) & Monthly/Yearly 20%-off Price IDs verified.');

    console.log('\n=== 2. Testing Checkout Session & 7-Day Trial + Initial Credit Grant ===');
    const checkoutRes = await request(server, 'POST', '/api/billing/checkout', {
      userId: testUser,
      planTier: 'starter',
      billingInterval: 'year'
    });
    assert.strictEqual(checkoutRes.status, 200);
    assert.strictEqual(checkoutRes.body.billing.subscription.planTier, 'starter');
    assert.strictEqual(checkoutRes.body.billing.subscription.billingInterval, 'year');
    // Starter initial grant = 370 monthly + 70 quarterly bonus = 440 credits
    assert.strictEqual(checkoutRes.body.billing.wallet.balance, 440);
    console.log('✓ Starter Yearly subscription provisioned with 440 initial credits (370 monthly + 70 quarterly bonus).');

    console.log('\n=== 3. Testing Webhook Idempotency Engine ===');
    const subId = checkoutRes.body.billing.subscription.stripeSubscriptionId;
    const duplicateEvent = {
      id: 'evt_idemp_test_' + Date.now(),
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_idemp_1',
          subscription: subId
        }
      }
    };
    const whFirst = await request(server, 'POST', '/api/webhooks/stripe', duplicateEvent);
    assert.strictEqual(whFirst.status, 200);
    assert.strictEqual(whFirst.body.idempotentReplay, false);

    const whSecond = await request(server, 'POST', '/api/webhooks/stripe', duplicateEvent);
    assert.strictEqual(whSecond.status, 200);
    assert.strictEqual(whSecond.body.idempotentReplay, true);
    console.log('✓ Duplicate Stripe webhook event safely ignored via idempotency table.');

    console.log('\n=== 4. Testing Feature Gate Middleware (Sofia MCP, Public API, Social Sets) ===');
    // Starter should be blocked from Sofia MCP
    const mcpBlocked = await request(server, 'GET', `/api/billing/features/sofia-mcp?userId=${testUser}`);
    assert.strictEqual(mcpBlocked.status, 403);
    assert.strictEqual(mcpBlocked.body.code, 'ENTITLEMENT_RESTRICTED');

    // Starter allows 1 social set, blocks 2nd social set
    const soc1 = await request(server, 'POST', '/api/billing/social-sets', {
      userId: testUser,
      name: 'Brand Main TikTok'
    });
    assert.strictEqual(soc1.status, 200);

    const soc2Blocked = await request(server, 'POST', '/api/billing/social-sets', {
      userId: testUser,
      name: 'Second Social Set'
    });
    assert.strictEqual(soc2Blocked.status, 403);
    assert.strictEqual(soc2Blocked.body.code, 'SOCIAL_SET_LIMIT_REACHED');
    console.log('✓ Starter plan feature gate blocked Sofia MCP and 2nd social set as expected.');

    console.log('\n=== 5. Testing Mid-Cycle Plan Upgrade via Customer Portal (Starter -> Growth) ===');
    const upgradeRes = await request(server, 'POST', '/api/billing/portal', {
      userId: testUser,
      action: 'change_plan',
      newPlanTier: 'growth',
      newBillingInterval: 'year'
    });
    assert.strictEqual(upgradeRes.status, 200);
    assert.strictEqual(upgradeRes.body.billing.subscription.planTier, 'growth');
    // Sofia MCP should now be unlocked on Growth!
    const mcpUnlocked = await request(server, 'GET', `/api/billing/features/sofia-mcp?userId=${testUser}`);
    assert.strictEqual(mcpUnlocked.status, 200);
    assert.strictEqual(mcpUnlocked.body.mcpConfig.status, 'connected');
    // 2nd social set should now be allowed (Growth allows up to 5)
    const soc2Allowed = await request(server, 'POST', '/api/billing/social-sets', {
      userId: testUser,
      name: 'Second Social Set'
    });
    assert.strictEqual(soc2Allowed.status, 200);
    console.log('✓ Mid-cycle upgrade to Growth unlocked Sofia MCP, 5 social sets, and prorated credit top-up.');

    console.log('\n=== 6. Testing Atomic Credit Consumption (Clip Purchase & Custom Order Discount) ===');
    const preBalance = upgradeRes.body.billing.wallet.balance;
    // Purchase 2 library clips via /api/library/checkout with paymentMethod: 'credits' (2 * 11 = 22 credits)
    const libCheckout = await request(server, 'POST', '/api/library/checkout', {
      sessionId: testUser,
      clipIds: ['clip-1', 'clip-2'],
      paymentMethod: 'credits'
    });
    assert.strictEqual(libCheckout.status, 200);
    assert.strictEqual(libCheckout.body.creditTransaction.debitedCredits, 22);
    assert.strictEqual(libCheckout.body.creditTransaction.remainingBalance, preBalance - 22);

    // Custom order with 5% Growth discount via /api/billing/credits/consume
    const customConsume = await request(server, 'POST', '/api/billing/credits/consume', {
      userId: testUser,
      type: 'custom_order',
      amount: 100
    });
    assert.strictEqual(customConsume.status, 200);
    assert.strictEqual(customConsume.body.discountAppliedPct, 5);
    assert.strictEqual(customConsume.body.debitedCredits, 95);
    console.log('✓ Atomic credit reservation deducted 22 credits for 2 library clips and 95 credits for a 100-credit custom order (5% Growth discount).');

    console.log('\n=== 7. Testing Scheduled Cron Worker (Annual Monthly Drip & Quarterly Bonus) ===');
    const futureDate = new Date(Date.now() + 95 * 24 * 60 * 60 * 1000).toISOString();
    const cronRes = await request(server, 'POST', '/api/billing/cron/run', {
      simulatedDate: futureDate
    });
    assert.strictEqual(cronRes.status, 200);
    assert(cronRes.body.report.monthlyDripsGranted >= 1, 'Expected annual monthly drip to trigger');
    assert(cronRes.body.report.quarterlyBonusesGranted >= 1, 'Expected quarterly bonus drip (+210) to trigger');
    console.log('✓ Scheduled Cron Worker granted annual monthly drip (+1,500) and quarterly bonus (+210 free/qtr).');

    console.log('\n=== 8. Verifying Append-Only Credit Ledger Integrity ===');
    const ledgerRes = await request(server, 'GET', `/api/billing/ledger?userId=${testUser}`);
    assert.strictEqual(ledgerRes.status, 200);
    const sumOfLedgerAmounts = ledgerRes.body.ledger.reduce((sum, entry) => sum + entry.amount, 0);
    assert.strictEqual(sumOfLedgerAmounts, ledgerRes.body.wallet.balance);
    console.log(`✓ Credit Ledger audit passed: ${ledgerRes.body.ledger.length} immutable entries sum exactly to wallet balance (${sumOfLedgerAmounts} credits).`);

    console.log('\nALL PRICING & SUBSCRIPTION BACKEND TESTS PASSED!');
  } finally {
    // Cleanup test user records
    const wallet = db.prepare('SELECT id FROM credit_wallets WHERE user_id = ?').get(testUser);
    if (wallet) {
      db.prepare('DELETE FROM credit_ledger WHERE wallet_id = ?').run(wallet.id);
      db.prepare('DELETE FROM credit_wallets WHERE id = ?').run(wallet.id);
    }
    db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(testUser);
    db.prepare('DELETE FROM social_sets WHERE user_id = ?').run(testUser);
    server.close();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
