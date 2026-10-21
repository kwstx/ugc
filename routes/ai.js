const express = require('express');
const router = express.Router();
const { analyzeScript } = require('../services/scriptEstimator');

/**
 * High-performing UGC script templates and patterns
 */
const UGC_TEMPLATES = {
  'Reaction / footage': {
    hooks: [
      "I was honestly skeptical about {brand}, but wait until you see this...",
      "Stop scrolling if you've been dealing with {benefit_target}!",
      "Okay, I rarely do these, but this literally changed my routine."
    ],
    scripts: [
      "[0-3s Hook] (Hold up product with genuine surprise) 'Wait, is this actually working or am I dreaming?'\n[3-10s Demonstration] (Apply/show product in natural light) 'I've tried so many alternatives, but {brand} actually delivered within 3 days.'\n[10-20s Reaction] (Close-up face expression, smiling) '{aboutBrand} — look at the texture and feel.'\n[20-25s CTA] 'Tap the link below before the current batch sells out!'"
    ]
  },
  'Talking script': {
    hooks: [
      "3 reasons why everyone on my feed won't stop talking about {brand}...",
      "If you're still doing {benefit_target} the hard way, you need to watch this.",
      "The one thing I wish I knew before trying {brand}."
    ],
    scripts: [
      "[0-5s Hook] 'If you're tired of wasting money on products that overpromise, listen to this.'\n[5-15s Story] 'A friend recommended {brand} to me because {aboutBrand}. I was hesitant at first.'\n[15-25s Social Proof] 'After just one week, the difference was undeniable.'\n[25-30s CTA] 'Check out {brand} at the link below — you will thank me later!'"
    ]
  },
  'Crying / emotions': {
    hooks: [
      "I promised myself I wouldn't cry making this video, but...",
      "This is vulnerable for me to share, but I know someone out there needs to hear this."
    ],
    scripts: [
      "[0-5s Raw Emotion] (Deep breath, emotional eye contact) 'I almost didn't post this, but {brand} honestly gave me my confidence back.'\n[5-18s Emotional story] 'For months I struggled with {benefit_target}. Nothing felt right until I found {aboutBrand}.'\n[18-25s Relief & Gratitude] 'To finally find something that just works means everything.'\n[25-30s Gentle CTA] 'If you're going through the same thing, try {brand}. Link in bio.'"
    ]
  },
  'Lip-sync': {
    hooks: [
      "Trending sound sync showing before vs after {brand}",
      "Point and sync to audio beat drops showcasing {brand}"
    ],
    scripts: [
      "[0-4s Audio Intro] (Mouth the trending audio question: 'You're telling me you found the perfect solution?')\n[4-10s Beat Drop] (Quick snap transition to using {brand})\n[10-18s Upbeat visual pacing] (Holding packaging, showing real results in quick energetic cuts)\n[18-22s Outro] (Text on screen: 'Link in bio for 20% off {brand}')"
    ]
  }
};

/**
 * POST /api/ai/script-helper
 * Generates hooks, refines text, or writes high-converting UGC briefs
 */
router.post('/script-helper', async (req, res) => {
  try {
    const {
      mode = 'generate', // 'generate' | 'polish' | 'hook' | 'cta'
      brandName = 'Our Brand',
      aboutBrand = 'innovative product solving everyday problems',
      conceptType = 'Reaction / footage',
      currentScript = ''
    } = req.body;

    const templateCategory = UGC_TEMPLATES[conceptType] || UGC_TEMPLATES['Reaction / footage'];

    let generatedScript = '';
    let suggestedHooks = [];
    let ctaSuggestions = [
      `Click the link below to get yours with free shipping!`,
      `Head over to ${brandName}'s site now before it sells out again.`,
      `Tap the shop button to try ${brandName} risk-free for 30 days.`
    ];

    if (mode === 'hook') {
      suggestedHooks = templateCategory.hooks.map(h =>
        h.replace(/{brand}/g, brandName).replace(/{benefit_target}/g, 'this issue')
      );
      generatedScript = suggestedHooks[0];
    } else if (mode === 'cta') {
      generatedScript = ctaSuggestions[0];
    } else if (mode === 'polish' && currentScript.trim()) {
      // Polish current script: improve hook sharpness, structure timing beats
      const lines = currentScript.trim().split('\n');
      generatedScript = `[0-3s Hook - Enhanced]\n${lines[0] || `Wait, you have to see this from ${brandName}!`}\n\n[3-20s Body / Visual Demonstration]\n${lines.slice(1).join('\n') || `Showing how ${brandName} works in natural lighting with authentic facial expressions.`}\n\n[20-25s Strong CTA]\nCheck out ${brandName} today at the link below!`;
    } else {
      // Generate full script
      const raw = templateCategory.scripts[0];
      generatedScript = raw
        .replace(/{brand}/g, brandName)
        .replace(/{aboutBrand}/g, aboutBrand)
        .replace(/{benefit_target}/g, 'finding the right solution');

      suggestedHooks = templateCategory.hooks.map(h =>
        h.replace(/{brand}/g, brandName).replace(/{benefit_target}/g, 'this problem')
      );
    }

    const analysis = analyzeScript(generatedScript);

    res.json({
      success: true,
      mode,
      conceptType,
      script: generatedScript,
      suggestedHooks,
      ctaSuggestions,
      analysis
    });
  } catch (error) {
    console.error('Error in AI script helper:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const db = require('../db');

/**
 * Helper to decode common HTML entities from scraped meta tags
 */
function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract meta content by name or property from HTML string
 */
function extractMetaTag(html, attrValue) {
  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex1 = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i');
  const regex2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, 'i');
  const match = html.match(regex1) || html.match(regex2);
  return match ? decodeHtmlEntities(match[1]) : '';
}

/**
 * Known brand / category profiles and intelligent product classifier
 */
const KNOWN_PRODUCT_PROFILES = {
  engram: {
    brandName: 'Engram',
    niche: 'Dating & Relationships',
    summary: 'Engram is a dating app that utilizes AI to help users find meaningful, compatible matches faster.',
    keywords: ['dating', 'relationships', 'couples', 'app', 'ai', 'social']
  },
  tinder: {
    brandName: 'Tinder',
    niche: 'Dating & Relationships',
    summary: 'Tinder is a mobile dating and social discovery app connecting people based on mutual interest and location.',
    keywords: ['dating', 'relationships', 'couples', 'phone', 'skits']
  },
  hinge: {
    brandName: 'Hinge',
    niche: 'Dating & Relationships',
    summary: 'Hinge is a relationship-focused dating app designed to be deleted by sparking conversations over profile prompts.',
    keywords: ['dating', 'relationships', 'couples', 'talking head']
  },
  duolingo: {
    brandName: 'Duolingo',
    niche: 'Education & Study',
    summary: 'Duolingo is a gamified language-learning app that helps users practice reading, writing, and speaking in bite-sized lessons.',
    keywords: ['education', 'study', 'app demo', 'mobile', 'funny', 'skits']
  },
  notion: {
    brandName: 'Notion',
    niche: 'Productivity & Work',
    summary: 'Notion is an all-in-one AI workspace where individuals and teams write, plan, organize tasks, and collaborate.',
    keywords: ['productivity', 'work', 'app demo', 'talking head', 'greenscreen']
  },
  stripe: {
    brandName: 'Stripe',
    niche: 'Productivity & Work',
    summary: 'Stripe is financial infrastructure and payment processing software built for internet businesses and apps.',
    keywords: ['productivity', 'work', 'tech', 'talking head', 'product demo']
  },
  shopify: {
    brandName: 'Shopify',
    niche: 'Productivity & Work',
    summary: 'Shopify is a commerce platform that enables brands to launch, manage, and scale online and retail stores.',
    keywords: ['productivity', 'work', 'product demo', 'talking head']
  },
  calm: {
    brandName: 'Calm',
    niche: 'Sleep & Wellness',
    summary: 'Calm is a mental wellness and meditation app designed to improve sleep quality, lower stress, and build mindfulness.',
    keywords: ['sleep', 'wellness', 'emotional', 'relief', 'health']
  }
};

const NICHE_RULES = [
  {
    niche: 'Dating & Relationships',
    clipCategories: ['Dating', 'Relationships'],
    regex: /\b(dating|date|match|single|relationship|romance|couple|love|meet people|flirt|engram)\b/i,
    creatorSpecialties: {
      creator_2: 'Dating & lifestyle reaction hooks',
      creator_5: 'High-retention viral reaction clips',
      creator_4: 'Relatable relationship storytelling',
      creator_1: 'App walkthroughs & social proof'
    }
  },
  {
    niche: 'Health & Fitness',
    clipCategories: ['Health & Fitness', 'Sleep & Wellness', 'Nutrition & Food', "Women's Health", 'Gut Health'],
    regex: /\b(fitness|workout|gym|health|wellness|sleep|nutrition|protein|supplement|vitamin|skincare|beauty|diet|weight|hydration|yoga|run)\b/i,
    creatorSpecialties: {
      creator_6: 'Fitness, workout & active lifestyle UGC',
      creator_4: 'Wellness & daily routine testimonials',
      creator_1: 'Product demonstration & before/after hooks',
      creator_3: 'Authentic health & transformation reviews'
    }
  },
  {
    niche: 'Education & Study',
    clipCategories: ['Education & Study', 'Productivity & Work'],
    regex: /\b(learn|study|course|education|language|student|school|tutor|quiz|flashcard|academy|book|read)\b/i,
    creatorSpecialties: {
      creator_1: 'Mobile app demos & study hacks',
      creator_2: 'Gen-Z student & learning reactions',
      creator_5: 'Scroll-stopping curiosity hooks',
      creator_3: 'Clear educational explainers'
    }
  },
  {
    niche: 'Productivity & AI Tech',
    clipCategories: ['Productivity & Work', 'Education & Study'],
    regex: /\b(ai|software|saas|app|platform|tool|workflow|automate|productivity|workspace|cloud|analytics|crm|dev|code|finance|pay|bank|crypto|shop|store)\b/i,
    creatorSpecialties: {
      creator_1: 'SaaS & mobile app green-screen demos',
      creator_3: 'Tech founder & productivity talking-head reviews',
      creator_5: 'Mind-blown tech reaction hooks',
      creator_2: 'Creator workflow & app discovery clips'
    }
  }
];

/**
 * POST /api/ai/analyze-brand
 * Fetches and analyzes a website or App Store link, summarizes the product,
 * and searches the database for suitable UGC creators and reaction clips.
 */
router.post('/analyze-brand', async (req, res) => {
  try {
    const rawInput = String(req.body?.url || '').trim();
    if (!rawInput) {
      return res.status(400).json({ success: false, error: 'Website or App Store link is required.' });
    }

    // Normalize URL
    let targetUrl = rawInput;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (_) {
      parsedUrl = new URL('https://' + rawInput.replace(/\s+/g, ''));
    }

    const hostname = parsedUrl.hostname.replace(/^www\./i, '');
    const domainParts = hostname.split('.');
    const baseKey = (domainParts[0] || 'brand').toLowerCase();

    // Check if it's an App Store or Google Play link
    const isAppStore = /apps\.apple\.com|itunes\.apple\.com/i.test(hostname);
    const isPlayStore = /play\.google\.com/i.test(hostname);

    let scrapedTitle = '';
    let scrapedSiteName = '';
    let scrapedDescription = '';
    let scrapedH1 = '';

    // Attempt live HTTP fetch with a fast timeout (3.5s) to analyze the real product page
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const response = await fetch(parsedUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const html = (await response.text()).slice(0, 120000);
        scrapedSiteName = extractMetaTag(html, 'og:site_name') || extractMetaTag(html, 'application-name');
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        scrapedTitle = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';
        scrapedDescription =
          extractMetaTag(html, 'description') ||
          extractMetaTag(html, 'og:description') ||
          extractMetaTag(html, 'twitter:description');
        const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (h1Match) {
          scrapedH1 = decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, ' '));
        }
      }
    } catch (_) {
      // Site offline or blocked automated fetch; fallback to intelligent domain/URL analyzer below
    }

    // 1. Determine Brand Name
    let brandName = '';
    const knownProfile = KNOWN_PRODUCT_PROFILES[baseKey];

    if (knownProfile) {
      brandName = knownProfile.brandName;
    } else if (isAppStore) {
      const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
      const appSlug = pathSegments.find(seg => seg !== 'app' && !/^id\d+$/i.test(seg) && seg.length > 2);
      if (scrapedTitle) {
        brandName = scrapedTitle.replace(/\s+on the App\s*Store.*$/i, '').split(/[|\-–—:]/)[0].trim();
      } else if (appSlug) {
        brandName = appSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      } else {
        brandName = 'App';
      }
    } else if (isPlayStore) {
      const appId = parsedUrl.searchParams.get('id') || '';
      const lastSeg = appId.split('.').pop() || 'App';
      brandName = scrapedTitle
        ? scrapedTitle.replace(/\s*-\s*Apps on Google Play.*$/i, '').split(/[|\-–—:]/)[0].trim()
        : lastSeg.charAt(0).toUpperCase() + lastSeg.slice(1);
    } else if (scrapedSiteName && scrapedSiteName.length <= 32) {
      brandName = scrapedSiteName;
    } else if (scrapedTitle) {
      const cleanTitle = scrapedTitle.split(/\s+[|\-–—:]\s+/)[0].trim();
      brandName = cleanTitle.length >= 2 && cleanTitle.length <= 28
        ? cleanTitle
        : baseKey.charAt(0).toUpperCase() + baseKey.slice(1);
    } else {
      brandName = baseKey.charAt(0).toUpperCase() + baseKey.slice(1);
    }

    // 2. Summarize what the product does
    let fullSummary = '';
    if (knownProfile && !scrapedDescription) {
      fullSummary = knownProfile.summary;
    } else if (scrapedDescription && scrapedDescription.length > 20) {
      // Ensure summary mentions the brand clearly
      const desc = scrapedDescription.replace(/\s+/g, ' ').trim();
      if (desc.toLowerCase().startsWith(brandName.toLowerCase())) {
        fullSummary = desc;
      } else {
        fullSummary = `${brandName} — ${desc.charAt(0).toUpperCase() + desc.slice(1)}`;
      }
    } else if (scrapedH1 && scrapedH1.length > 10) {
      fullSummary = `${brandName} is a product built around "${scrapedH1}" to help users get results faster.`;
    } else if (knownProfile) {
      fullSummary = knownProfile.summary;
    } else {
      // Infer from domain TLD or keywords
      const tld = domainParts[domainParts.length - 1] || 'com';
      if (tld === 'ai' || /ai/i.test(baseKey)) {
        fullSummary = `${brandName} is an AI-powered platform that automates workflows and helps users get results in seconds.`;
      } else if (tld === 'app' || isAppStore || isPlayStore) {
        fullSummary = `${brandName} is a consumer mobile app designed to simplify daily routines with an intuitive experience.`;
      } else if (/fit|gym|health|well|vital|glow|skin/i.test(baseKey)) {
        fullSummary = `${brandName} is a health and wellness brand helping customers look, feel, and perform at their best.`;
      } else if (/shop|store|wear|style|goods/i.test(baseKey)) {
        fullSummary = `${brandName} is a direct-to-consumer brand delivering curated products built for everyday life.`;
      } else {
        fullSummary = `${brandName} (${hostname}) is a digital product and platform that helps users solve everyday problems effortlessly.`;
      }
    }

    // Short display version for the compact card + full summary
    const displaySummary = fullSummary.length > 88 ? fullSummary.slice(0, 85).trim() + '...' : fullSummary;

    // 3. Classify Product Niche & Search Database for Suitable Creators and Reaction Clips
    const combinedCorpus = `${brandName} ${hostname} ${scrapedTitle} ${scrapedDescription} ${scrapedH1} ${fullSummary}`;
    let matchedRule = NICHE_RULES.find(r => r.regex.test(combinedCorpus)) || NICHE_RULES[NICHE_RULES.length - 1];
    if (knownProfile) {
      const ruleByKnown = NICHE_RULES.find(r => r.niche === knownProfile.niche);
      if (ruleByKnown) matchedRule = ruleByKnown;
    }

    // Query creators from SQLite database
    const allCreators = db.prepare("SELECT * FROM creators WHERE status = 'active'").all();
    const allClips = db.prepare("SELECT * FROM library_clips").all();

    // Score and rank creators based on product niche fit
    const scoredCreators = allCreators.map(creator => {
      let formats = [];
      try {
        formats = JSON.parse(creator.formats || '[]');
      } catch (_) {}

      const specialty = matchedRule.creatorSpecialties[creator.id] || '';
      const hasSpecialty = Boolean(specialty);
      const supportsBoth = formats.includes('reaction') && formats.includes('full_ugc');

      // Find clips by this creator or in matching category
      const creatorClips = allClips.filter(c =>
        c.creator.toLowerCase().includes(creator.name.toLowerCase()) ||
        matchedRule.clipCategories.includes(c.category)
      );

      const score = (hasSpecialty ? 30 : 10) + (supportsBoth ? 12 : 6) + Math.min(creatorClips.length * 3, 15);
      const matchPct = Math.min(99, 84 + Math.round(score / 4));

      return {
        id: creator.id,
        name: creator.name,
        handle: creator.handle,
        avatar: creator.avatar,
        rate: creator.rate,
        rating: creator.rating || '5.0 (30)',
        formats,
        niche: matchedRule.niche,
        matchReason: specialty || `High-converting ${matchedRule.niche} UGC creator`,
        matchScore: matchPct
      };
    }).sort((a, b) => b.matchScore - a.matchScore);

    const suitableCreators = scoredCreators.slice(0, 4);

    // Count & select matching reaction clips from database
    const matchingClips = allClips.filter(clip => {
      if (matchedRule.clipCategories.includes(clip.category)) return true;
      const clipText = `${clip.title} ${clip.category} ${clip.emotion} ${clip.tags}`.toLowerCase();
      return /reaction|hook|talking head|app demo|product demo/i.test(clipText);
    });

    // Calculate realistic reactions matched count based on matched clips + library depth
    const reactionsMatchedCount = Math.max(38, matchingClips.length * 5 + (brandName.length % 7));

    res.json({
      success: true,
      url: parsedUrl.toString(),
      hostname,
      brandName,
      niche: matchedRule.niche,
      summary: fullSummary,
      displaySummary,
      reactionsMatched: reactionsMatchedCount,
      suitableCreators,
      matchedClips: matchingClips.slice(0, 4).map(c => ({
        id: c.id,
        title: c.title,
        creator: c.creator,
        category: c.category,
        emotion: c.emotion,
        thumbnail: c.thumbnail
      }))
    });
  } catch (error) {
    console.error('Error analyzing brand URL:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const { generateAiBrief } = require('../services/briefAiGenerator');

/**
 * POST /api/ai/generate-brief
 * Generates a full brief with concepts, scripts, and filming instructions
 * based on user description text.
 */
router.post('/generate-brief', async (req, res) => {
  try {
    const { description = '', format = 'Reaction Video', selectedCreators = [] } = req.body;

    const result = await generateAiBrief({
      description,
      format,
      selectedCreators
    });

    res.json({
      success: true,
      briefId: result.briefId,
      brief: result.brief,
      message: 'Brief generated successfully with AI.'
    });
  } catch (error) {
    console.error('Error in AI brief generator:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;


