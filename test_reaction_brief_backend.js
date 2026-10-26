const http = require('http');
const assert = require('assert');
const app = require('./server');

const TEST_PORT = 3009;
const RUN_SESSION_ID = 'test_session_reaction_' + Date.now();

function request(path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'Content-Type': 'application/json',
      'x-session-id': RUN_SESSION_ID,
      ...headers
    };

    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers: defaultHeaders
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, ...parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

const server = app.listen(TEST_PORT, async () => {
  console.log(`[Reaction Brief Backend Test] Server started on port ${TEST_PORT}...\n`);

  try {
    // =========================================================================
    // 1. Unified Draft Order State: Persist selections from creators & order pages
    // =========================================================================
    console.log('--- 1. Testing Unified Draft Order State ---');
    const draftPayload = {
      format: 'reaction',
      creatorIds: ['franci', 'emilia'],
      qty: 6,
      turnaroundHours: 48,
      layoutPreference: 'split_screen'
    };

    const saveDraftRes = await request('/api/orders/draft', 'POST', draftPayload);
    assert.strictEqual(saveDraftRes.success, true, 'Saving draft order must succeed');
    assert.ok(saveDraftRes.orderId, 'Draft order ID must be generated or assigned');
    assert.strictEqual(saveDraftRes.draft.formatKey, 'reaction');
    assert.deepStrictEqual(saveDraftRes.draft.creatorIds, ['franci', 'emilia']);
    assert.strictEqual(saveDraftRes.draft.qty, 6);
    assert.strictEqual(saveDraftRes.draft.prerequisitesCompleted, true);
    const orderId = saveDraftRes.orderId;
    console.log(`✔ 1a. Unified draft order created & persisted to DB: ${orderId}`);

    // Retrieve draft order
    const getDraftRes = await request('/api/orders/draft?format=reaction', 'GET');
    assert.strictEqual(getDraftRes.success, true);
    assert.strictEqual(getDraftRes.draft.id, orderId);
    assert.strictEqual(getDraftRes.draft.turnaroundHours, 48);
    console.log('✔ 1b. Unified draft order retrieved successfully via session');

    // =========================================================================
    // 2. Server-Side Authoritative Pricing Engine
    // =========================================================================
    console.log('\n--- 2. Testing Server-Side Authoritative Pricing Engine ---');
    // Franci has rate $35, Emilia has rate $30
    // 6 videos = 3 videos for Franci ($105) + 3 videos for Emilia ($90) = $195.00
    // Platform fee = 5% of $195.00 = $9.75
    // Total = $204.75
    assert.strictEqual(saveDraftRes.pricing.quantity, 6);
    assert.strictEqual(saveDraftRes.pricing.creatorBaseSubtotal, 195.00, 'Creator base subtotal must equal $195.00');
    assert.strictEqual(saveDraftRes.pricing.volumeDiscountPercent, 0);
    assert.strictEqual(saveDraftRes.pricing.turnaroundPremium, 0);
    assert.strictEqual(saveDraftRes.pricing.platformFee, 9.75, 'Platform fee must be 5% ($9.75)');
    assert.strictEqual(saveDraftRes.pricing.total, 204.75, 'Grand total must equal $204.75');
    console.log('✔ 2a. Authoritative creator base rates and line-items verified (Franci $35 x 3, Emilia $30 x 3 = $195.00 + $9.75 fee)');

    // Test volume discount on 10 videos (Save 8.3%)
    const volumeDraftRes = await request('/api/orders/draft', 'POST', {
      orderId,
      qty: 10
    });
    assert.strictEqual(volumeDraftRes.pricing.quantity, 10);
    assert.strictEqual(volumeDraftRes.pricing.volumeDiscountPercent, 8.3);
    assert.ok(volumeDraftRes.pricing.volumeDiscountAmount > 0, 'Volume discount must be applied on 10+ videos');
    console.log(`✔ 2b. Volume discount verified: ${volumeDraftRes.pricing.discountLabel} (-$${volumeDraftRes.pricing.volumeDiscountAmount})`);

    // Test rush turnaround premium (24 hours turnaround adds 15%)
    const rushDraftRes = await request('/api/orders/draft', 'POST', {
      orderId,
      qty: 6,
      turnaroundHours: 24
    });
    assert.strictEqual(rushDraftRes.pricing.isRushTurnaround, true);
    assert.strictEqual(rushDraftRes.pricing.turnaroundPremium, 29.25, '24h rush premium must be 15% ($29.25)');
    console.log(`✔ 2c. Rush turnaround premium verified: +$${rushDraftRes.pricing.turnaroundPremium} for 24h SLA`);

    // Reset back to standard 48h
    await request('/api/orders/draft', 'POST', { orderId, qty: 6, turnaroundHours: 48 });

    // =========================================================================
    // 3. Dedicated Endpoint for the Edit Brief View
    // =========================================================================
    console.log('\n--- 3. Testing Dedicated Edit Brief View Endpoint (GET /api/orders/:order_id/brief?format=reaction) ---');
    const briefViewRes = await request(`/api/orders/${orderId}/brief?format=reaction`, 'GET');
    assert.strictEqual(briefViewRes.success, true);
    assert.strictEqual(briefViewRes.orderId, orderId);
    assert.strictEqual(briefViewRes.formatKey, 'reaction');
    assert.strictEqual(briefViewRes.prerequisites.allMet, true);
    assert.strictEqual(briefViewRes.verifiedCreators.length, 2);
    assert.strictEqual(briefViewRes.verifiedCreators[0].name, 'Franci');
    assert.strictEqual(briefViewRes.verifiedCreators[0].baseRate, 35.00);
    assert.strictEqual(briefViewRes.verifiedCreators[1].name, 'Emilia');
    assert.strictEqual(briefViewRes.verifiedCreators[1].baseRate, 30.00);
    console.log('✔ 3a. GET /api/orders/:order_id/brief?format=reaction returns verified creators with fresh rates & pricing breakdown');

    // Test prerequisite missing detection and $0.00 pricing when no creators selected
    const emptyDraftRes = await request('/api/orders/draft', 'POST', {
      format: 'reaction',
      creatorIds: [],
      qty: 6
    }, { 'x-session-id': 'new_empty_session_' + Date.now() });
    assert.strictEqual(emptyDraftRes.pricing.total, 0.00, '0 creators must have total = $0.00');
    assert.strictEqual(emptyDraftRes.pricing.creatorCount, 0, '0 creators count must be 0');

    const emptyBriefRes = await request(`/api/orders/${emptyDraftRes.orderId}/brief?format=reaction`, 'GET', null, { 'x-session-id': 'new_empty_session_' + Date.now() });
    assert.strictEqual(emptyBriefRes.prerequisites.allMet, false);
    assert.strictEqual(emptyBriefRes.prerequisites.creatorsVerified, false);
    assert.strictEqual(emptyBriefRes.verifiedCreators.length, 0, 'verifiedCreators must be empty');
    assert.strictEqual(emptyBriefRes.pricing.total, 0.00, 'pricing.total must be $0.00');
    assert.ok(emptyBriefRes.prerequisites.missing.some(m => m.includes('creators page')));
    console.log('✔ 3b. Prerequisite verification and $0.00 pricing correctly verified when 0 creators are selected');

    // =========================================================================
    // 4. Format-Specific Field Customization
    // =========================================================================
    console.log('\n--- 4. Testing Format-Specific Reaction Brief Customization ---');
    assert.ok(briefViewRes.reactionRequirements, 'Reaction requirements schema must be present');
    assert.strictEqual(briefViewRes.reactionRequirements.formatType, 'reaction');
    assert.strictEqual(briefViewRes.reactionRequirements.minVideos, 5);
    assert.ok(briefViewRes.reactionRequirements.supportedLayouts.some(l => l.id === 'split_screen'));
    assert.ok(briefViewRes.reactionRequirements.supportedLayouts.some(l => l.id === 'picture_in_picture'));
    assert.ok(briefViewRes.reactionRequirements.supportedLayouts.some(l => l.id === 'side_by_side'));
    assert.ok(briefViewRes.reactionRequirements.suggestedHooks.length >= 3);
    console.log('✔ 4a. Supported layout options (split_screen, picture_in_picture, side_by_side) & reaction hooks customized');

    // =========================================================================
    // 5. Final Brief Submission & Validation & Lock-In
    // =========================================================================
    console.log('\n--- 5. Testing Final Brief Submission & Pricing Lock-In ---');

    // 5a. Validation failure: missing brand name
    const invalidSubmitRes = await request(`/api/orders/${orderId}/brief`, 'POST', {
      brandName: '', // missing
      aboutBrand: 'Hydrating aloe vera moisturizer',
      filmingInstructions: 'Hold bottle, express genuine surprise',
      concepts: [{ title: 'Reaction 1', script: 'Wow look at that texture!' }]
    });
    assert.strictEqual(invalidSubmitRes.success, false);
    assert.ok(invalidSubmitRes.validationErrors.some(e => e.includes('Brand name')), 'Must require Brand name');
    console.log('✔ 5a. Mandatory Brand name enforced for brief submission');

    // 5b. Validation failure: invalid URL
    const badUrlRes = await request(`/api/orders/${orderId}/brief`, 'POST', {
      brandName: 'HydroGlow Skin',
      sourceAssetUrl: 'not_a_valid_url',
      concepts: [{ title: 'Reaction 1', script: 'Wow look at that texture!' }]
    });
    assert.strictEqual(badUrlRes.success, false);
    assert.ok(badUrlRes.validationErrors.some(e => e.includes('valid URL')), 'Must validate URL format');
    console.log('✔ 5b. Invalid Source Media URL rejected');

    // 5c. Successful submission, pricing snapshot lock-in, and status transition
    const validSubmitRes = await request(`/api/orders/${orderId}/brief`, 'POST', {
      brandName: 'HydroGlow Skin',
      sourceAssetUrl: 'https://www.tiktok.com/@skincare_official/video/7192839123891',
      layoutPreference: 'split_screen',
      timestampsCallouts: '0:12 - gasp at before/after; 0:38 - enthusiastic agreement',
      reactionStyleGuidelines: 'Authentic skepticism turning into delighted conviction',
      aboutBrand: 'Hydrating aloe vera moisturizer with rapid 48-hour absorption',
      filmingInstructions: 'Film vertically in high-res morning light. Keep facial expressions natural.',
      concepts: [
        {
          title: 'Reaction Concept 1',
          type: 'Reaction / footage',
          script: 'Wait... are you telling me this skin transformation happened in just 3 days?! Let me zoom in on that...',
          perCreator: 3
        }
      ]
    });

    assert.strictEqual(validSubmitRes.success, true);
    assert.strictEqual(validSubmitRes.status, 'ready_for_checkout');
    assert.strictEqual(validSubmitRes.locked, true);
    assert.strictEqual(validSubmitRes.verifiedOrder.format, 'Reaction Video');
    assert.strictEqual(validSubmitRes.verifiedOrder.sourceAssetUrl, 'https://www.tiktok.com/@skincare_official/video/7192839123891');
    assert.strictEqual(validSubmitRes.verifiedOrder.layoutPreference, 'split_screen');
    assert.strictEqual(validSubmitRes.verifiedOrder.total, '204.75');
    console.log('✔ 5c. Valid brief submitted, verified pricing snapshot locked ($204.75), status advanced to ready_for_checkout');

    // 5d. Tampering protection: attempting to modify a locked draft order directly fails
    const tamperRes = await request('/api/orders/draft', 'POST', {
      orderId,
      qty: 2 // Trying to lower quantity on locked order
    });
    assert.strictEqual(tamperRes.success, false);
    assert.ok(tamperRes.error.includes('locked'), 'Locked draft orders must reject post-submission tampering');
    console.log('✔ 5d. Pricing snapshot tamper protection verified (locked orders reject modifications)');

    console.log('\n======================================================');
    console.log('ALL 5 REQUIREMENTS IMPLEMENTED & VERIFIED SUCCESSFULLY');
    console.log('======================================================\n');
  } catch (error) {
    console.error('Test suite failed:', error);
    process.exit(1);
  } finally {
    server.close(() => {
      process.exit(0);
    });
  }
});
