const http = require('http');
const assert = require('assert');
const app = require('./server');

const PORT = 3005;
const server = app.listen(PORT, async () => {
  console.log(`[Order Backend Test] Running test suite on port ${PORT}...`);
  try {
    // =========================================================================
    // 1. Prerequisite and Asset Validation
    // =========================================================================
    console.log('\n--- 1. Prerequisite & Asset Validation ---');

    // 1a. Reaction Video missing source media link should fail
    const invalidReactionRes = await request('/api/orders/open', 'POST', {
      formatType: 'reaction',
      brandName: 'Test Brand',
      title: 'Reaction to Coffee Ad',
      formatLink: '', // missing
      creatorPay: 25
    });
    assert.strictEqual(invalidReactionRes.success, false, 'Missing source link must be rejected');
    assert.ok(
      invalidReactionRes.validationErrors.some(e => e.includes('source media link') || e.includes('reference URL')),
      'Validation error should mention source media requirement for reaction video'
    );
    console.log('✔ 1a. Reaction Video missing source media rejected properly');

    // 1b. Reaction Video with pay below $25 should fail
    const lowPayReactionRes = await request('/api/orders/open', 'POST', {
      formatType: 'reaction',
      brandName: 'Test Brand',
      title: 'Reaction to Coffee Ad',
      formatLink: 'https://tiktok.com/@test/video/123',
      creatorPay: 15 // below $25
    });
    assert.strictEqual(lowPayReactionRes.success, false, 'Pay below $25 must be rejected');
    assert.ok(
      lowPayReactionRes.validationErrors.some(e => e.includes('minimum creator payout of $25')),
      'Validation error should enforce $25 min pay for Reaction Video'
    );
    console.log('✔ 1b. Reaction Video minimum payout enforced ($25.00 min)');

    // 1c. Valid Reaction Video order
    const validReactionRes = await request('/api/orders/open', 'POST', {
      formatType: 'reaction',
      brandName: 'RoastCo Coffee',
      title: 'First sip reaction test',
      formatLink: 'https://youtube.com/shorts/coffee_sample',
      layoutInstruction: 'split_screen',
      details: 'Show authentic surprised reaction at the taste difference',
      creatorPay: 35
    });
    assert.strictEqual(validReactionRes.success, true, 'Valid reaction order must succeed');
    assert.strictEqual(validReactionRes.formatAnalysis.formatType, 'reaction');
    assert.strictEqual(validReactionRes.formatAnalysis.requiresShipping, false, 'Reaction should not require shipping');
    assert.strictEqual(validReactionRes.formatAnalysis.shippingStatus, 'not_required');
    assert.strictEqual(validReactionRes.formatAnalysis.turnaroundHours, 36, 'Reaction turnaround should be fast (36h)');
    assert.strictEqual(validReactionRes.pricing.creatorPay, 35);
    assert.strictEqual(validReactionRes.pricing.platformFee, 7.00); // 20%
    assert.strictEqual(validReactionRes.pricing.total, 42.00);
    assert.strictEqual(validReactionRes.escrow.status, 'held', 'Escrow must be held');
    const reactionOrderId = validReactionRes.orderId;
    console.log('✔ 1c. Valid Reaction Video created with 36h turnaround, 20% fee, zero shipping & held escrow:', reactionOrderId);

    // 1d. Full UGC missing script / talking points should fail
    const invalidUgcRes = await request('/api/orders/open', 'POST', {
      formatType: 'full_ugc',
      brandName: 'GlowSkin',
      title: 'Serum Video Ad',
      script: 'Too short', // less than 15 chars
      creatorPay: 120
    });
    assert.strictEqual(invalidUgcRes.success, false, 'Missing script/talking points must fail');
    assert.ok(
      invalidUgcRes.validationErrors.some(e => e.includes('script direction')),
      'Validation error should mention script requirements for full UGC'
    );
    console.log('✔ 1d. Full UGC missing script/talking points rejected properly');

    // 1e. Full UGC with pay below $100 should fail
    const lowPayUgcRes = await request('/api/orders/open', 'POST', {
      formatType: 'full_ugc',
      brandName: 'GlowSkin',
      title: 'Serum Video Ad',
      script: 'Hook: Stop using harmful chemical serums. Body: Show the natural organic glow. CTA: Shop now.',
      creatorPay: 50 // below $100
    });
    assert.strictEqual(lowPayUgcRes.success, false, 'Pay below $100 for Full UGC must fail');
    assert.ok(
      lowPayUgcRes.validationErrors.some(e => e.includes('minimum creator payout of $100')),
      'Validation error should enforce $100 min pay for Full UGC'
    );
    console.log('✔ 1e. Full UGC minimum payout enforced ($100.00 min)');

    // 1f. Valid Full UGC order with physical sample shipping
    const validUgcRes = await request('/api/orders/open', 'POST', {
      formatType: 'full_ugc',
      brandName: 'Lumina Organics',
      title: 'Hydrating Night Cream Full UGC Ad',
      script: 'Hook: I threw away my expensive moisturizer after trying this. Body: Texture swatch, skin absorption, morning glow. CTA: Link in bio for 20% off.',
      requiresShipping: true,
      shippingProductName: 'Lumina Deep Hydration Night Cream 50ml',
      creatorPay: 150
    });
    assert.strictEqual(validUgcRes.success, true, 'Valid Full UGC order must succeed');
    assert.strictEqual(validUgcRes.formatAnalysis.formatType, 'full_ugc');
    assert.strictEqual(validUgcRes.formatAnalysis.requiresShipping, true);
    assert.strictEqual(validUgcRes.formatAnalysis.shippingStatus, 'pending_shipment');
    assert.strictEqual(validUgcRes.formatAnalysis.turnaroundHours, 120, 'Full UGC turnaround SLA is 120h (5 days)');
    assert.strictEqual(validUgcRes.pricing.creatorPay, 150);
    assert.strictEqual(validUgcRes.pricing.platformFee, 30.00); // 20%
    assert.strictEqual(validUgcRes.pricing.total, 180.00);
    assert.strictEqual(validUgcRes.escrow.status, 'held');
    const fullUgcOrderId = validUgcRes.orderId;
    console.log('✔ 1f. Valid Full UGC created with 5-day SLA, physical shipping & escrow held:', fullUgcOrderId);

    // =========================================================================
    // 2. Creator Filtering and Recommendation Matching
    // =========================================================================
    console.log('\n--- 2. Creator Recommendation & Matching Engine ---');
    const reactionMatches = await request(`/api/orders/${reactionOrderId}/matching-creators`, 'GET');
    assert.strictEqual(reactionMatches.success, true);
    assert.ok(reactionMatches.creators.length > 0);
    assert.ok(reactionMatches.creators.every(c => c.specialties.includes('reaction')));
    console.log(`✔ 2a. Reaction Video matched ${reactionMatches.creators.length} reaction creators:`, reactionMatches.creators.map(c => c.name).join(', '));

    const ugcMatches = await request(`/api/orders/${fullUgcOrderId}/matching-creators`, 'GET');
    assert.strictEqual(ugcMatches.success, true);
    assert.ok(ugcMatches.creators.length > 0);
    assert.ok(ugcMatches.creators.every(c => c.specialties.includes('full_ugc')));
    console.log(`✔ 2b. Full UGC matched ${ugcMatches.creators.length} commercial creators:`, ugcMatches.creators.map(c => c.name).join(', '));

    // =========================================================================
    // 3. Claims & Applicant Cap Protection
    // =========================================================================
    console.log('\n--- 3. Claims & Applicant Cap Protection ---');
    // Incompatible creator claim rejection check:
    // creator_2 (Maya) is 'reaction' only. Claiming Full UGC should fail.
    const incompatibleClaim = await request(`/api/orders/${fullUgcOrderId}/claim`, 'POST', {
      creatorId: 'creator_2' // Maya (reaction only)
    });
    assert.strictEqual(incompatibleClaim.success, false);
    assert.ok(incompatibleClaim.error.includes('specializes in'), 'Incompatible format specialist should be rejected');
    console.log('✔ 3a. Incompatible creator specialization safely rejected');

    // Compatible claim: creator_3 (Robert, Full UGC specialist)
    const validClaim = await request(`/api/orders/${fullUgcOrderId}/claim`, 'POST', {
      creatorId: 'creator_3',
      pitch: 'Professional studio with 4K setup and high conversion track record.'
    });
    assert.strictEqual(validClaim.success, true);
    assert.strictEqual(validClaim.creatorName, 'Robert');
    assert.strictEqual(validClaim.status, 'shipping', 'Order status should be shipping because physical product is required');
    console.log('✔ 3b. Compatible creator claimed brief. Status set to "shipping":', validClaim.status);

    // =========================================================================
    // 4. Physical Shipping and Logistics Management
    // =========================================================================
    console.log('\n--- 4. Physical Shipping & Logistics Management ---');
    // 4a. Trying to add shipping to Reaction Video must fail
    const reactionShippingFail = await request(`/api/orders/${reactionOrderId}/shipping`, 'PUT', {
      carrier: 'USPS',
      trackingNumber: '9400123'
    });
    assert.strictEqual(reactionShippingFail.success, false);
    assert.ok(reactionShippingFail.error.includes('Reaction Video orders do not require physical product shipping'));
    console.log('✔ 4a. Reaction Video shipping rejected as unnecessary');

    // 4b. Update tracking to in_transit for Full UGC
    const shipTransitRes = await request(`/api/orders/${fullUgcOrderId}/shipping`, 'PUT', {
      carrier: 'FedEx Express',
      trackingNumber: 'FDX-7749201948',
      status: 'in_transit'
    });
    assert.strictEqual(shipTransitRes.success, true);
    assert.strictEqual(shipTransitRes.shipping.shippingStatus, 'in_transit');
    console.log('✔ 4b. Shipping updated to "in_transit" with tracking FDX-7749201948');

    // 4c. Deliver product -> starts turnaround countdown
    const shipDeliverRes = await request(`/api/orders/${fullUgcOrderId}/shipping`, 'PUT', {
      status: 'delivered'
    });
    assert.strictEqual(shipDeliverRes.success, true);
    assert.strictEqual(shipDeliverRes.shipping.shippingStatus, 'delivered');
    assert.strictEqual(shipDeliverRes.shipping.orderStatus, 'in_progress');
    assert.ok(shipDeliverRes.shipping.dueAt, 'Due date must be calculated upon delivery');
    console.log('✔ 4c. Sample delivered. Order transitioned to "in_progress". SLA countdown activated until:', shipDeliverRes.shipping.dueAt);

    // =========================================================================
    // 5. Deliverable Submission & Format Verification Quality Checks
    // =========================================================================
    console.log('\n--- 5. Deliverable Submission & Quality Verification ---');

    // Claim reaction order first
    await request(`/api/orders/${reactionOrderId}/claim`, 'POST', {
      creatorId: 'creator_5', // Franci (reaction specialist)
      pitch: 'Ready to shoot reaction clip.'
    });

    // 5a. Submit Reaction Deliverable
    const reactionDeliverable = await request(`/api/orders/${reactionOrderId}/deliverable`, 'POST', {
      creatorId: 'creator_5',
      videoUrl: 'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-2.mp4',
      notes: 'Vertical split-screen reaction with synced audio.'
    });
    assert.strictEqual(reactionDeliverable.success, true);
    assert.strictEqual(reactionDeliverable.orderStatus, 'in_review');
    assert.strictEqual(reactionDeliverable.verificationReport.formatType, 'reaction');
    assert.ok(reactionDeliverable.verificationReport.verifiedChecks.some(c => c.name === 'Audio-Visual Sync'));
    console.log('✔ 5a. Reaction deliverable verified with audio-sync check. Score:', reactionDeliverable.verificationReport.score);

    // 5b. Submit Full UGC Deliverable
    const ugcDeliverable = await request(`/api/orders/${fullUgcOrderId}/deliverable`, 'POST', {
      creatorId: 'creator_3',
      videoUrl: 'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-11.mp4',
      notes: 'Full commercial cut with hook, B-roll product close-ups, and captions.'
    });
    assert.strictEqual(ugcDeliverable.success, true);
    assert.strictEqual(ugcDeliverable.orderStatus, 'in_review');
    assert.strictEqual(ugcDeliverable.verificationReport.formatType, 'full_ugc');
    assert.ok(ugcDeliverable.verificationReport.verifiedChecks.some(c => c.name === 'Script & Talking Points Adherence'));
    assert.ok(ugcDeliverable.verificationReport.verifiedChecks.some(c => c.name === 'Studio Lighting & Audio Clarity'));
    console.log('✔ 5b. Full UGC deliverable verified with script & lighting checks. Score:', ugcDeliverable.verificationReport.score);

    // =========================================================================
    // 6. Review & Escrow Release Workflow
    // =========================================================================
    console.log('\n--- 6. Review & Escrow Payout Workflow ---');

    // 6a. Revision request check
    const revisionRes = await request(`/api/orders/${reactionOrderId}/review-submission`, 'POST', {
      action: 'request_revision',
      feedback: 'Please give a slightly bigger smile at 0:04.'
    });
    assert.strictEqual(revisionRes.success, true);
    assert.strictEqual(revisionRes.orderStatus, 'in_progress');
    console.log('✔ 6a. Revision requested, status reverted to "in_progress" with creator feedback');

    // Re-submit deliverable
    await request(`/api/orders/${reactionOrderId}/deliverable`, 'POST', {
      creatorId: 'creator_5',
      videoUrl: 'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-2.mp4',
      notes: 'Smile adjusted as requested!'
    });

    // 6b. Final Approval & Escrow Release
    const approveRes = await request(`/api/orders/${reactionOrderId}/review-submission`, 'POST', {
      action: 'approve',
      feedback: 'Perfect reaction! Approved.'
    });
    assert.strictEqual(approveRes.success, true);
    assert.strictEqual(approveRes.orderStatus, 'completed');
    assert.strictEqual(approveRes.escrowRelease.status, 'released');
    assert.strictEqual(approveRes.escrowRelease.creatorPayout, 35);
    assert.ok(approveRes.escrowRelease.payoutReference.startsWith('po_creator_'));
    console.log('✔ 6b. Order approved and $35.00 escrow released to creator (Payout Ref:', approveRes.escrowRelease.payoutReference, ')');

    // Check order detail endpoint
    const finalDetail = await request(`/api/orders/${reactionOrderId}`, 'GET');
    assert.strictEqual(finalDetail.success, true);
    assert.strictEqual(finalDetail.order.status, 'completed');
    assert.strictEqual(finalDetail.order.escrowStatus, 'released');
    console.log('✔ 6c. Order details endpoint confirmed completed status & released escrow');

    // =========================================================================
    // 7. Notifications & Session Account Summary
    // =========================================================================
    console.log('\n--- 7. Notifications & Account Summary ---');
    const notifs = await request(`/api/notifications?type=creator&recipientId=creator_5`, 'GET');
    assert.strictEqual(notifs.success, true);
    assert.ok(notifs.notifications.length > 0);
    console.log(`✔ 7a. Notification service retrieved ${notifs.notifications.length} notifications for creator:`, notifs.notifications[0].title);

    const account = await request(`/api/orders/account/summary?sessionId=${validReactionRes.sessionId}`, 'GET');
    assert.strictEqual(account.success, true);
    assert.ok(account.account.totalOrders >= 1);
    console.log('✔ 7b. Brand account session summary verified. Total orders recorded:', account.account.totalOrders);

    console.log('\n===============================================================');
    console.log('ALL 6 CORE BACKEND MODULES AND API REQUIREMENTS PASSED 100%!');
    console.log('===============================================================\n');

  } catch (err) {
    console.error('\n❌ Test failed with error:', err);
    process.exit(1);
  } finally {
    server.close();
    process.exit(0);
  }
});

function request(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let chunks = '';
      res.on('data', chunk => chunks += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(chunks));
        } catch (e) {
          resolve(chunks);
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
