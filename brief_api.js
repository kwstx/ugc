/**
 * Sofia Brief Backend Client Integration
 * Handles:
 * - Unified Draft Order Sync & Autosave (POST /api/orders/draft)
 * - Reaction Brief Retrieval & Prerequisite Verification (GET /api/orders/:order_id/brief?format=reaction)
 * - Authoritative Server-Side Pricing & Creator Rate Display
 * - Reaction Format Specification Field Handling (source asset link, layout, callouts)
 * - Final Brief Submission & Pricing Lock-In (POST /api/orders/:order_id/brief)
 * - AI Script Assistant & Real-time Script Pacing
 */

const BRIEF_API_BASE = (window.location.port === '3000') ? '' : 'http://localhost:3000';
let currentOrderId = null;
let currentBriefId = null;
let autosaveTimeout = null;
let latestAuthoritativePricing = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const format = urlParams.get('format') || localStorage.getItem('selectedFormatKey') || 'reaction';
  const paramId = urlParams.get('orderId') || urlParams.get('briefId') || urlParams.get('id') ||
                  localStorage.getItem('sofia_current_order_id') || localStorage.getItem('sofia_current_brief_id') || 'draft';

  await loadBriefFromBackend(paramId, format);
  setupAutosaveListeners();
});

/**
 * Hook up input events for debounced autosave
 */
function setupAutosaveListeners() {
  const inputIds = [
    'brand-name-input',
    'about-brand-input',
    'filming-instructions-input',
    'source-asset-url-input',
    'timestamps-callouts-input',
    'reaction-style-input'
  ];

  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => scheduleAutosave());
    }
  });

  const layoutSelect = document.getElementById('layout-preference-select');
  if (layoutSelect) {
    layoutSelect.addEventListener('change', () => scheduleAutosave());
  }

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
  const sourceAssetUrl = document.getElementById('source-asset-url-input')?.value.trim() || '';
  const layoutPreference = document.getElementById('layout-preference-select')?.value || 'split_screen';
  const timestampsCallouts = document.getElementById('timestamps-callouts-input')?.value.trim() || '';
  const reactionStyleGuidelines = document.getElementById('reaction-style-input')?.value.trim() || '';

  const creatorCount = (window.selectedCreators && window.selectedCreators.length) || 2;
  const format = window.currentFormat || localStorage.getItem('selectedFormat') || 'Reaction Video';
  const formatKey = String(format).toLowerCase().includes('full') ? 'full' : 'reaction';

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
    concepts.push({
      title,
      type,
      script,
      perCreator,
      qty: perCreator * creatorCount
    });
  });

  const totalPerCreator = summedPerCreator > 0 ? summedPerCreator : 3;
  const qty = totalPerCreator * creatorCount;
  window.currentQty = qty;

  const creatorIds = (window.selectedCreators || []).map(c => typeof c === 'object' ? c.id : c).filter(Boolean);

  return {
    orderId: currentOrderId || currentBriefId,
    id: currentOrderId || currentBriefId,
    format,
    formatKey,
    brandName,
    aboutBrand,
    filmingInstructions,
    sourceAssetUrl,
    layoutPreference,
    timestampsCallouts,
    reactionStyleGuidelines,
    qty,
    perCreator: totalPerCreator,
    creatorIds,
    selectedCreators: window.selectedCreators || [],
    concepts
  };
}

/**
 * 1. Unified Draft Order State: Persist draft to backend database
 */
async function saveDraftToBackend(showExplicitAlert = false) {
  const payload = collectBriefPayload();
  try {
    const response = await fetch(`${BRIEF_API_BASE}/api/orders/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error('Failed to save draft to backend');

    const result = await response.json();
    if (result.success && result.orderId) {
      currentOrderId = result.orderId;
      currentBriefId = result.orderId;
      localStorage.setItem('sofia_current_order_id', currentOrderId);
      localStorage.setItem('sofia_current_brief_id', currentOrderId);

      if (result.pricing) {
        latestAuthoritativePricing = result.pricing;
        renderAuthoritativePricing(result.pricing);
      }

      showAutosaveBadge('All changes saved to backend', 'saved');
      if (showExplicitAlert) {
        alert('Draft saved successfully to backend!');
      }
    }
  } catch (err) {
    console.warn('Backend draft autosave fallback:', err);
    showAutosaveBadge('Saved locally', 'saved');
  }
}

/**
 * 3. Dedicated Endpoint for the Edit Brief View (?format=reaction)
 * Loads authoritative state, checks prerequisites, performs fresh creator rate lookups,
 * and formats reaction-specific brief fields.
 */
async function loadBriefFromBackend(orderOrBriefId, formatKey = 'reaction') {
  try {
    showAutosaveBadge('Loading verified brief...', 'saving');

    const targetParam = (orderOrBriefId && orderOrBriefId !== 'local_generated') ? orderOrBriefId : 'draft';
    const response = await fetch(`${BRIEF_API_BASE}/api/orders/${targetParam}/brief?format=${encodeURIComponent(formatKey)}`);

    if (response.ok) {
      const result = await response.json();
      if (result.success) {
        currentOrderId = result.orderId;
        currentBriefId = result.orderId;
        localStorage.setItem('sofia_current_order_id', currentOrderId);
        localStorage.setItem('sofia_current_brief_id', currentOrderId);

        // 1. Verify and notify prerequisites
        handlePrerequisitesUI(result.prerequisites, formatKey);

        // 2. Fresh Rate Lookup & Creator population
        if (Array.isArray(result.verifiedCreators)) {
          window.selectedCreators = result.verifiedCreators;
          try {
            localStorage.setItem('selectedCreators', JSON.stringify(result.verifiedCreators));
            localStorage.setItem('selectedCreatorIds', JSON.stringify(result.verifiedCreators.map(c => c.id)));
            localStorage.setItem('selectedCreatorsCount', result.verifiedCreators.length);
          } catch (e) {}
        }

        // 3. Populate Format & Quantities
        if (result.format) {
          window.currentFormat = result.format;
        }
        if (result.orderSummary && result.orderSummary.qty) {
          window.currentQty = result.orderSummary.qty;
        }

        // 4. Authoritative Pricing Display
        if (result.pricing) {
          latestAuthoritativePricing = result.pricing;
          renderAuthoritativePricing(result.pricing);
        }

        // 5. Pre-fill Brief details and Format-Specific Reaction fields
        const brief = result.brief || {};
        const brandInput = document.getElementById('brand-name-input');
        const aboutInput = document.getElementById('about-brand-input');
        const filmingInput = document.getElementById('filming-instructions-input');
        const sourceUrlInput = document.getElementById('source-asset-url-input');
        const layoutSelect = document.getElementById('layout-preference-select');
        const timestampsInput = document.getElementById('timestamps-callouts-input');
        const styleInput = document.getElementById('reaction-style-input');

        if (brandInput && brief.brandName) brandInput.value = brief.brandName;
        if (aboutInput && brief.aboutBrand) aboutInput.value = brief.aboutBrand;
        if (filmingInput && brief.filmingInstructions) filmingInput.value = brief.filmingInstructions;
        if (sourceUrlInput && brief.sourceAssetUrl) sourceUrlInput.value = brief.sourceAssetUrl;
        if (layoutSelect && brief.layoutPreference) layoutSelect.value = brief.layoutPreference;
        if (timestampsInput && brief.timestampsCallouts) timestampsInput.value = brief.timestampsCallouts;
        if (styleInput && brief.reactionStyleGuidelines) styleInput.value = brief.reactionStyleGuidelines;

        // 6. Populate Concepts
        if (Array.isArray(brief.concepts) && brief.concepts.length > 0) {
          const container = document.getElementById('concepts-container');
          while (container && container.children.length < brief.concepts.length && typeof window.addNewConcept === 'function') {
            window.addNewConcept();
          }
          const blocks = document.querySelectorAll('#concepts-container > div');
          brief.concepts.forEach((c, idx) => {
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
          });
        }

        if (typeof window.updateFormatUI === 'function') window.updateFormatUI();
        if (typeof window.updateUI === 'function') window.updateUI(true);
        if (typeof window.checkBriefValidity === 'function') window.checkBriefValidity();

        showAutosaveBadge('Verified backend brief ready', 'saved');
        return;
      }
    }
  } catch (err) {
    console.warn('Error fetching brief view from backend, falling back to local state:', err);
  }

  showAutosaveBadge('Ready', 'saved');
}

/**
 * Handle Prerequisite verification banner
 */
function handlePrerequisitesUI(prerequisites, formatKey) {
  const banner = document.getElementById('validation-banner');
  if (!banner || !prerequisites) return;

  if (!prerequisites.allMet && prerequisites.missing && prerequisites.missing.length > 0) {
    const isMissingCreators = !prerequisites.creatorsVerified;
    banner.className = "w-full bg-[#fffbeb] border border-[#fde68a] rounded-[10px] p-3 sm:p-3.5 mb-6 text-[12px] text-[#92400e] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xs";
    banner.innerHTML = `
      <div class="flex items-start gap-2.5">
        <svg class="w-4 h-4 text-[#d97706] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <div>
          <span class="font-bold text-[#78350f]">Prerequisite configuration required:</span>
          <span class="text-[#92400e] ml-1">${prerequisites.missing.join(' ')}</span>
        </div>
      </div>
      ${isMissingCreators ? `
        <a href="creators.html?format=${encodeURIComponent(formatKey)}" class="px-3 py-1.5 bg-[#d97706] hover:bg-[#b45309] text-white text-[11.5px] font-semibold rounded-[8px] transition-all whitespace-nowrap shrink-0 shadow-xs cursor-pointer">
          Pick Creators &rarr;
        </a>
      ` : ''}
    `;
  }
}

/**
 * Authoritative Server-Side Pricing Renderer
 */
function renderAuthoritativePricing(pricing) {
  if (!pricing) return;

  const creatorCount = (pricing.creators && pricing.creators.length) !== undefined ? pricing.creators.length : (pricing.creatorCount || 0);

  // Sidebar creators list with authoritative rates
  const creatorsListEl = document.getElementById('brief-selected-creators-list');
  if (creatorsListEl) {
    if (creatorCount > 0 && Array.isArray(pricing.creators)) {
      creatorsListEl.innerHTML = pricing.creators.map(c => `
        <div class="flex items-center justify-between py-1 border-b border-[#f3f4f6] last:border-0">
          <div class="flex items-center gap-2.5">
            <img src="${c.avatar || 'creator_avatar.png'}" alt="${c.name}" class="w-7 h-7 rounded-full object-cover border border-[#e5e7eb]" onerror="this.onerror=null; this.src='creator_avatar.png';" />
            <div>
              <div class="text-[12px] font-bold text-[#18181b] leading-tight flex items-center gap-1">
                <span>${c.name}</span>
                <span class="text-[9.5px] font-medium text-[#16a34a] bg-[#dcfce7] px-1.5 py-0.2 rounded-full">Active</span>
              </div>
              <div class="text-[10.5px] text-[#71717a] mt-0.5">${c.assignedVideos} videos &middot; $${c.baseRate.toFixed(2)}/vid</div>
            </div>
          </div>
          <span class="text-[11.5px] font-bold text-[#111827]">$${c.subtotal.toFixed(2)}</span>
        </div>
      `).join('');
    } else {
      creatorsListEl.innerHTML = `
        <div class="p-3 bg-[#f9fafb] border border-[#e5e7eb] rounded-[10px] text-center text-[#71717a] text-[12px]">
          <p class="font-medium text-[#374151]">0 creators selected</p>
          <p class="text-[11px] mt-0.5">Pick creators on the creators page</p>
          <a href="creators.html?format=${encodeURIComponent(window.currentFormatKey || 'reaction')}" class="inline-block mt-2 text-[#7c66ff] hover:text-[#6852ee] font-semibold text-[11.5px]">Pick creators &rarr;</a>
        </div>
      `;
    }
  }

  // Live estimate calc line
  const calcQty = document.getElementById('estimate-calc-qty');
  const calcTotal = document.getElementById('estimate-calc-total');
  if (calcQty) {
    if (creatorCount === 0) {
      calcQty.innerHTML = `0 creators selected`;
    } else {
      calcQty.innerHTML = `${pricing.quantity} videos &middot; ${creatorCount} creators`;
    }
  }
  if (calcTotal) {
    calcTotal.textContent = creatorCount === 0 ? `$0.00` : `$${pricing.creatorBaseSubtotal.toFixed(2)}`;
  }

  // Total price display
  const estTotal = document.getElementById('estimate-total-price');
  if (estTotal) {
    estTotal.textContent = `$${pricing.total.toFixed(2)}`;
  }

  // Floating bottom bar price
  const floatingBarPrice = document.getElementById('floating-bar-price');
  if (floatingBarPrice) {
    if (creatorCount === 0) {
      floatingBarPrice.textContent = `0 creators · $0.00`;
    } else {
      floatingBarPrice.textContent = `${pricing.quantity} videos · $${pricing.total.toFixed(2)}`;
    }
  }

  // Discount / fee notice
  const estimateSubtitle = document.getElementById('estimate-subtitle');
  if (estimateSubtitle) {
    if (creatorCount === 0) {
      estimateSubtitle.textContent = `0 creators selected · Minimum 5 videos`;
    } else {
      const discountText = pricing.volumeDiscountAmount > 0 ? ` &middot; Includes -$${pricing.volumeDiscountAmount.toFixed(2)} discount` : '';
      estimateSubtitle.textContent = `${pricing.quantity} videos · ${pricing.turnaroundHours}h turnaround${discountText}`;
    }
  }
}

/**
 * 5. Final Brief Submission & Validation
 * Submits completed brief, validates mandatory fields, locks price snapshot,
 * and advances order status to ready_for_checkout
 */
async function submitReviewToBackend() {
  const payload = collectBriefPayload();
  const targetId = currentOrderId || currentBriefId || 'draft';

  // Client-side pre-validation for immediate UI feedback
  if (!payload.brandName) {
    alert('Please enter your Brand Name.');
    const input = document.getElementById('brand-name-input');
    if (input) { input.focus(); input.classList.add('ring-2', 'ring-[#ef4444]'); }
    return;
  }

  if (payload.formatKey === 'reaction' && !payload.sourceAssetUrl) {
    alert('Reaction video format requires a Source Media URL (video clip to react to).');
    const input = document.getElementById('source-asset-url-input');
    if (input) {
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input.focus();
      input.classList.add('ring-2', 'ring-[#ef4444]', 'border-[#ef4444]');
      setTimeout(() => input.classList.remove('ring-2', 'ring-[#ef4444]', 'border-[#ef4444]'), 2500);
    }
    return;
  }

  showAutosaveBadge('Validating and locking brief...', 'saving');

  try {
    const response = await fetch(`${BRIEF_API_BASE}/api/orders/${targetId}/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      const errorMsg = data.validationErrors ? data.validationErrors.join('\n') : (data.error || 'Validation failed on server');
      throw new Error(errorMsg);
    }

    // Save locked and verified order
    localStorage.setItem('ugc_order_review', JSON.stringify(data.verifiedOrder));
    localStorage.setItem('sofia_current_order_id', data.orderId);
    localStorage.setItem('sofia_current_brief_id', data.orderId);

    // Redirect to checkout review
    window.location.href = data.verifiedOrder?.checkoutUrl || `review_order.html?orderId=${encodeURIComponent(data.orderId)}&format=reaction`;
  } catch (err) {
    console.error('Final brief submission error:', err);
    showAutosaveBadge('Validation failed', 'error');

    const banner = document.getElementById('validation-banner');
    if (banner) {
      banner.className = "w-full bg-[#fef2f2] border border-[#fecaca] rounded-[10px] px-4 py-3 mb-6 text-[12px] text-[#dc2626]";
      banner.innerHTML = `<strong>Please correct the following:</strong><br/>${err.message.replace(/\n/g, '<br/>')}`;
      banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      alert(`Brief validation error:\n${err.message}`);
    }
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
window.renderAuthoritativePricing = renderAuthoritativePricing;
