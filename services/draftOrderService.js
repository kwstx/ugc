const db = require('../db');
const { calculateAuthoritativePricing, getCreatorPricingInfo } = require('./pricingEngine');
const { getReactionTemplates } = require('./briefAiGenerator');

function generateDraftOrderId() {
  return 'ORD-' + Math.floor(100000 + Math.random() * 900000);
}

/**
 * 1. Unified Draft Order State: Get or create single source of truth
 */
function getOrCreateDraftOrder({ orderId = null, sessionId = 'default_session', format = 'reaction', includeLocked = false }) {
  let draft = null;

  if (orderId) {
    draft = db.prepare('SELECT * FROM draft_orders WHERE id = ?').get(orderId);
  }

  if (!draft && sessionId) {
    if (includeLocked) {
      draft = db.prepare('SELECT * FROM draft_orders WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1').get(sessionId);
    } else {
      draft = db.prepare('SELECT * FROM draft_orders WHERE session_id = ? AND locked = 0 ORDER BY updated_at DESC LIMIT 1').get(sessionId);
    }
  }

  if (draft) {
    return parseDraftOrder(draft);
  }

  // Create new draft order with defaults
  const newId = orderId || generateDraftOrderId();
  const formatLabel = String(format).toLowerCase().includes('full') ? 'Full UGC' : 'Reaction Video';
  const formatKey = String(format).toLowerCase().includes('full') ? 'full' : 'reaction';
  const minVideos = formatKey === 'full' ? 1 : 5;

  const insertStmt = db.prepare(`
    INSERT INTO draft_orders (
      id, session_id, format, format_key, status, creator_ids, selected_creators,
      qty, turnaround_hours, layout_preference, brand_name, about_brand,
      filming_instructions, concepts, hooks, talking_points,
      subtotal, platform_fee, tax, discount, total, currency,
      prerequisites_completed, locked, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, 'draft', '[]', '[]',
      ?, 48, 'split_screen', '', '',
      '', '[]', '[]', '[]',
      0.0, 0.0, 0.0, 0.0, 0.0, 'USD',
      0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);

  insertStmt.run(newId, sessionId, formatLabel, formatKey, minVideos);
  const created = db.prepare('SELECT * FROM draft_orders WHERE id = ?').get(newId);
  return parseDraftOrder(created);
}

/**
 * Parse raw SQLite draft row to structured object
 */
function parseDraftOrder(row) {
  if (!row) return null;
  let creatorIds = [];
  let selectedCreators = [];
  let concepts = [];
  let hooks = [];
  let talkingPoints = [];
  let pricingSnapshot = null;

  try { creatorIds = JSON.parse(row.creator_ids || '[]'); } catch (e) {}
  try { selectedCreators = JSON.parse(row.selected_creators || '[]'); } catch (e) {}
  try { concepts = JSON.parse(row.concepts || '[]'); } catch (e) {}
  try { hooks = JSON.parse(row.hooks || '[]'); } catch (e) {}
  try { talkingPoints = JSON.parse(row.talking_points || '[]'); } catch (e) {}
  try { pricingSnapshot = JSON.parse(row.pricing_snapshot || 'null'); } catch (e) {}

  return {
    id: row.id,
    sessionId: row.session_id,
    format: row.format,
    formatKey: row.format_key,
    status: row.status,
    creatorIds,
    selectedCreators,
    qty: row.qty,
    turnaroundHours: row.turnaround_hours,
    layoutPreference: row.layout_preference,
    sourceAssetUrl: row.source_asset_url || '',
    timestampsCallouts: row.timestamps_callouts || '',
    reactionStyleGuidelines: row.reaction_style_guidelines || '',
    brandName: row.brand_name || '',
    aboutBrand: row.about_brand || '',
    filmingInstructions: row.filming_instructions || '',
    concepts,
    hooks,
    talkingPoints,
    pricingSnapshot,
    subtotal: row.subtotal,
    platformFee: row.platform_fee,
    tax: row.tax,
    discount: row.discount,
    total: row.total,
    currency: row.currency || 'USD',
    prerequisitesCompleted: Boolean(row.prerequisites_completed),
    locked: Boolean(row.locked),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Update draft order state with selections from creators page, order page, or edit brief
 */
function updateDraftOrder(orderId, updateData) {
  const existing = db.prepare('SELECT * FROM draft_orders WHERE id = ?').get(orderId);
  if (!existing) {
    throw new Error(`Draft order not found: ${orderId}`);
  }

  // Prevent modification if already locked unless explicitly forced
  if (existing.locked && !updateData.forceUnlock) {
    throw new Error(`Draft order ${orderId} is locked for checkout and cannot be modified.`);
  }

  const current = parseDraftOrder(existing);

  // Merge updates
  const format = updateData.format || current.format;
  const isFull = String(format).toLowerCase().includes('full');
  const formatLabel = isFull ? 'Full UGC' : 'Reaction Video';
  const formatKey = isFull ? 'full' : 'reaction';
  const minVideos = formatKey === 'full' ? 1 : 5;

  let creatorIds = updateData.creatorIds !== undefined ? updateData.creatorIds : current.creatorIds;
  if (!Array.isArray(creatorIds) && Array.isArray(updateData.selectedCreators)) {
    creatorIds = updateData.selectedCreators.map(c => typeof c === 'object' ? c.id : c).filter(Boolean);
  }

  let qty = parseInt(updateData.qty !== undefined ? updateData.qty : current.qty, 10);
  if (isNaN(qty) || qty < minVideos) {
    qty = minVideos;
  }

  const turnaroundHours = parseInt(updateData.turnaroundHours !== undefined ? updateData.turnaroundHours : current.turnaroundHours, 10) || 48;
  const layoutPreference = updateData.layoutPreference !== undefined ? updateData.layoutPreference : current.layoutPreference;
  const sourceAssetUrl = updateData.sourceAssetUrl !== undefined ? updateData.sourceAssetUrl : current.sourceAssetUrl;
  const timestampsCallouts = updateData.timestampsCallouts !== undefined ? updateData.timestampsCallouts : current.timestampsCallouts;
  const reactionStyleGuidelines = updateData.reactionStyleGuidelines !== undefined ? updateData.reactionStyleGuidelines : current.reactionStyleGuidelines;
  const brandName = updateData.brandName !== undefined ? updateData.brandName : current.brandName;
  const aboutBrand = updateData.aboutBrand !== undefined ? updateData.aboutBrand : current.aboutBrand;
  const filmingInstructions = updateData.filmingInstructions !== undefined ? updateData.filmingInstructions : current.filmingInstructions;
  const concepts = updateData.concepts !== undefined ? updateData.concepts : current.concepts;
  const hooks = updateData.hooks !== undefined ? updateData.hooks : current.hooks;
  const talkingPoints = updateData.talkingPoints !== undefined ? updateData.talkingPoints : current.talkingPoints;

  // 2. Authoritative Pricing calculation
  const authoritativePricing = calculateAuthoritativePricing({
    creatorIds,
    quantity: qty,
    format: formatKey,
    turnaroundHours,
    licensingTier: updateData.licensingTier || 'standard',
    customDiscountPct: updateData.customDiscountPct || 0
  });

  const verifiedCreators = authoritativePricing.creators.map(c => ({
    id: c.id,
    name: c.name,
    handle: c.handle,
    avatar: c.avatar,
    status: c.status,
    rate: c.baseRate,
    assignedVideos: c.assignedVideos,
    subtotal: c.subtotal
  }));

  // Check prerequisites
  const hasCreators = verifiedCreators.length > 0 && verifiedCreators.every(c => c.status === 'active');
  const hasMinQty = qty >= minVideos;
  const prerequisitesCompleted = hasCreators && hasMinQty ? 1 : 0;

  const updateStmt = db.prepare(`
    UPDATE draft_orders
    SET format = ?, format_key = ?, creator_ids = ?, selected_creators = ?,
        qty = ?, turnaround_hours = ?, layout_preference = ?,
        source_asset_url = ?, timestamps_callouts = ?, reaction_style_guidelines = ?,
        brand_name = ?, about_brand = ?, filming_instructions = ?,
        concepts = ?, hooks = ?, talking_points = ?,
        pricing_snapshot = ?, subtotal = ?, platform_fee = ?,
        tax = ?, discount = ?, total = ?,
        prerequisites_completed = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  updateStmt.run(
    formatLabel,
    formatKey,
    JSON.stringify(creatorIds),
    JSON.stringify(verifiedCreators),
    qty,
    turnaroundHours,
    layoutPreference,
    sourceAssetUrl,
    timestampsCallouts,
    reactionStyleGuidelines,
    brandName,
    aboutBrand,
    filmingInstructions,
    JSON.stringify(concepts),
    JSON.stringify(hooks),
    JSON.stringify(talkingPoints),
    JSON.stringify(authoritativePricing),
    authoritativePricing.subtotal,
    authoritativePricing.platformFee,
    authoritativePricing.tax,
    authoritativePricing.volumeDiscountAmount + authoritativePricing.customDiscountAmount,
    authoritativePricing.total,
    prerequisitesCompleted,
    orderId
  );

  return {
    draft: parseDraftOrder(db.prepare('SELECT * FROM draft_orders WHERE id = ?').get(orderId)),
    pricing: authoritativePricing
  };
}

/**
 * 3. Dedicated View Generator: Checks selections, performs fresh creator rate lookups,
 * and formats the reaction brief data for edit_brief?format=reaction
 */
function getReactionBriefViewData({ orderId = null, sessionId = 'default_session', format = 'reaction' }) {
  const isReaction = !String(format).toLowerCase().includes('full');
  const activeFormatKey = isReaction ? 'reaction' : 'full';
  const activeFormatLabel = isReaction ? 'Reaction Video' : 'Full UGC';

  // Find or create draft order
  const draft = getOrCreateDraftOrder({ orderId, sessionId, format: activeFormatKey, includeLocked: true });

  // Fresh rate lookup for all creators directly from creators table
  const freshCreators = [];
  const unavailableCreators = [];

  for (const cid of draft.creatorIds) {
    const creator = getCreatorPricingInfo(cid);
    if (creator) {
      if (creator.available) {
        freshCreators.push(creator);
      } else {
        unavailableCreators.push(creator);
      }
    }
  }

  // Authoritative server-side pricing recalculation with fresh rates
  const pricing = calculateAuthoritativePricing({
    creatorIds: draft.creatorIds,
    quantity: draft.qty,
    format: activeFormatKey,
    turnaroundHours: draft.turnaroundHours
  });

  // Prerequisite verification checklist
  const formatVerified = draft.formatKey === activeFormatKey;
  const creatorsVerified = draft.creatorIds.length > 0 && freshCreators.length === draft.creatorIds.length;
  const quantityVerified = draft.qty >= (isReaction ? 5 : 1);

  const missingPrerequisites = [];
  if (!creatorsVerified) {
    if (draft.creatorIds.length === 0) {
      missingPrerequisites.push('No creators selected on the creators page yet.');
    } else if (unavailableCreators.length > 0) {
      missingPrerequisites.push(`One or more creators (${unavailableCreators.map(c => c.name).join(', ')}) are currently unavailable.`);
    }
  }
  if (!quantityVerified) {
    missingPrerequisites.push(`Minimum order quantity for reaction format is 5 videos (currently ${draft.qty}).`);
  }

  const allPrerequisitesMet = formatVerified && creatorsVerified && quantityVerified && missingPrerequisites.length === 0;

  // 4. Format-Specific Field Customization (Reaction Format)
  const reactionRequirements = {
    formatType: 'reaction',
    formatLabel: 'Reaction Video',
    minVideos: 5,
    defaultTurnaroundHours: 48,
    supportedLayouts: [
      { id: 'split_screen', label: 'Split Screen (50/50 Top & Bottom)', description: 'Creator on top or bottom reacting in real-time to the media' },
      { id: 'picture_in_picture', label: 'Picture-in-Picture (PiP Corner)', description: 'Floating creator headshot over the full-screen source video' },
      { id: 'side_by_side', label: 'Side-by-Side (Left / Right)', description: 'Best for comparing two versions or high-impact reaction facial cues' }
    ],
    mandatoryFields: [
      { key: 'brandName', label: 'Brand Name', type: 'text', placeholder: 'e.g. Acme Health' },
      { key: 'sourceAssetUrl', label: 'Source Media URL to React To', type: 'url', placeholder: 'https://tiktok.com/@brand/video/... or YouTube / Drive link', required: true },
      { key: 'filmingInstructions', label: 'Filming Instructions', type: 'textarea', placeholder: 'Front-facing vertical camera, authentic facial expressions, good lighting' },
      { key: 'concepts', label: 'Reaction Concepts & Talking Points', type: 'array', minCount: 1, required: true }
    ],
    reactionSpecificFields: {
      sourceAssetUrl: draft.sourceAssetUrl || '',
      timestampsCallouts: draft.timestampsCallouts || '',
      reactionStyleGuidelines: draft.reactionStyleGuidelines || 'High energy, authentic disbelief turning into convinced excitement',
      layoutPreference: draft.layoutPreference || 'split_screen'
    },
    suggestedHooks: [
      "Wait, did you see that?! Let me pause this right now...",
      "I tried this so you don't have to, and I was NOT expecting this...",
      "Stop scrolling if you have [problem], watch what happens here...",
      "My genuine reaction to seeing this for the first time...",
      "I was 100% skeptical until I tested this myself..."
    ],
    suggestedTalkingPoints: [
      'Initial genuine skepticism or curiosity about the premise',
      'Pause/zoom moment: Point out key ingredient or feature in the source video',
      'Personal experience / demonstration validating the claim',
      'Clear, punchy call-to-action to check the link or buy now'
    ]
  };

  // Pre-configured concepts for reaction format if none yet saved
  const effectiveConcepts = draft.concepts.length > 0 ? draft.concepts : [
    {
      title: 'Concept 1',
      type: 'Reaction / footage',
      perCreator: Math.max(1, Math.round(draft.qty / Math.max(1, pricing.creatorCount))),
      script: 'Wait... are you telling me this actually works? Look at the difference in this video! I had to try it myself and the results speak for themselves.',
      hooks: ['Wait, did you see that?!', 'I was 100% skeptical...'],
      timestamps: '0:05 - pause & point, 0:20 - smile & show product'
    }
  ];

  return {
    success: true,
    orderId: draft.id,
    sessionId: draft.sessionId,
    format: activeFormatLabel,
    formatKey: activeFormatKey,
    status: draft.status,
    locked: draft.locked,
    prerequisites: {
      allMet: allPrerequisitesMet,
      formatVerified,
      creatorsVerified,
      quantityVerified,
      missing: missingPrerequisites
    },
    orderSummary: {
      qty: pricing.quantity,
      minVideos: pricing.minVideos,
      perCreator: pricing.perCreator,
      creatorCount: pricing.creatorCount,
      turnaroundHours: pricing.turnaroundHours,
      isRushTurnaround: pricing.isRushTurnaround,
      layoutPreference: draft.layoutPreference
    },
    verifiedCreators: pricing.creators,
    unavailableCreators,
    pricing,
    brief: {
      brandName: draft.brandName,
      aboutBrand: draft.aboutBrand,
      filmingInstructions: draft.filmingInstructions,
      sourceAssetUrl: draft.sourceAssetUrl,
      timestampsCallouts: draft.timestampsCallouts,
      reactionStyleGuidelines: draft.reactionStyleGuidelines,
      layoutPreference: draft.layoutPreference,
      concepts: effectiveConcepts
    },
    reactionRequirements,
    templates: getReactionTemplates('ecommerce', 'reaction')
  };
}

/**
 * 5. Final Brief Submission & Validation
 * Validates all mandatory reaction brief fields, locks pricing snapshot,
 * and advances order status to checkout or final confirmation.
 */
function submitAndLockReactionBrief(orderId, briefData, session = { id: 'default_session' }) {
  const existing = db.prepare('SELECT * FROM draft_orders WHERE id = ?').get(orderId);
  if (!existing) {
    throw new Error(`Draft order ${orderId} not found.`);
  }

  const current = parseDraftOrder(existing);
  const validationErrors = [];

  // Mandatory fields validation for reaction format
  const brandName = (briefData.brandName || current.brandName || '').trim();
  const sourceAssetUrl = (briefData.sourceAssetUrl || current.sourceAssetUrl || '').trim();
  const filmingInstructions = (briefData.filmingInstructions || current.filmingInstructions || '').trim();
  const aboutBrand = (briefData.aboutBrand || current.aboutBrand || '').trim();
  const concepts = Array.isArray(briefData.concepts) && briefData.concepts.length > 0 ? briefData.concepts : current.concepts;
  const layoutPreference = briefData.layoutPreference || current.layoutPreference || 'split_screen';
  const timestampsCallouts = (briefData.timestampsCallouts || current.timestampsCallouts || '').trim();
  const reactionStyleGuidelines = (briefData.reactionStyleGuidelines || current.reactionStyleGuidelines || '').trim();

  if (!brandName) {
    validationErrors.push('Brand name is required.');
  }

  // Validate Source Asset URL for reaction brief
  if (!sourceAssetUrl) {
    validationErrors.push('Reaction video format requires a Source Media URL (video to react to).');
  } else {
    try {
      const parsedUrl = new URL(sourceAssetUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        validationErrors.push('Source Media URL must start with http:// or https://');
      }
    } catch (e) {
      validationErrors.push('Source Media URL is not a valid URL.');
    }
  }

  if (!filmingInstructions && !aboutBrand) {
    validationErrors.push('Please provide filming instructions or product details for the creator.');
  }

  if (!concepts || concepts.length === 0) {
    validationErrors.push('At least one reaction video concept is required.');
  } else {
    concepts.forEach((concept, idx) => {
      if (!concept.script || !concept.script.trim()) {
        validationErrors.push(`Concept ${idx + 1} script / reaction talking points cannot be empty.`);
      }
    });
  }

  // Validate creator availability and minimums
  const creatorIds = Array.isArray(briefData.creatorIds) ? briefData.creatorIds : current.creatorIds;
  if (!creatorIds || creatorIds.length === 0) {
    validationErrors.push('Please select at least one creator from the creators page.');
  }

  const qty = Math.max(5, parseInt(briefData.qty || current.qty, 10));

  if (validationErrors.length > 0) {
    return {
      success: false,
      error: 'Brief validation failed',
      validationErrors
    };
  }

  // Authoritative server-side pricing recalculation
  const finalPricing = calculateAuthoritativePricing({
    creatorIds,
    quantity: qty,
    format: 'reaction',
    turnaroundHours: briefData.turnaroundHours || current.turnaroundHours || 48
  });

  // Verify all creators are active
  const unavailable = finalPricing.creators.filter(c => !c.available);
  if (unavailable.length > 0) {
    return {
      success: false,
      error: 'Selected creator(s) are currently unavailable',
      validationErrors: unavailable.map(u => `${u.name} is currently unavailable. Please pick an active creator.`)
    };
  }

  const verifiedCreators = finalPricing.creators.map(c => ({
    id: c.id,
    name: c.name,
    handle: c.handle,
    avatar: c.avatar,
    quota: c.assignedVideos,
    rate: c.baseRate,
    subtotal: c.subtotal
  }));

  // Lock in the verified pricing snapshot and update draft order status to 'ready_for_checkout'
  const updateStmt = db.prepare(`
    UPDATE draft_orders
    SET brand_name = ?, about_brand = ?, filming_instructions = ?,
        source_asset_url = ?, layout_preference = ?, timestamps_callouts = ?,
        reaction_style_guidelines = ?, concepts = ?, selected_creators = ?,
        creator_ids = ?, qty = ?, subtotal = ?, platform_fee = ?,
        tax = ?, discount = ?, total = ?,
        pricing_snapshot = ?, status = 'ready_for_checkout',
        prerequisites_completed = 1, locked = 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  updateStmt.run(
    brandName,
    aboutBrand,
    filmingInstructions,
    sourceAssetUrl,
    layoutPreference,
    timestampsCallouts,
    reactionStyleGuidelines,
    JSON.stringify(concepts),
    JSON.stringify(verifiedCreators),
    JSON.stringify(creatorIds),
    qty,
    finalPricing.subtotal,
    finalPricing.platformFee,
    finalPricing.tax,
    finalPricing.volumeDiscountAmount + finalPricing.customDiscountAmount,
    finalPricing.total,
    JSON.stringify(finalPricing),
    orderId
  );

  // Sync to open_orders or review state so checkout and tracking can immediately consume it
  try {
    const existingOrder = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
    if (!existingOrder) {
      db.prepare(`
        INSERT INTO orders (
          id, brief_id, session_id, status, brand_name, qty, rate, total, per_creator,
          selected_creators, concepts, created_at
        ) VALUES (?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        orderId,
        orderId,
        session.id || 'default_session',
        brandName,
        qty,
        finalPricing.effectiveRatePerVideo,
        finalPricing.total,
        finalPricing.perCreator,
        JSON.stringify(verifiedCreators),
        JSON.stringify(concepts)
      );
    }
  } catch (e) {
    console.warn('Orders table sync note:', e.message);
  }

  const verifiedOrder = {
    orderId,
    status: 'ready_for_checkout',
    locked: true,
    brandName,
    aboutBrand,
    filmingInstructions,
    format: 'Reaction Video',
    formatKey: 'reaction',
    sourceAssetUrl,
    layoutPreference,
    timestampsCallouts,
    reactionStyleGuidelines,
    qty,
    rate: finalPricing.effectiveRatePerVideo.toFixed(2),
    total: finalPricing.total.toFixed(2),
    perCreator: finalPricing.perCreator,
    pricing: finalPricing,
    concepts,
    selectedCreators: verifiedCreators,
    selectedCreatorsCount: verifiedCreators.length,
    checkoutUrl: `review_order.html?orderId=${encodeURIComponent(orderId)}&format=reaction`,
    lockedAt: new Date().toISOString()
  };

  return {
    success: true,
    message: 'Reaction brief validated and locked in. Ready for checkout.',
    orderId,
    status: 'ready_for_checkout',
    locked: true,
    verifiedOrder
  };
}

module.exports = {
  generateDraftOrderId,
  getOrCreateDraftOrder,
  updateDraftOrder,
  getReactionBriefViewData,
  submitAndLockReactionBrief,
  parseDraftOrder
};
