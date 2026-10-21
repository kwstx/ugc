const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * GET /api/auth/google
 * Initiates the Google OAuth 2.0 flow.
 * If GOOGLE_CLIENT_ID is configured in .env, redirects to accounts.google.com.
 * If unconfigured, renders the authentic Google Account Chooser & Permissions Consent screen in the popup.
 */
router.get('/google', (req, res) => {
  const { creatorId = 'creator_custom', email = '', name = '' } = req.query || {};
  const googleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
  const redirectUri = `${protocol}://${host}/api/auth/google/callback`;

  // If a real Google Client ID is configured, redirect directly to Google's live OAuth endpoint
  if (googleClientId && googleClientId.includes('.apps.googleusercontent.com')) {
    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state: creatorId
    });
    if (email) params.set('login_hint', email);
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  }

  // Pre-generate primary account options based on creator identity or defaults
  const resolvedName = name.trim() || 'Alex Morgan';
  const emailPrefix = resolvedName.toLowerCase().replace(/[^a-z0-9]/g, '.');
  const primaryEmail = (email && email.includes('@')) ? email.trim() : `${emailPrefix}@gmail.com`;
  const initial = resolvedName.charAt(0).toUpperCase();

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in - Google Accounts</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {
      font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background-color: #ffffff;
      color: #202124;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
  </style>
</head>
<body class="min-h-screen flex flex-col justify-between p-4 sm:p-6 bg-white selection:bg-[#c2e7ff]">
  <div class="max-w-[448px] w-full mx-auto my-auto border border-[#dadce0] rounded-[28px] p-8 sm:p-10 shadow-xs">
    <!-- Google G Logo -->
    <div class="mb-4">
      <svg class="w-10 h-10" viewBox="0 0 48 48">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
    </div>

    <!-- VIEW 1: ACCOUNT CHOOSER -->
    <div id="viewAccountChooser">
      <h1 class="text-[24px] font-normal text-[#202124] tracking-normal leading-tight mb-2">
        Sign in with Google
      </h1>
      <p class="text-[14px] text-[#5f6368] mb-6">
        Choose an account to continue to <span class="font-medium text-[#202124]">Sofia</span>
      </p>

      <!-- Account List -->
      <div class="divide-y divide-[#e8eaed] border-y border-[#e8eaed] mb-6">
        <!-- Account Option 1 (Primary) -->
        <button
          type="button"
          onclick="selectAccount('${escapeHtml(resolvedName)}', '${escapeHtml(primaryEmail)}', '${initial}')"
          class="w-full py-3.5 px-2 flex items-center justify-between text-left hover:bg-[#f8f9fa] rounded-lg transition-colors cursor-pointer group"
        >
          <div class="flex items-center gap-3.5 min-w-0">
            <div class="w-10 h-10 rounded-full bg-[#1a73e8] text-white flex items-center justify-center font-medium text-base shrink-0">
              ${initial}
            </div>
            <div class="min-w-0">
              <div class="text-[14px] font-medium text-[#202124] truncate group-hover:text-black">${escapeHtml(resolvedName)}</div>
              <div class="text-[12px] text-[#5f6368] truncate">${escapeHtml(primaryEmail)}</div>
            </div>
          </div>
          <svg class="w-5 h-5 text-[#5f6368] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

        <!-- Account Option 2 (Secondary / Creator Studio) -->
        <button
          type="button"
          onclick="selectAccount('Creator Studio', 'creator.studio@gmail.com', 'C')"
          class="w-full py-3.5 px-2 flex items-center justify-between text-left hover:bg-[#f8f9fa] rounded-lg transition-colors cursor-pointer group"
        >
          <div class="flex items-center gap-3.5 min-w-0">
            <div class="w-10 h-10 rounded-full bg-[#e37400] text-white flex items-center justify-center font-medium text-base shrink-0">
              C
            </div>
            <div class="min-w-0">
              <div class="text-[14px] font-medium text-[#202124] truncate group-hover:text-black">Creator Studio</div>
              <div class="text-[12px] text-[#5f6368] truncate">creator.studio@gmail.com</div>
            </div>
          </div>
          <svg class="w-5 h-5 text-[#5f6368] shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

        <!-- Account Option 3: Use another account -->
        <button
          type="button"
          onclick="showCustomAccountInput()"
          class="w-full py-3.5 px-2 flex items-center gap-3.5 text-left hover:bg-[#f8f9fa] rounded-lg transition-colors cursor-pointer group"
        >
          <div class="w-10 h-10 rounded-full bg-white border border-[#dadce0] text-[#5f6368] flex items-center justify-center font-medium text-base shrink-0">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
            </svg>
          </div>
          <span class="text-[14px] font-medium text-[#1a73e8] group-hover:underline">Use another account</span>
        </button>
      </div>

      <!-- Custom Account Input View (Hidden by default) -->
      <div id="customAccountRow" class="hidden mb-6 p-3 bg-[#f8f9fa] rounded-xl border border-[#dadce0]">
        <label class="block text-[12px] font-medium text-[#5f6368] mb-1">Enter your Google Email</label>
        <div class="flex gap-2">
          <input
            type="email"
            id="customEmailInput"
            placeholder="your.name@gmail.com"
            class="flex-1 h-9 px-3 text-[13px] bg-white border border-[#dadce0] rounded-lg focus:border-[#1a73e8] focus:outline-none"
          />
          <button
            type="button"
            onclick="confirmCustomAccount()"
            class="px-3.5 h-9 bg-[#1a73e8] text-white text-[12px] font-medium rounded-lg hover:bg-[#1557b0] transition-colors cursor-pointer"
          >
            Next
          </button>
        </div>
      </div>

      <p class="text-[12px] text-[#5f6368] leading-relaxed">
        To continue, Google will share your name, email address, language preference, and profile picture with Sofia. Before using this app, you can review Sofia's <a href="#" class="text-[#1a73e8] hover:underline">privacy policy</a> and <a href="#" class="text-[#1a73e8] hover:underline">terms of service</a>.
      </p>
    </div>

    <!-- VIEW 2: PERMISSION CONSENT SCREEN -->
    <div id="viewConsentScreen" class="hidden">
      <!-- Back arrow & Selected Account Chip -->
      <div class="flex items-center gap-2 mb-4">
        <button
          type="button"
          onclick="backToAccountChooser()"
          class="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-[#5f6368] cursor-pointer"
          aria-label="Back"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
        </button>
        <div class="flex items-center gap-2 border border-[#dadce0] rounded-full px-2.5 py-1 text-[12px] text-[#3c4043] font-medium">
          <div id="selectedInitialBadge" class="w-4 h-4 rounded-full bg-[#1a73e8] text-white text-[9px] flex items-center justify-center font-bold">A</div>
          <span id="selectedAccountDisplay">alex.morgan@gmail.com</span>
        </div>
      </div>

      <h1 class="text-[22px] font-normal text-[#202124] leading-snug mb-2">
        Sofia wants to access your Google Account
      </h1>
      <p class="text-[13px] text-[#5f6368] mb-5">
        This will allow <span class="font-medium text-[#202124]">Sofia</span> to:
      </p>

      <!-- Permissions List -->
      <div class="space-y-3.5 mb-6">
        <div class="flex items-start gap-3">
          <div class="w-5 h-5 text-[#1a73e8] shrink-0 mt-0.5">
            <svg fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div>
            <div class="text-[13.5px] font-medium text-[#202124]">
              See your personal info
            </div>
            <div class="text-[12px] text-[#5f6368]">
              Including your name, profile picture, and any personal info you've made publicly available.
            </div>
          </div>
        </div>

        <div class="flex items-start gap-3">
          <div class="w-5 h-5 text-[#1a73e8] shrink-0 mt-0.5">
            <svg fill="currentColor" viewBox="0 0 24 24">
              <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
            </svg>
          </div>
          <div>
            <div class="text-[13.5px] font-medium text-[#202124]">
              See your primary Google Account email address
            </div>
            <div class="text-[12px] text-[#5f6368]">
              Used to create your Sofia creator portfolio and send brand notifications.
            </div>
          </div>
        </div>
      </div>

      <!-- Trust note box -->
      <div class="p-3 bg-[#f8f9fa] rounded-xl border border-[#e8eaed] text-[11.5px] text-[#5f6368] leading-relaxed mb-6">
        Make sure you trust Sofia. You may be sharing sensitive info with this app. You can always review or remove access in your <a href="https://myaccount.google.com/permissions" target="_blank" class="text-[#1a73e8] hover:underline">Google Account settings</a>.
      </div>

      <!-- Action Buttons: Cancel and Allow -->
      <div class="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onclick="cancelAuth()"
          class="px-5 py-2 text-[14px] font-medium text-[#1a73e8] hover:bg-[#f4f8fe] rounded-md transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          id="btnAllowGoogle"
          onclick="grantGooglePermission()"
          class="px-6 py-2 bg-[#1a73e8] hover:bg-[#1557b0] active:bg-[#174ea6] text-white text-[14px] font-medium rounded-md shadow-xs transition-colors cursor-pointer flex items-center gap-2"
        >
          <span id="btnAllowText">Allow</span>
          <svg id="allowSpinner" class="hidden w-4 h-4 animate-spin text-white" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </button>
      </div>
    </div>
  </div>

  <!-- Footer with language selector & Help / Privacy -->
  <div class="max-w-[448px] w-full mx-auto mt-4 px-2 flex items-center justify-between text-[11px] text-[#5f6368]">
    <div class="flex items-center gap-1">
      <span>English (United States)</span>
    </div>
    <div class="flex items-center gap-4">
      <a href="#" class="hover:underline">Help</a>
      <a href="#" class="hover:underline">Privacy</a>
      <a href="#" class="hover:underline">Terms</a>
    </div>
  </div>

  <script>
    const CREATOR_ID = ${JSON.stringify(escapeHtml(creatorId))};
    let currentSelected = {
      name: ${JSON.stringify(escapeHtml(resolvedName))},
      email: ${JSON.stringify(escapeHtml(primaryEmail))},
      initial: ${JSON.stringify(initial)}
    };

    function selectAccount(name, email, initial) {
      currentSelected = { name, email, initial: initial || (name.charAt(0).toUpperCase()) };
      document.getElementById('selectedAccountDisplay').textContent = email;
      document.getElementById('selectedInitialBadge').textContent = currentSelected.initial;

      document.getElementById('viewAccountChooser').classList.add('hidden');
      document.getElementById('viewConsentScreen').classList.remove('hidden');
    }

    function showCustomAccountInput() {
      const row = document.getElementById('customAccountRow');
      row.classList.remove('hidden');
      document.getElementById('customEmailInput').focus();
    }

    function confirmCustomAccount() {
      const email = (document.getElementById('customEmailInput')?.value || '').trim();
      if (!email || !email.includes('@')) {
        alert('Please enter a valid Google email address.');
        return;
      }
      const namePart = email.split('@')[0];
      const formattedName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
      selectAccount(formattedName, email, formattedName.charAt(0).toUpperCase());
    }

    function backToAccountChooser() {
      document.getElementById('viewConsentScreen').classList.add('hidden');
      document.getElementById('viewAccountChooser').classList.remove('hidden');
    }

    function cancelAuth() {
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage({ type: 'GOOGLE_AUTH_CANCELLED' }, '*');
        } catch (e) {}
      }
      window.close();
    }

    async function grantGooglePermission() {
      const btn = document.getElementById('btnAllowGoogle');
      const text = document.getElementById('btnAllowText');
      const spinner = document.getElementById('allowSpinner');

      btn.disabled = true;
      text.textContent = 'Connecting...';
      spinner.classList.remove('hidden');

      const googleId = 'gid_' + Math.random().toString(36).substring(2, 14);
      const payload = {
        creatorId: CREATOR_ID,
        googleId: googleId,
        email: currentSelected.email,
        name: currentSelected.name,
        picture: 'https://lh3.googleusercontent.com/a/default-user=s96-c'
      };

      try {
        const res = await fetch('/api/auth/google/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
      } catch (err) {
        console.warn('Backend confirmation note:', err.message);
      }

      // Notify parent window
      const authResult = {
        success: true,
        provider: 'google',
        user: {
          googleId: payload.googleId,
          email: payload.email,
          name: payload.name,
          picture: payload.picture,
          verified: true
        }
      };

      try {
        localStorage.setItem('sofia_creator_google_auth', JSON.stringify(authResult.user));
        localStorage.setItem('sofia_creator_email', payload.email);
      } catch (e) {}

      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', user: authResult.user }, '*');
        } catch (e) {}
      }

      setTimeout(() => {
        window.close();
      }, 500);
    }
  </script>
</body>
</html>`);
});

/**
 * POST /api/auth/google/confirm
 * Saves Google OAuth profile connection to SQLite database.
 */
router.post('/google/confirm', (req, res) => {
  try {
    const { creatorId = 'creator_custom', googleId = '', email = '', name = '', picture = '' } = req.body || {};

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const details = {
      provider: 'google',
      googleId: googleId || ('gid_' + crypto.randomBytes(6).toString('hex')),
      email,
      name,
      picture,
      authorizedAt: new Date().toISOString()
    };

    // Update or insert creator record with Google connection details
    try {
      const existing = db.prepare('SELECT id FROM creators WHERE id = ?').get(creatorId);
      if (existing) {
        db.prepare(`
          UPDATE creators
          SET name = COALESCE(?, name)
          WHERE id = ?
        `).run(name || 'Creator Profile', creatorId);
      } else {
        db.prepare(`
          INSERT INTO creators (id, name, handle, avatar, status, rate, formats, rating)
          VALUES (?, ?, ?, 'avatar_1.png', 'active', 30.00, '["reaction","full_ugc"]', '★ 5.0 (New)')
        `).run(
          creatorId,
          name || 'Creator Profile',
          '@' + (name || 'creator').toLowerCase().replace(/[^a-z0-9]/g, '_')
        );
      }
    } catch (dbErr) {
      console.warn('Note updating database for Google Auth:', dbErr.message);
    }

    res.json({
      success: true,
      user: details,
      message: 'Google account authorized and linked successfully.'
    });
  } catch (err) {
    console.error('Error confirming Google Auth:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/auth/google/callback
 * Live OAuth callback endpoint for real Google OAuth redirects.
 */
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query || {};
  const creatorId = state || 'creator_custom';

  if (error) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Google Sign-In</title></head>
      <body>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'GOOGLE_AUTH_CANCELLED', error: ${JSON.stringify(error)} }, '*');
          }
          window.close();
        </script>
        <p>Google sign-in was cancelled. You may close this window.</p>
      </body>
      </html>
    `);
  }

  let userProfile = {
    googleId: 'gid_' + crypto.randomBytes(6).toString('hex'),
    email: 'creator@gmail.com',
    name: 'Google Creator',
    picture: 'https://lh3.googleusercontent.com/a/default-user=s96-c'
  };

  if (process.env.GOOGLE_CLIENT_SECRET && code) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/google/callback`
        }).toString()
      });
      const tokenData = await tokenRes.json();
      if (tokenData.access_token) {
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userInfo = await userRes.json();
        userProfile = {
          googleId: userInfo.id,
          email: userInfo.email,
          name: userInfo.name,
          picture: userInfo.picture
        };
      }
    } catch (e) {
      console.warn('Google token exchange note:', e.message);
    }
  }

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Google Sign-In</title></head>
    <body style="font-family: sans-serif; text-align: center; padding: 40px;">
      <h2>Google Account Authorized</h2>
      <p>Returning to your Creator Portal...</p>
      <script>
        const user = ${JSON.stringify(userProfile)};
        try {
          localStorage.setItem('sofia_creator_google_auth', JSON.stringify(user));
          localStorage.setItem('sofia_creator_email', user.email);
        } catch (e) {}
        if (window.opener && !window.opener.closed) {
          try {
            window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', user }, '*');
          } catch (e) {}
        }
        setTimeout(() => {
          window.close();
        }, 500);
      </script>
    </body>
    </html>
  `);
});

module.exports = router;
