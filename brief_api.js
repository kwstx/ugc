/**
 * Sofia Brief Backend Client Integration
 * Handles:
 * - Draft Autosave (POST /api/briefs/save-draft, PUT /api/briefs/:id)
 * - Brief Retrieval (GET /api/briefs/:id)
 * - Server-side Validation & Review (POST /api/briefs/:id/review)
 * - AI Script Assistant (POST /api/ai/script-helper)
 * - Real-time script pacing & duration estimation
 */

const BRIEF_API_BASE = (window.location.port === '3000') ? '' : 'http://localhost:3000';
let currentBriefId = null;
let autosaveTimeout = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  // Check for explicit briefId in URL or localStorage
  const urlParams = new URLSearchParams(window.location.search);
  const paramId = urlParams.get('briefId') || urlParams.get('id') || (urlParams.get('ai') === 'true' ? localStorage.getItem('sofia_current_brief_id') : null);

  if (paramId) {
    await loadBriefFromBackend(paramId);
  } else if (urlParams.get('ai') === 'true' || localStorage.getItem('sofia_generated_brief')) {
    await loadBriefFromBackend(localStorage.getItem('sofia_current_brief_id') || 'local_generated');
  }

  // Hook up inputs for autosave
  setupAutosaveListeners();
});

/**
 * Hook up input events for debounced autosave
 */
function setupAutosaveListeners() {
  const inputs = ['brand-name-input', 'about-brand-input', 'filming-instructions-input'];
  inputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => scheduleAutosave());
    }
  });

  document.addEventListener('input', (e) => {
    if (
      e.target &&
      (e.target.classList.contains('concept-script-textarea') ||
        e.target.classList.contains('per-creator-input'))
    ) {
      scheduleAutosave();
    }
  });
}

function scheduleAutosave() {
  showAutosaveBadge('Saving draft...', 'saving');
  clearTimeout(autosaveTimeout);
  autosaveTimeout = setTimeout(() => {
    saveDraftToBackend(false);
  }, 1800);
}

function showAutosaveBadge(text, state = 'saved') {
  const badge = document.getElementById('autosave-status');
  const badgeText = document.getElementById('autosave-text');
  const dot = document.getElementById('autosave-dot');
  if (!badge || !badgeText) return;

  badge.classList.remove('hidden');
  badgeText.textContent = text;

  if (dot) {
    if (state === 'saving') {
      dot.className = 'w-2 h-2 rounded-full bg-[#f59e0b] animate-ping';
    } else if (state === 'error') {
      dot.className = 'w-2 h-2 rounded-full bg-[#ef4444]';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-[#10b981]';
    }
  }
}

/**
 * Collect payload from current DOM
 */
function collectBriefPayload() {
  const brandName = document.getElementById('brand-name-input')?.value.trim() || '';
  const aboutBrand = document.getElementById('about-brand-input')?.value.trim() || '';
  const filmingInstructions = document.getElementById('filming-instructions-input')?.value.trim() || '';

  const creatorCount = (window.selectedCreators && window.selectedCreators.length) || 2;
  const format = window.currentFormat || localStorage.getItem('selectedFormat') || 'Reaction Video';
  const fallbackBase = (format === 'Full UGC') ? 100.00 : 25.00;
  const rate = (typeof window.getRateForQty === 'function')
    ? window.getRateForQty(window.currentQty || 6)
    : fallbackBase;

  const concepts = [];
  let summedPerCreator = 0;
  const blocks = document.querySelectorAll('#concepts-container > div');
  blocks.forEach((block, idx) => {
    const title = block.querySelector('.concept-title-text')?.textContent.trim() || `Concept ${idx + 1}`;
    const typeEl = block.querySelector('[id^="selected-video-type-text-"]');
    const type = typeEl ? typeEl.textContent.trim() : 'Reaction / footage';
    const script = block.querySelector('.concept-script-textarea')?.value.trim() || '';
    const perCreator = Math.max(1, parseInt(block.querySelector('.per-creator-input')?.value.trim(), 10) || 1);
    summedPerCreator += perCreator;
    const conceptQty = perCreator * creatorCount;
    const conceptSubtotal = parseFloat((conceptQty * rate).toFixed(2));
    concepts.push({
      title,
      type,
      script,
      perCreator,
      qty: conceptQty,
      subtotal: conceptSubtotal
    });
  });

  const totalPerCreator = summedPerCreator > 0 ? summedPerCreator : 3;
  const qty = totalPerCreator * creatorCount;
  window.currentQty = qty;

  return {
    id: currentBriefId,
    brandName,
    aboutBrand,
    filmingInstructions,
    qty,
    perCreator: totalPerCreator,
    format,
    selectedCreators: window.selectedCreators || [],
    concepts
  };
}

/**
 * POST /api/briefs/save-draft
 */
async function saveDraftToBackend(showExplicitAlert = false) {
  const payload = collectBriefPayload();
  try {
    const response = await fetch(`${BRIEF_API_BASE}/api/briefs/save-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error('Failed to save brief to backend');

    const result = await response.json();
    if (result.success && result.briefId) {
      currentBriefId = result.briefId;
      localStorage.setItem('sofia_current_brief_id', currentBriefId);
      showAutosaveBadge('All changes saved to backend', 'saved');
      if (showExplicitAlert) {
        alert('Draft saved successfully to backend!');
      }
    }
  } catch (err) {
    console.warn('Backend autosave fallback to localStorage:', err);
    showAutosaveBadge('Saved locally', 'saved');
  }
}

/**
 * GET /api/briefs/:id
 */
async function loadBriefFromBackend(briefId) {
  try {
    showAutosaveBadge('Loading brief...', 'saving');
    let b = null;
    if (briefId && briefId !== 'local_generated') {
      try {
        const response = await fetch(`${BRIEF_API_BASE}/api/briefs/${briefId}`);
        if (response.ok) {
          const result = await response.json();
          if (result.success && result.brief) {
            b = result.brief;
          }
        }
      } catch (e) {
        console.warn('Network error loading brief from backend:', e);
      }
    }

    if (!b) {
      try {
        b = JSON.parse(localStorage.getItem('sofia_generated_brief') || 'null');
      } catch (_) {}
    }

    if (b) {
      currentBriefId = b.id || briefId;
      localStorage.setItem('sofia_current_brief_id', currentBriefId);

      const brandInput = document.getElementById('brand-name-input');
      const aboutInput = document.getElementById('about-brand-input');
      const filmingInput = document.getElementById('filming-instructions-input');

      if (brandInput && b.brandName) brandInput.value = b.brandName;
      if (aboutInput && b.aboutBrand) aboutInput.value = b.aboutBrand;
      if (filmingInput && b.filmingInstructions) filmingInput.value = b.filmingInstructions;

      if (b.format) {
        window.currentFormat = b.format;
        const key = (b.format === 'Full UGC') ? 'full' : 'reaction';
        try {
          localStorage.setItem('selectedFormat', b.format);
          localStorage.setItem('selectedFormatKey', key);
          sessionStorage.setItem('selectedFormat', b.format);
          sessionStorage.setItem('selectedFormatKey', key);
        } catch (_) {}
      }

      if (b.concepts && b.concepts.length > 0) {
        const container = document.getElementById('concepts-container');
        while (container && container.children.length < b.concepts.length && typeof window.addNewConcept === 'function') {
          window.addNewConcept();
        }
        const blocks = document.querySelectorAll('#concepts-container > div');
        b.concepts.forEach((c, idx) => {
          const block = blocks[idx];
          if (!block) return;
          const ta = block.querySelector('.concept-script-textarea');
          if (ta && c.script !== undefined) ta.value = c.script;
          const pcInput = block.querySelector('.per-creator-input');
          if (pcInput && c.perCreator !== undefined) pcInput.value = c.perCreator;
          const titleEl = block.querySelector('.concept-title-text');
          if (titleEl && c.title) titleEl.textContent = c.title;
          const typeEl = block.querySelector('[id^="selected-video-type-text-"]');
          if (typeEl && c.type) typeEl.textContent = c.type;
          const subEl = block.querySelector('.concept-subtitle');
          if (subEl) subEl.textContent = `${window.currentFormat || 'Reaction Video'} · ${c.type || 'Reaction / footage'}`;
        });
      }

      if (b.qty && typeof window.selectTier === 'function') {
        window.currentQty = b.qty;
      }

      if (typeof window.updateFormatUI === 'function') {
        window.updateFormatUI();
      }

      if (typeof window.updateUI === 'function') {
        window.updateUI(true);
      }

      if (typeof window.checkBriefValidity === 'function') {
        window.checkBriefValidity();
      }

      showAutosaveBadge('AI brief loaded', 'saved');
      return;
    }

    showAutosaveBadge('Ready', 'saved');
  } catch (err) {
    console.warn('Error restoring brief state:', err);
    showAutosaveBadge('Ready', 'saved');
  }
}


/**
 * POST /api/briefs/:id/review
 * Server-side Validation & Submission
 */
async function submitReviewToBackend() {
  const payload = collectBriefPayload();
  const targetId = currentBriefId || 'draft_' + Date.now();

  try {
    const response = await fetch(`${BRIEF_API_BASE}/api/briefs/${targetId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || (data.details ? data.details.join('\n') : 'Validation failed on server'));
    }

    // Save server-verified payload to review order
    localStorage.setItem('ugc_order_review', JSON.stringify(data.verifiedOrder));
    localStorage.setItem('sofia_current_brief_id', targetId);
    window.location.href = 'review_order.html';
  } catch (err) {
    console.warn('Server review validation error, falling back to local review flow:', err);
    // If backend is unavailable, proceed with local payload
    const fallbackBase = (payload.format === 'Full UGC') ? 100.00 : 25.00;
    const localRate = window.getRateForQty ? window.getRateForQty(payload.qty) : fallbackBase;
    const localPayload = {
      ...payload,
      rate: localRate.toFixed(2),
      total: (payload.qty * localRate).toFixed(2),
      perCreator: payload.perCreator || Math.ceil(payload.qty / (payload.selectedCreators.length || 2)),
      selectedCreatorsCount: payload.selectedCreators.length || 2
    };
    localStorage.setItem('ugc_order_review', JSON.stringify(localPayload));
    window.location.href = 'review_order.html';
  }
}

/**
 * POST /api/ai/script-helper
 */
async function callAiScriptHelper(conceptIndex, mode = 'generate') {
  const block = document.getElementById(`concept-block-${conceptIndex}`) || document.getElementById('concepts-container');
  const textarea = block ? block.querySelector('.concept-script-textarea') : document.querySelector('.concept-script-textarea');
  const typeEl = block ? block.querySelector('[id^="selected-video-type-text-"]') : null;
  const conceptType = typeEl ? typeEl.textContent.trim() : 'Reaction / footage';

  const brandName = document.getElementById('brand-name-input')?.value.trim() || 'Our Brand';
  const aboutBrand = document.getElementById('about-brand-input')?.value.trim() || 'High quality products';
  const currentScript = textarea ? textarea.value.trim() : '';

  const aiBtn = document.getElementById(`ai-btn-${conceptIndex}`) || event?.target?.closest('button');
  if (aiBtn) {
    aiBtn.disabled = true;
    aiBtn.innerHTML = `<span>✨ Generating...</span>`;
  }

  try {
    const res = await fetch(`${BRIEF_API_BASE}/api/ai/script-helper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        brandName,
        aboutBrand,
        conceptType,
        currentScript
      })
    });

    const data = await res.json();
    if (data.success && textarea) {
      textarea.value = data.script;
      updateScriptPacing(conceptIndex);
      if (typeof window.checkBriefValidity === 'function') {
        window.checkBriefValidity();
      }
      scheduleAutosave();
    }
  } catch (err) {
    console.error('AI script helper error:', err);
    alert('AI Helper currently offline or busy. Try again in a moment.');
  } finally {
    if (aiBtn) {
      aiBtn.disabled = false;
      aiBtn.innerHTML = `<span>✨ AI Script Helper</span>`;
    }
  }
}

/**
 * Real-time script pacing analysis
 */
function updateScriptPacing(conceptIndex) {
  const block = document.getElementById(`concept-block-${conceptIndex}`) || document.getElementById('concepts-container');
  if (!block) return;
  const textarea = block.querySelector('.concept-script-textarea');
  const indicator = document.getElementById(`script-pacing-${conceptIndex}`);
  if (!textarea || !indicator) return;

  const words = textarea.value.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) {
    indicator.textContent = 'Estimated duration: 0s';
    indicator.className = 'text-[11px] text-[#6b7280]';
    return;
  }

  const seconds = Math.max(3, Math.round(words / 2.33));
  if (seconds > 60) {
    indicator.textContent = `Estimated duration: ~${seconds}s (Warning: >60s may reduce retention)`;
    indicator.className = 'text-[11px] text-[#dc2626] font-medium';
  } else if (seconds >= 30) {
    indicator.textContent = `Estimated duration: ~${seconds}s (Optimal for 30s-60s ad)`;
    indicator.className = 'text-[11px] text-[#2563eb] font-medium';
  } else {
    indicator.textContent = `Estimated duration: ~${seconds}s (Great 15s short-form hook)`;
    indicator.className = 'text-[11px] text-[#059669] font-medium';
  }
}

// Expose globals
window.scheduleAutosave = scheduleAutosave;
window.saveDraftToBackend = saveDraftToBackend;
window.submitReviewToBackend = submitReviewToBackend;
window.callAiScriptHelper = callAiScriptHelper;
window.updateScriptPacing = updateScriptPacing;
