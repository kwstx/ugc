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

module.exports = router;
