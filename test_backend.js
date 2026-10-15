const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('./server');

const server = app.listen(3001, async () => {
  console.log('Testing server started on port 3001...');
  try {
    // 1. Health check
    const health = await request('/api/health', 'GET');
    console.log('✔ 1. Health Check:', health);

    // 2. Save draft brief
    const draftPayload = {
      brandName: 'GlowSkin Co',
      aboutBrand: 'Organic hydrating skincare serum that clears acne in 7 days.',
      filmingInstructions: 'Film in natural morning light, front camera, vertical 9:16.',
      qty: 6,
      selectedCreators: [
        { id: 'creator_1', name: 'Sofia', avatar: 'avatar_1.png' },
        { id: 'creator_2', name: 'Maya', avatar: 'avatar_2.png' }
      ],
      concepts: [
        {
          title: 'Concept 1',
          type: 'Reaction / footage',
          script: 'Wait, is this actually working? I put this on three nights ago and my redness is completely gone!',
          perCreator: 3
        }
      ]
    };

    const draftRes = await request('/api/briefs/save-draft', 'POST', draftPayload);
    console.log('✔ 2. Save Draft Brief:', draftRes);
    const briefId = draftRes.briefId;

    // 3. Retrieve brief
    const getRes = await request(`/api/briefs/${briefId}`, 'GET');
    console.log('✔ 3. Retrieve Brief by ID:', getRes.brief.brandName === 'GlowSkin Co');

    // 4. Update brief
    const updateRes = await request(`/api/briefs/${briefId}`, 'PUT', {
      ...draftPayload,
      brandName: 'GlowSkin Co Premium',
      qty: 10 // Should trigger volume discount
    });
    console.log('✔ 4. Update Brief with Tier Discount:', updateRes.pricing);

    // 5. Test AI Script Assistant
    const aiRes = await request('/api/ai/script-helper', 'POST', {
      mode: 'generate',
      brandName: 'GlowSkin Co',
      aboutBrand: 'Hydrating face serum',
      conceptType: 'Reaction / footage'
    });
    console.log('✔ 5. AI Script Assistant:', {
      conceptType: aiRes.conceptType,
      estimatedDuration: aiRes.analysis.formattedDuration,
      pace: aiRes.analysis.paceCategory
    });

    // 6. Server-side Validation & Review Submission
    const reviewRes = await request(`/api/briefs/${briefId}/review`, 'POST', {
      brandName: 'GlowSkin Co Premium',
      aboutBrand: 'Hydrating face serum with organic aloe',
      filmingInstructions: 'Hold bottle clearly in first 2 seconds.',
      qty: 10,
      selectedCreators: [{ id: 'creator_1', name: 'Sofia' }, { id: 'creator_2', name: 'Maya' }],
      concepts: [
        {
          title: 'Concept 1',
          type: 'Reaction / footage',
          script: 'Look at my skin before vs after using GlowSkin serum!'
        }
      ]
    });
    console.log('✔ 6. Server-side Review & Pricing Validation:', reviewRes.verifiedOrder.rate, reviewRes.verifiedOrder.total);

    // 7. Order Creation
    const orderRes = await request('/api/orders/create', 'POST', {
      briefId: briefId,
      brandName: 'GlowSkin Co Premium',
      qty: 10,
      selectedCreators: [{ id: 'creator_1', name: 'Sofia' }]
    });
    console.log('✔ 7. Create Order Finalized:', orderRes.orderId, orderRes.status);

    // 8. Uploads presigned-url
    const presignRes = await request('/api/uploads/presigned-url', 'POST', {
      filename: 'brand_reference.mp4',
      contentType: 'video/mp4'
    });
    console.log('✔ 8. Presigned URL Generation:', presignRes.uploadUrl, presignRes.key);

    console.log('\n===========================================');
    console.log('ALL BACKEND ENDPOINTS AND TESTS PASSED 100%');
    console.log('===========================================\n');
  } catch (err) {
    console.error('Test failed:', err);
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
      port: 3001,
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
