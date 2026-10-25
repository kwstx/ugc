const db = require('../db');
const { calculatePricing } = require('./pricingEngine');
const { analyzeScript } = require('./scriptEstimator');

/**
 * Intelligent AI Brief Generation Engine
 * Synthesizes brand details, positioning, filming instructions, and
 * timestamped creator scripts from free-form user descriptions.
 */

// Common niche definitions & keywords
const NICHE_PATTERNS = [
  {
    niche: 'Food & Nutrition',
    regex: /\b(meal|food|dinner|lunch|breakfast|prep|recipe|kitchen|cook|snack|protein|nutrition|diet|eat|calories|grocery|groceries|freshplate)\b/i,
    defaultBrand: 'FreshPlate',
    sampleSetting: 'bright kitchen with natural counter lighting',
    features: ['15-minute chef recipes', 'automated grocery list', 'custom macro goals'],
    emotions: {
      surprised: "Gasps while looking into phone, jaw open: 'Wait... are you kidding me right now?! Look at these recipes.'",
      excited: "Huge genuine smile: 'Best discovery I've made all year! Weeknight dinner is actually fun now.'",
      relieved: "Sighs with pure relief: 'No more staring blankly into an empty fridge after work. Everything is done for me.'"
    }
  },
  {
    niche: 'Beauty & Skincare',
    regex: /\b(skin|skincare|serum|cream|glow|acne|wrinkle|hydration|beauty|face|routine|dull|radiance|lumiere|cleanse)\b/i,
    defaultBrand: 'Lumiere Skin',
    sampleSetting: 'well-lit bathroom mirror or vanity with natural morning light',
    features: ['instant deep hydration', 'dermatologist-tested soothing formula', 'visible glow in 3 days'],
    emotions: {
      surprised: "Touches cheek with genuine disbelief: 'I did not think a serum could do this in 48 hours. Look at this glass glow.'",
      excited: "Holding bottle up to camera, smiling: 'My skin has literally never felt this soft. I finally found my holy grail!'",
      relieved: "Gentle smile, speaking softly: 'After struggling with dry, irritated skin all winter, my face is finally calm and happy.'"
    }
  },
  {
    niche: 'Fitness & Health',
    regex: /\b(fitness|workout|gym|exercise|muscle|train|running|lifting|coach|weight|sweat|gains|pulse|active)\b/i,
    defaultBrand: 'Pulse Fitness',
    sampleSetting: 'home workout area or gym setting with crisp, bright lighting',
    features: ['personalized adaptive workout plans', 'form tracking AI', 'fast 20-minute daily routines'],
    emotions: {
      surprised: "Catching breath, smiling: '20 minutes and I'm drenched. This app pushed me harder than my actual trainer.'",
      excited: "High energy, showing app screen: 'Down 6 pounds and PR-ing my lifts! This workout routine is unmatched.'",
      relieved: "Relaxed post-workout stretch: 'Finally a program that fits into a crazy work schedule without burning me out.'"
    }
  },
  {
    niche: 'Productivity & Tech Apps',
    regex: /\b(app|saas|software|productivity|tool|ai|workflow|automate|organize|task|calendar|notes|work|study|focus)\b/i,
    defaultBrand: 'Nova AI',
    sampleSetting: 'clean desk workspace with laptop or phone in clear focus',
    features: ['one-click workflow automation', 'smart AI summaries', 'cross-device sync in real time'],
    emotions: {
      surprised: "Stares at screen, eyes wide: 'Wait, did this just do 3 hours of work in literally 10 seconds?!'",
      excited: "Typing and showing phone screen: 'I am never working without this app again. Absolute game changer.'",
      relieved: "Leaning back in desk chair: 'Inbox zero and my whole week planned out before noon. The stress is gone.'"
    }
  },
  {
    niche: 'Dating & Relationships',
    regex: /\b(dating|date|match|relationship|couple|love|meet|single|flirt|banter)\b/i,
    defaultBrand: 'Spark Dating',
    sampleSetting: 'cozy living room couch or casual cafe atmosphere',
    features: ['algorithm that matches based on actual conversational vibe', 'zero ghosting prompts', 'verified authentic profiles'],
    emotions: {
      surprised: "Phone vibrates, genuine shock: 'No way... someone who actually answered my prompt with an original thought?!'",
      excited: "Showing match screen, blushing slightly: 'Okay, I might have just found my soulmate on here.'",
      relieved: "Laughing into camera: 'Dating apps usually drain me, but the conversations on here are actually refreshing.'"
    }
  }
];

/**
 * Extract brand name from user text
 */
function extractBrandName(text) {
  if (!text) return 'Our Brand';

  // Pattern 1: Explicit "called [Brand]" or "named [Brand]"
  const calledMatch = text.match(/\b(?:called|named)\s+["']?([A-Za-z0-9&.\-_]+)/i);
  if (calledMatch && calledMatch[1] && !/^(an?|the|our|this|natural|quick|short)$/i.test(calledMatch[1].trim())) {
    return calledMatch[1].replace(/["']/g, '').trim();
  }

  // Pattern 2: "brand is [Brand]" or "brand [Brand]"
  const brandMatch = text.match(/\b(?:brand(?:\s+is)?|app(?:\s+is)?)\s+["']?([A-Z][a-zA-Z0-9&.\-_]+)/i);
  if (brandMatch && brandMatch[1] && !/^(called|named|an?|the|our|this|natural|quick|short)$/i.test(brandMatch[1].trim())) {
    return brandMatch[1].replace(/["']/g, '').trim();
  }

  // Pattern 3: "We're a [niche] app [Brand]" or "We're [Brand]"
  const wereMatch = text.match(/\b(?:We're|We are)\s+(?:a|an)?\s*(?:new\s+)?(?:[a-z-]+\s+)*(?:app|brand|company|team|service)?\s*([A-Z][a-zA-Z0-9&.\-_]+)/);
  if (wereMatch && wereMatch[1] && !/^(called|named|looking|needing|hoping)$/i.test(wereMatch[1].trim())) {
    return wereMatch[1].trim();
  }

  // Pattern 3: Look for capitalized brand words (e.g. "FreshPlate", "Lumiere", "Engram")
  const capitalizedWords = text.match(/\b[A-Z][a-zA-Z0-9]{3,}\b/g);
  if (capitalizedWords && capitalizedWords.length > 0) {
    const candidate = capitalizedWords.find(w => !/^(We|The|For|Our|Here|With|And|You|Tell|Like|Make|Need|What)$/i.test(w));
    if (candidate) return candidate;
  }

  // Pattern 4: Fallback based on niche
  for (const p of NICHE_PATTERNS) {
    if (p.regex.test(text)) {
      return p.defaultBrand;
    }
  }

  return 'Our Brand';
}

/**
 * Detect requested setting or location
 */
function extractFilmingSetting(text) {
  const settings = [
    { regex: /kitchen/i, setting: 'bright kitchen with natural counter lighting' },
    { regex: /bathroom|mirror|vanity/i, setting: 'clean bathroom vanity with warm, natural mirror lighting' },
    { regex: /gym|workout|fitness/i, setting: 'energizing fitness space or gym setting' },
    { regex: /bed|bedroom|morning/i, setting: 'cozy morning bedroom setting with soft natural window light' },
    { regex: /desk|office|workspace|laptop/i, setting: 'organized desk workspace with natural window illumination' },
    { regex: /outdoor|car|street|outside/i, setting: 'outdoor daylight setting with clean natural audio' }
  ];

  for (const s of settings) {
    if (s.regex.test(text)) return s.setting;
  }
  return 'well-lit indoor setting with bright, natural lighting and minimal background clutter';
}

/**
 * Extract requested quantities (e.g. "5 videos", "6 videos")
 */
function extractRequestedQty(text, defaultQty = 6) {
  const match = text.match(/\b(\d+)\s*(?:videos?|clips?|reactions?|ugc)\b/i);
  if (match && match[1]) {
    const parsed = parseInt(match[1], 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 50) {
      return parsed;
    }
  }
  return defaultQty;
}

/**
 * Curated Niche Reaction Templates
 */
const REACTION_TEMPLATES = [
  {
    id: 'ecommerce_unboxing',
    name: 'E-Commerce Gadget & Unboxing',
    niche: 'E-commerce',
    format: 'Reaction Video',
    description: 'Natural high-converting reactions unboxing or testing a viral physical product.',
    promptText: "We sell an innovative magnetic wireless charger called MagSnap. We need 5 candid reaction videos in a clean bedroom or desk: 2 shocked at how fast it snaps into place, 2 excited first impressions, and 1 relieved at ditching cable clutter.",
    sampleAngles: ['Shocked Magnet Grip', 'Clean Desk Relief', 'Travel Setup Excitement'],
    creatorCount: 2,
    suggestedQty: 6
  },
  {
    id: 'mobile_app_workflow',
    name: 'Mobile App / SaaS Time-Saver',
    niche: 'Mobile Applications',
    format: 'Reaction Video',
    description: 'Authentic creator reactions discovering an effortless AI productivity or lifestyle app.',
    promptText: "We are an AI calendar and meal-planning app called FreshPlate. We need 5 natural reaction videos in a bright kitchen: 2 surprised at how fast meal plans generate, 2 excited about saving grocery money, and 1 relieved that dinner stress is solved.",
    sampleAngles: ['Jaw-Drop Speed', 'Instant Relief', 'High-Energy First Impression'],
    creatorCount: 2,
    suggestedQty: 6
  },
  {
    id: 'beauty_skincare_glow',
    name: 'Beauty & Skincare Instant Glow',
    niche: 'Beauty & Skincare',
    format: 'Reaction Video',
    description: 'Raw, filter-free reactions testing texture and visible hydration on camera.',
    promptText: "We are Lumiere Skin, a barrier-repair hydration serum. We need 5 candid mirror reaction videos: 2 surprised at the instant dewy finish with zero stickiness, 2 excited about the 3-day glow, and 1 relieved after dealing with winter dryness.",
    sampleAngles: ['Zero-Stickiness Surprise', 'Glass-Skin Excitement', 'Calm Skin Relief'],
    creatorCount: 2,
    suggestedQty: 6
  },
  {
    id: 'fitness_nutrition_taste',
    name: 'Fitness & Nutrition Taste Test',
    niche: 'Food & Nutrition',
    format: 'Reaction Video',
    description: 'Genuine taste-test and energy boost reactions without scripted corporate vibes.',
    promptText: "We make clean plant protein bars called RawFuel that actually taste like brownie dough. We need 6 honest reaction clips: 2 surprised disbelief at the taste with zero chalkiness, 2 pumped post-workout hype, and 2 relieved that daily macros are easy.",
    sampleAngles: ['Chalk-Free Disbelief', 'Post-Workout Energy Hype', 'Macro Relief'],
    creatorCount: 2,
    suggestedQty: 6
  }
];

/**
 * Main AI Brief Generator
 */
async function generateAiBrief({
  description = '',
  brandName = '',
  brandDetails = '',
  aboutBrand = '',
  format = 'Reaction Video',
  selectedCreators = [],
  creatorCount = null,
  requestedQty = null
}) {
  const cleanDesc = (description || '').trim();
  const detectedBrand = brandName ? brandName.trim() : extractBrandName(cleanDesc);
  const filmingSetting = extractFilmingSetting(cleanDesc);
  const isFullUgc = Boolean(format && format.toLowerCase().includes('full'));
  const effectiveFormat = isFullUgc ? 'Full UGC' : 'Reaction Video';

  // Match or detect niche
  let matchedNiche = NICHE_PATTERNS.find(p => p.regex.test(cleanDesc)) || NICHE_PATTERNS[0];

  // Synthesize "About the brand"
  let synthesizedAbout = (aboutBrand || brandDetails || '').trim();
  if (!synthesizedAbout) {
    if (cleanDesc.length > 25) {
      synthesizedAbout = `${detectedBrand} is an innovative ${matchedNiche.niche.toLowerCase()} product. ${cleanDesc.charAt(0).toUpperCase() + cleanDesc.slice(1)}. Designed to provide authentic customer delight and tangible daily results.`;
    } else {
      synthesizedAbout = `${detectedBrand} is a leading ${matchedNiche.niche.toLowerCase()} brand designed to solve everyday customer problems with ${matchedNiche.features.join(', ')}.`;
    }
  }

  // Synthesize Filming Instructions (Tailored 9:16 vertical guidelines)
  const verticalGuidelines = [
    'Film vertically in 9:16 portrait orientation (1080x1920 minimum, 60fps preferred).',
    'Eye-level camera framing with face clearly in focus and clean natural lighting.',
    'Hold your phone or product clearly visible in hands within the first 2 seconds.',
    'Zero background echo and no background music; crisp, audible voice audio only.',
    'Deliver candid, unedited raw takes with natural facial expressions (gasps, genuine smiles, disbelief).'
  ];

  const filmingInstructions = isFullUgc
    ? `Film vertically (9:16) in 1080p 60fps or 4K in a ${filmingSetting}. Ensure audio is clean and clear with zero background echo. Show product or screen clearly in hands within the first 2 seconds. Deliver 3 smooth camera angles: direct conversational hook, hands-on demonstration B-roll, and final enthusiastic payoff.`
    : `Film vertically (9:16) with eye-level framing in a ${filmingSetting}. Deliver high-energy, authentic, and candid facial expressions. Audio must be clear with no background music. Hold your phone or product clearly visible in frame during the first 2 seconds. Reactions should feel genuine, candid, and unscripted.\n\nKey 9:16 Guidelines:\n• ${verticalGuidelines.join('\n• ')}`;

  // Parse specific requested emotions / angles (e.g. "2 surprised, 2 excited, 1 relieved")
  const hasSurprised = /surpris|shock|disbelief|jaw|gasp|whoa|what/i.test(cleanDesc);
  const hasExcited = /excit|happy|pumped|love|energy|best|hyped/i.test(cleanDesc);
  const hasRelieved = /relie|peace|stress|easy|effortless|finally|calm/i.test(cleanDesc);
  const hasCurious = /curious|skeptic|wonder|honest|doubt|try/i.test(cleanDesc);

  const conceptTemplates = [];

  // Concept 1: Surprise / Shocked Disbelief
  if (hasSurprised || (!hasExcited && !hasRelieved && !hasCurious)) {
    conceptTemplates.push({
      title: 'Concept 1: Shocked Disbelief Hook',
      type: 'Reaction / footage',
      emotionalAngle: 'Surprise / Shocked Disbelief',
      facialExpression: 'Gasps while looking directly into camera/screen, eyes wide open, authentic jaw-drop',
      cameraFraming: '9:16 Vertical eye-level portrait framing',
      hookText: `Wait... are you kidding me right now?! Look at ${detectedBrand}.`,
      script: `[0-3s Facial Expression & Hook] (Gasps while looking directly into camera/screen, eyes wide open, showing genuine disbelief) 'Wait... are you kidding me right now?!'\n[3-10s Core Reaction] (Holds phone/product clearly visible in hands) 'I thought everyone was exaggerating about ${detectedBrand}, but it literally solved my biggest issue in two minutes.'\n[10-18s Value Demonstration] (Tilts camera to product/screen in natural light) 'The interface is so seamless, look how easy this is to navigate.'\n[18-25s Natural CTA] 'Do not sleep on this. Check the link below before their current batch sells out!'`
    });
  }

  // Concept 2: High-Energy First Impression / Excitement
  if (hasExcited || conceptTemplates.length < 2) {
    conceptTemplates.push({
      title: 'Concept 2: High-Energy First Impression',
      type: isFullUgc ? 'Talking script' : 'Reaction / footage',
      emotionalAngle: 'Excitement / High-Energy Hype',
      facialExpression: 'Huge genuine smile, animated hand gestures, head nod of approval',
      cameraFraming: '9:16 Vertical medium close-up, dynamic natural light',
      hookText: `Best decision I've made all month, hands down.`,
      script: `[0-3s Facial Expression & Hook] (Huge genuine smile, showing excitement and nodding) 'Best decision I have made all month, hands down.'\n[3-10s Story/Pain Point] (Holds up ${detectedBrand} proudly) 'I was so skeptical because I have tried practically everything on the market, but this actually delivered on day one.'\n[10-18s Solution & Benefit] 'It saves me hours every single week, and the quality is completely unmatched.'\n[18-25s Strong CTA] 'Stop overthinking it—tap the link below and try ${detectedBrand} for yourself today!'`
    });
  }

  // Concept 3: Relief & Routine Problem-Solver
  if (hasRelieved || conceptTemplates.length < 3) {
    conceptTemplates.push({
      title: 'Concept 3: Relief & Routine Problem-Solver',
      type: isFullUgc ? 'Talking script' : 'Reaction / footage',
      emotionalAngle: 'Relief & Effortless Satisfaction',
      facialExpression: 'Exhales with a relaxed smile, leaning back comfortably in chair/couch',
      cameraFraming: '9:16 Vertical eye-level relaxed framing',
      hookText: `That feeling when your daily routine is finally effortless.`,
      script: `[0-3s Facial Expression & Hook] (Exhales with a relaxed smile, shoulders dropping with relief) 'That feeling when you finally find something that just works.'\n[3-10s Empathy & Relatability] 'Dealing with everyday stress used to feel overwhelming until I incorporated ${detectedBrand} into my routine.'\n[10-18s Transformation] (Shows calm, easy interaction with product) 'It takes all the friction away. It feels like having a personal assistant in your pocket.'\n[18-25s Soft CTA] 'Save your sanity and check out ${detectedBrand} at the link below. You will thank me later.'`
    });
  }

  // Calculate creators and quantities (Enforce 5-video minimum for Reaction format)
  const validCreatorCount = creatorCount
    ? Math.max(1, parseInt(creatorCount, 10))
    : (Array.isArray(selectedCreators) && selectedCreators.length > 0 ? selectedCreators.length : 2);

  const parsedRequested = requestedQty ? parseInt(requestedQty, 10) : extractRequestedQty(cleanDesc, validCreatorCount * 3);
  const minRequired = isFullUgc ? 1 : 5;
  const effectiveQty = Math.max(minRequired, isNaN(parsedRequested) ? 6 : parsedRequested);

  const pricing = calculatePricing(effectiveQty, validCreatorCount, effectiveFormat);

  // Distribute per-creator count among concepts
  const totalConcepts = Math.max(1, conceptTemplates.length);
  const basePerCreator = Math.max(1, Math.floor(pricing.perCreator / totalConcepts));
  let remainder = pricing.perCreator % totalConcepts;

  const analyzedConcepts = conceptTemplates.map((tmpl, idx) => {
    const conceptPerCreator = basePerCreator + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;

    const conceptQty = conceptPerCreator * validCreatorCount;
    const subtotal = parseFloat((conceptQty * pricing.rate).toFixed(2));

    return {
      title: tmpl.title,
      type: tmpl.type,
      emotionalAngle: tmpl.emotionalAngle,
      facialExpression: tmpl.facialExpression,
      cameraFraming: tmpl.cameraFraming,
      hookText: tmpl.hookText,
      script: tmpl.script,
      perCreator: conceptPerCreator,
      qty: conceptQty,
      rate: pricing.rate,
      subtotal,
      analysis: analyzeScript(tmpl.script)
    };
  });

  // Save brief draft to SQLite database
  const briefId = `brief_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  try {
    const insertStmt = db.prepare(`
      INSERT INTO briefs (
        id, session_id, brand_name, about_brand, filming_instructions,
        qty, rate, total, per_creator, selected_creators, concepts, status
      ) VALUES (?, 'guest_session', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
    `);

    insertStmt.run(
      briefId,
      detectedBrand,
      synthesizedAbout,
      filmingInstructions,
      pricing.quantity,
      pricing.rate,
      pricing.total,
      pricing.perCreator,
      JSON.stringify(selectedCreators),
      JSON.stringify(analyzedConcepts)
    );
  } catch (err) {
    console.error('Failed to insert AI-generated brief into database:', err);
  }

  return {
    briefId,
    brief: {
      id: briefId,
      brandName: detectedBrand,
      aboutBrand: synthesizedAbout,
      filmingInstructions,
      format: effectiveFormat,
      qty: pricing.quantity,
      minVideos: minRequired,
      rate: pricing.rate,
      total: pricing.total,
      perCreator: pricing.perCreator,
      selectedCreators,
      verticalGuidelines,
      emotionalAngles: conceptTemplates.map(c => ({ angle: c.emotionalAngle, facialExpression: c.facialExpression, hook: c.hookText })),
      concepts: analyzedConcepts,
      createdAt: new Date().toISOString()
    }
  };
}

/**
 * Suggest reaction concepts and emotional hooks for a brand/product
 */
function suggestReactions({ description = '', productUrl = '', brandName = '', niche = '' }) {
  const text = `${description} ${niche} ${productUrl}`.trim();
  const resolvedBrand = brandName || extractBrandName(text);

  return {
    success: true,
    brandName: resolvedBrand,
    suggestions: [
      {
        angle: 'Shocked Disbelief',
        hook: `Wait... are you kidding me right now?! Look at ${resolvedBrand}.`,
        facialExpression: 'Eyes wide open, instant gasp, holding up screen or product with authentic astonishment.',
        visualCue: 'Direct eye contact in first 2s, quick cut to demonstration.',
        sampleContext: 'Ideal for instant results, innovative gadgets, or surprising features.'
      },
      {
        angle: 'High-Energy First Impression',
        hook: `Best decision I've made all month, hands down.`,
        facialExpression: 'Enthusiastic smile, energetic nod, unscripted laugh of joy.',
        visualCue: 'Unboxing or hands-on use in natural 9:16 portrait framing.',
        sampleContext: 'High-converting for beauty glow, fashion, food taste test, or gaming.'
      },
      {
        angle: 'Relief / Problem-Solver',
        hook: `That feeling when your daily routine is finally effortless.`,
        facialExpression: 'Deep exhale, relaxed smile, visible tension leaving face.',
        visualCue: 'Comfortable indoor setting (kitchen, living room, clean desk).',
        sampleContext: 'Perfect for productivity apps, organization tools, and wellness.'
      },
      {
        angle: 'Skeptic Turned Believer',
        hook: `I 100% thought this was another hyped-up gimmick... until I tested it.`,
        facialExpression: 'Slight head shake turning into an appreciative grin and eyebrow raise.',
        visualCue: 'Side-by-side or hands-on comparison with raw unfiltered audio.',
        sampleContext: 'Great for conquering buyer skepticism and building immediate trust.'
      }
    ],
    verticalFilmingTips: [
      'Record in native 9:16 vertical resolution at 60fps.',
      'Ensure the face is positioned in the upper two-thirds to avoid UI button overlay obstruction.',
      'Deliver genuine expressions without robotic pauses or scripted rehearsed cadence.'
    ]
  };
}

/**
 * Retrieve curated niche templates
 */
function getReactionTemplates(niche = null, format = 'reaction') {
  if (!niche) return REACTION_TEMPLATES;
  const filtered = REACTION_TEMPLATES.filter(t =>
    t.niche.toLowerCase().includes(niche.toLowerCase()) ||
    t.name.toLowerCase().includes(niche.toLowerCase())
  );
  return filtered.length > 0 ? filtered : REACTION_TEMPLATES;
}

module.exports = {
  generateAiBrief,
  extractBrandName,
  extractFilmingSetting,
  suggestReactions,
  getReactionTemplates,
  REACTION_TEMPLATES
};

