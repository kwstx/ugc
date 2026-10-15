/**
 * Search & Social Link Matching Engine
 * Parses text queries or Instagram / TikTok URLs to match reaction clips and hooks.
 */

// Patterns to detect Instagram & TikTok links
const INSTAGRAM_REGEX = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p)\/([a-zA-Z0-9_-]+)/i;
const TIKTOK_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com\/@([a-zA-Z0-9_.-]+)\/video\/(\d+)|vm\.tiktok\.com\/([a-zA-Z0-9]+))/i;
const YOUTUBE_SHORTS_REGEX = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/i;

/**
 * Detects if a query is a social media link
 */
function analyzeQueryIntent(query = '') {
  const q = query.trim();
  if (INSTAGRAM_REGEX.test(q)) {
    return {
      isSocialLink: true,
      platform: 'Instagram Reel',
      inferredHookStyle: 'Shocked / Disbelief Reaction',
      suggestedTags: ['shocked', 'reaction', 'hook', 'viral', 'disbelief']
    };
  }

  if (TIKTOK_REGEX.test(q)) {
    return {
      isSocialLink: true,
      platform: 'TikTok Video',
      inferredHookStyle: 'Fast-paced Laughing / Screen Reaction',
      suggestedTags: ['laughing', 'phone', 'viral', 'fast hook', 'happy']
    };
  }

  if (YOUTUBE_SHORTS_REGEX.test(q)) {
    return {
      isSocialLink: true,
      platform: 'YouTube Shorts',
      inferredHookStyle: 'Product Demo & Direct Explanation',
      suggestedTags: ['talking head', 'demo', 'review', 'explanation']
    };
  }

  return {
    isSocialLink: false,
    platform: null,
    inferredHookStyle: null,
    suggestedTags: []
  };
}

/**
 * Scores a clip against a search query or social intent
 */
function scoreClip(clip, query, socialIntent) {
  let score = 0;
  const title = (clip.title || '').toLowerCase();
  const emotion = (clip.emotion || '').toLowerCase();
  const category = (clip.category || '').toLowerCase();
  const creator = (clip.creator || '').toLowerCase();
  const tags = Array.isArray(clip.tags) ? clip.tags.map(t => String(t).toLowerCase()) : [];

  if (socialIntent.isSocialLink) {
    // Score based on inferred social hook tags
    for (const tag of socialIntent.suggestedTags) {
      if (title.includes(tag)) score += 30;
      if (emotion.includes(tag)) score += 35;
      if (tags.includes(tag)) score += 25;
    }
    // High views/ratings get extra boost for viral matching
    if (clip.views_count) score += Math.min(20, clip.views_count / 150);
    return score;
  }

  const q = query.toLowerCase().trim();
  if (!q) return 1;

  // Exact phrase match
  if (title.includes(q)) score += 50;
  if (emotion.includes(q)) score += 40;
  if (category.includes(q)) score += 35;

  const tokens = q.split(/[\s,._-]+/).filter(t => t.length > 1);
  tokens.forEach(tok => {
    if (title.includes(tok)) score += 18;
    if (emotion === tok) score += 25;
    else if (emotion.includes(tok)) score += 15;
    if (category.includes(tok)) score += 12;
    if (creator.includes(tok)) score += 15;
    tags.forEach(tag => {
      if (tag === tok) score += 22;
      else if (tag.includes(tok) || tok.includes(tag)) score += 10;
    });
  });

  return score;
}

module.exports = {
  analyzeQueryIntent,
  scoreClip
};
