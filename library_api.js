/**
 * DansUGC Library Frontend-Backend Client Integration
 * Connects library.html with:
 * - GET /api/library/clips
 * - GET /api/library/search (Text & Social Link Hook Matching)
 * - POST /api/cart/bundle-price & cart management
 * - POST /api/library/checkout & instant licensing
 * - POST /api/library/favorites
 */

let backendClips = [];
let currentSessionId = localStorage.getItem('dansugc_session_id') || ('sess_' + Math.random().toString(36).substring(2, 9));
localStorage.setItem('dansugc_session_id', currentSessionId);

document.addEventListener('DOMContentLoaded', async () => {
  await fetchLibraryClips();
  setupDynamicSearch();
  setupCheckoutModal();
});

/**
 * Fetch clips from backend API
 */
async function fetchLibraryClips(category = 'All clips') {
  try {
    const url = category && category !== 'All clips'
      ? `/api/library/clips?category=${encodeURIComponent(category)}&limit=24`
      : `/api/library/clips?limit=24`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.success && data.clips) {
      backendClips = data.clips;
      if (typeof window.clipsData !== 'undefined') {
        window.clipsData = data.clips;
      }
      if (typeof window.applyFilters === 'function') {
        window.applyFilters();
      }
    }
  } catch (err) {
    console.warn('Backend unavailable, using static catalog:', err);
  }
}

/**
 * Enhanced search with backend hook and social link detection
 */
function setupDynamicSearch() {
  const searchInput = document.getElementById('librarySearchInput');
  if (!searchInput) return;

  let debounceTimer = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const q = e.target.value.trim();
      if (!q) {
        fetchLibraryClips(window.currentSelectedCategory || 'All clips');
        return;
      }

      try {
        const res = await fetch(`/api/library/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();

        if (data.success && data.clips) {
          window.clipsData = data.clips;

          // If a TikTok or Instagram link was detected, show inferred hook style
          showSocialLinkBanner(data.socialIntent);

          if (typeof window.applyFilters === 'function') {
            window.applyFilters();
          }
        }
      } catch (err) {
        console.warn('Search fallback to client:', err);
      }
    }, 300);
  });
}

function showSocialLinkBanner(socialIntent) {
  let banner = document.getElementById('social-link-hook-banner');
  if (!socialIntent || !socialIntent.isSocialLink) {
    if (banner) banner.classList.add('hidden');
    return;
  }

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'social-link-hook-banner';
    const mainContainer = document.querySelector('main');
    if (mainContainer) {
      mainContainer.insertBefore(banner, mainContainer.children[1]);
    }
  }

  banner.className = 'w-full bg-[#f5f3ff] border border-[#ddd6fe] rounded-[12px] p-3.5 mb-5 flex items-center justify-between text-[12.5px] text-[#4c1d95]';
  banner.innerHTML = `
    <div class="flex items-center gap-2.5">
      <span class="w-7 h-7 rounded-full bg-[#8b5cf6] text-white flex items-center justify-center font-bold text-[12px]">✨</span>
      <div>
        <span class="font-bold">${escapeHtml(socialIntent.platform)} Link Detected!</span>
        <span class="text-[#6d28d9] ml-1">Matched viral hook style: <strong>${escapeHtml(socialIntent.inferredHookStyle)}</strong>. Showing best reaction clips below.</span>
      </div>
    </div>
    <span class="text-[11px] bg-[#8b5cf6] text-white px-2 py-0.5 rounded-full font-medium">Auto-matched</span>
  `;
  banner.classList.remove('hidden');
}

/**
 * Hook floating dock pricing to dynamic bundle engine
 */
const originalUpdateSelectionDock = window.updateSelectionDock;
window.updateSelectionDock = async function() {
  const dock = document.getElementById('floatingSelectionDock');
  const countSpan = document.getElementById('dockSelectedCount');
  const totalSpan = document.getElementById('dockSelectedTotal');

  if (!window.selectedClipIds) return;
  const count = window.selectedClipIds.size;

  if (count > 0) {
    dock.classList.remove('hidden');
    dock.classList.add('flex');
    countSpan.innerText = `${count} ${count === 1 ? 'clip' : 'clips'} selected`;

    // Calculate bundle pricing from backend
    try {
      const clipIds = Array.from(window.selectedClipIds);
      const res = await fetch('/api/cart/bundle-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipIds })
      });
      const data = await res.json();
      if (data.success && data.pricing) {
        const p = data.pricing;
        if (p.discountPercent > 0) {
          totalSpan.innerHTML = `<span>$${p.total.toFixed(2)}</span> <span class="text-[10px] text-[#10b981] ml-1 font-semibold">(${p.discountPercent}% OFF)</span>`;
        } else {
          totalSpan.innerText = `$${p.total.toFixed(2)}`;
        }
        return;
      }
    } catch (e) {}

    totalSpan.innerText = `$${(count * 15).toFixed(2)}`;
  } else {
    dock.classList.add('hidden');
    dock.classList.remove('flex');
  }
};

/**
 * Checkout modal and instant commercial licensing handler
 */
function setupCheckoutModal() {
  const dockBtn = document.querySelector('#floatingSelectionDock button, #floatingSelectionDock a');
  if (dockBtn) {
    dockBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleLibraryCheckout();
    });
  }
}

async function handleLibraryCheckout() {
  if (!window.selectedClipIds || window.selectedClipIds.size === 0) {
    alert('Please select at least one clip.');
    return;
  }

  const clipIds = Array.from(window.selectedClipIds);
  const email = prompt('Enter your email to receive your commercial license and download links:', 'marketing@yourbrand.com');
  if (!email) return;

  try {
    const res = await fetch('/api/library/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clipIds,
        sessionId: currentSessionId,
        email
      })
    });

    const data = await res.json();
    if (data.success) {
      alert(`🎉 Order Completed!\n\nOrder ID: ${data.orderId}\nLicense Key: ${data.licenseKey}\nTotal: $${data.pricing.total.toFixed(2)}\n\nCommercial rights granted for paid ads. Download links delivered.`);
      window.selectedClipIds.clear();
      window.updateSelectionDock();
      if (typeof window.applyFilters === 'function') {
        window.applyFilters();
      }
    } else {
      alert('Checkout error: ' + (data.error || 'Please try again'));
    }
  } catch (err) {
    console.error('Checkout error:', err);
    alert('Could not complete checkout. Please try again.');
  }
}

window.handleLibraryCheckout = handleLibraryCheckout;
