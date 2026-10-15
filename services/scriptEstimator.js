/**
 * Script Duration & Pacing Estimator
 * Average speaking pace for UGC/TikTok/Reels ads is 130 - 150 words per minute (~2.3 words/sec).
 */

function analyzeScript(scriptText = '') {
  const cleanText = scriptText.trim();
  if (!cleanText) {
    return {
      wordCount: 0,
      charCount: 0,
      estimatedSeconds: 0,
      formattedDuration: '0s',
      paceCategory: 'Empty',
      recommendation: 'Please enter script or footage directions.'
    };
  }

  // Count words, ignoring extra whitespace
  const words = cleanText.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const charCount = cleanText.length;

  // Words per second: 2.3 wps (~140 wpm)
  const estimatedSeconds = Math.max(3, Math.round(wordCount / 2.33));

  let paceCategory = 'Quick reaction';
  let recommendation = 'Perfect for a punchy 10-15s hook or reaction clip.';

  if (estimatedSeconds > 60) {
    paceCategory = 'Extended script (>60s)';
    recommendation = 'Consider trimming for short-form video ads (TikTok/Reels perform best at 15-30s).';
  } else if (estimatedSeconds >= 35) {
    paceCategory = 'Medium ad (30-60s)';
    recommendation = 'Good length for a detailed problem-solution or testimonial style video.';
  } else if (estimatedSeconds >= 15) {
    paceCategory = 'Sweet-spot UGC (15-30s)';
    recommendation = 'Optimal length for high retention UGC ads.';
  }

  return {
    wordCount,
    charCount,
    estimatedSeconds,
    formattedDuration: `${estimatedSeconds}s`,
    paceCategory,
    recommendation
  };
}

module.exports = {
  analyzeScript
};
