const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const isVercel = process.env.VERCEL === '1' || process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;
const localDbPath = path.join(__dirname, 'database.sqlite');
const dbPath = isVercel ? path.join('/tmp', 'database.sqlite') : localDbPath;

if (isVercel && !fs.existsSync(dbPath) && fs.existsSync(localDbPath)) {
  try {
    fs.copyFileSync(localDbPath, dbPath);
  } catch (err) {
    console.warn('Could not copy bundled database to /tmp:', err.message);
  }
}

const db = new DatabaseSync(dbPath);

// Enable WAL mode & foreign keys for performance and integrity
try {
  db.exec('PRAGMA journal_mode = WAL;');
} catch (e) {
  db.exec('PRAGMA journal_mode = DELETE;');
}
db.exec('PRAGMA foreign_keys = ON;');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS creators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    handle TEXT,
    avatar TEXT,
    status TEXT DEFAULT 'active',
    rate REAL DEFAULT 30.00,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    brand_name TEXT,
    about_brand TEXT,
    filming_instructions TEXT,
    qty INTEGER DEFAULT 6,
    rate REAL DEFAULT 30.00,
    total REAL DEFAULT 180.00,
    per_creator INTEGER DEFAULT 3,
    selected_creators TEXT, -- JSON array
    concepts TEXT,          -- JSON array
    status TEXT DEFAULT 'draft',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    brief_id TEXT,
    session_id TEXT,
    status TEXT DEFAULT 'pending',
    brand_name TEXT,
    qty INTEGER NOT NULL,
    rate REAL NOT NULL,
    total REAL NOT NULL,
    per_creator INTEGER NOT NULL,
    selected_creators TEXT,
    concepts TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(brief_id) REFERENCES briefs(id)
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mimetype TEXT,
    size INTEGER,
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS usage_metrics (
    year_month TEXT PRIMARY KEY,
    class_a_ops INTEGER DEFAULT 0,
    class_b_ops INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS library_clips (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    creator TEXT NOT NULL,
    handle TEXT,
    category TEXT NOT NULL,
    emotion TEXT,
    tags TEXT, -- JSON array
    duration TEXT,
    price REAL DEFAULT 15.00,
    thumbnail TEXT,
    video_url TEXT,
    preview_url TEXT,
    rating TEXT,
    views_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS library_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS library_favorites (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    clip_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(clip_id) REFERENCES library_clips(id)
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    clip_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(clip_id) REFERENCES library_clips(id)
  );

  CREATE TABLE IF NOT EXISTS library_orders (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    items TEXT NOT NULL, -- JSON array
    subtotal REAL NOT NULL,
    discount REAL NOT NULL,
    total REAL NOT NULL,
    license_key TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS open_orders (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    brand_name TEXT NOT NULL,
    title TEXT NOT NULL,
    format_type TEXT NOT NULL, -- 'reaction' or 'full_ugc'
    format_link TEXT,
    source_media_url TEXT,
    layout_instruction TEXT DEFAULT 'split_screen', -- 'split_screen', 'picture_in_picture', 'side_by_side'
    details TEXT,
    script TEXT,
    talking_points TEXT,
    hooks TEXT,
    requires_shipping INTEGER DEFAULT 0,
    shipping_product_name TEXT,
    shipping_origin TEXT, -- JSON
    shipping_destination TEXT, -- JSON
    tracking_number TEXT,
    carrier TEXT,
    shipping_status TEXT DEFAULT 'not_required', -- 'not_required', 'pending_shipment', 'in_transit', 'delivered'
    shipping_delivered_at DATETIME,
    creator_pay REAL NOT NULL,
    platform_fee REAL NOT NULL,
    total REAL NOT NULL,
    escrow_status TEXT DEFAULT 'held', -- 'pending_payment', 'held', 'partially_released', 'released', 'refunded'
    payment_intent_id TEXT,
    status TEXT DEFAULT 'open', -- 'open', 'claimed', 'in_progress', 'shipping', 'submitted', 'in_review', 'completed', 'cancelled'
    max_applicants INTEGER DEFAULT 3,
    assigned_creator_id TEXT,
    assigned_creator_name TEXT,
    assigned_at DATETIME,
    turnaround_hours INTEGER NOT NULL,
    due_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_claims (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    creator_name TEXT NOT NULL,
    pitch TEXT,
    status TEXT DEFAULT 'pending', -- 'pending', 'assigned', 'withdrawn', 'rejected'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES open_orders(id)
  );

  CREATE TABLE IF NOT EXISTS order_deliverables (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    video_url TEXT NOT NULL,
    preview_thumbnail TEXT,
    notes TEXT,
    format_type TEXT NOT NULL,
    verification_report TEXT, -- JSON
    status TEXT DEFAULT 'submitted', -- 'submitted', 'revision_requested', 'approved', 'rejected'
    brand_feedback TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    FOREIGN KEY(order_id) REFERENCES open_orders(id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_type TEXT NOT NULL, -- 'brand', 'creator'
    recipient_id TEXT NOT NULL,
    order_id TEXT,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS creator_payouts (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    stripe_account_id TEXT,
    payout_method TEXT,
    status TEXT DEFAULT 'completed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(creator_id) REFERENCES creators(id)
  );

  CREATE TABLE IF NOT EXISTS brand_sessions (
    id TEXT PRIMARY KEY,
    brand_name TEXT NOT NULL,
    email TEXT,
    api_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_format_state (
    session_id TEXT PRIMARY KEY,
    format_choice TEXT NOT NULL,
    format_key TEXT NOT NULL,
    rate REAL NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_session_state (
    session_id TEXT PRIMARY KEY,
    format_choice TEXT NOT NULL DEFAULT 'Reaction Video',
    format_key TEXT NOT NULL DEFAULT 'reaction',
    selected_creators TEXT DEFAULT '[]',
    qty INTEGER DEFAULT 6,
    rate REAL DEFAULT 25.00,
    min_videos INTEGER DEFAULT 5,
    pricing_data TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS prompt_drafts (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    format TEXT DEFAULT 'Reaction Video',
    format_key TEXT DEFAULT 'reaction',
    prompt_text TEXT,
    brand_name TEXT,
    selected_creators TEXT,
    brief_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    org_id TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT UNIQUE,
    plan_tier TEXT NOT NULL CHECK(plan_tier IN ('starter', 'growth', 'scale')),
    billing_interval TEXT NOT NULL CHECK(billing_interval IN ('month', 'year')),
    status TEXT NOT NULL DEFAULT 'trialing' CHECK(status IN ('trialing', 'active', 'past_due', 'canceled')),
    trial_end DATETIME,
    current_period_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    current_period_end DATETIME NOT NULL,
    cancel_at_period_end INTEGER DEFAULT 0,
    last_monthly_grant_at DATETIME,
    last_quarterly_grant_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS credit_wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    org_id TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    lifetime_earned INTEGER NOT NULL DEFAULT 0,
    lifetime_spent INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('monthly_grant', 'quarterly_bonus', 'clip_purchase', 'custom_order', 'expiration', 'refund', 'trial_grant')),
    reference_id TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(wallet_id) REFERENCES credit_wallets(id)
  );

  CREATE TABLE IF NOT EXISTS entitlements (
    plan_tier TEXT PRIMARY KEY CHECK(plan_tier IN ('starter', 'growth', 'scale')),
    name TEXT NOT NULL,
    monthly_price_usd INTEGER NOT NULL,
    yearly_monthly_price_usd INTEGER NOT NULL,
    yearly_total_price_usd INTEGER NOT NULL,
    monthly_credits INTEGER NOT NULL,
    quarterly_bonus_credits INTEGER NOT NULL,
    approx_clips INTEGER NOT NULL,
    clip_credit_cost INTEGER NOT NULL DEFAULT 11,
    max_social_sets INTEGER NOT NULL,
    has_sofia_mcp INTEGER NOT NULL DEFAULT 0,
    has_agent_sofia_dashboard INTEGER NOT NULL DEFAULT 1,
    has_public_api INTEGER NOT NULL DEFAULT 0,
    has_onboarding_call INTEGER NOT NULL DEFAULT 0,
    custom_order_discount_pct INTEGER NOT NULL DEFAULT 0,
    trial_days INTEGER NOT NULL DEFAULT 7
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'stripe',
    event_type TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'processed',
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS social_sets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    tiktok_handle TEXT,
    instagram_handle TEXT,
    youtube_handle TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default plan entitlements matching pricing.html
try {
  const upsertEntitlement = db.prepare(`
    INSERT INTO entitlements (
      plan_tier, name, monthly_price_usd, yearly_monthly_price_usd, yearly_total_price_usd,
      monthly_credits, quarterly_bonus_credits, approx_clips, clip_credit_cost,
      max_social_sets, has_sofia_mcp, has_agent_sofia_dashboard, has_public_api,
      has_onboarding_call, custom_order_discount_pct, trial_days
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plan_tier) DO UPDATE SET
      name = excluded.name,
      monthly_price_usd = excluded.monthly_price_usd,
      yearly_monthly_price_usd = excluded.yearly_monthly_price_usd,
      yearly_total_price_usd = excluded.yearly_total_price_usd,
      monthly_credits = excluded.monthly_credits,
      quarterly_bonus_credits = excluded.quarterly_bonus_credits,
      approx_clips = excluded.approx_clips,
      clip_credit_cost = excluded.clip_credit_cost,
      max_social_sets = excluded.max_social_sets,
      has_sofia_mcp = excluded.has_sofia_mcp,
      has_agent_sofia_dashboard = excluded.has_agent_sofia_dashboard,
      has_public_api = excluded.has_public_api,
      has_onboarding_call = excluded.has_onboarding_call,
      custom_order_discount_pct = excluded.custom_order_discount_pct,
      trial_days = excluded.trial_days
  `);

  upsertEntitlement.run('starter', 'Starter', 280, 224, 2688, 370, 70, 35, 11, 1, 0, 1, 0, 0, 0, 7);
  upsertEntitlement.run('growth', 'Growth', 880, 704, 8448, 1500, 210, 110, 11, 5, 1, 1, 0, 0, 5, 7);
  upsertEntitlement.run('scale', 'Scale', 2980, 2384, 28608, 3700, 650, 350, 11, 10, 1, 1, 1, 1, 10, 7);
} catch (e) {
  console.warn('Entitlements seed note:', e.message);
}

// Seed default order format state if empty
try {
  db.prepare(`
    INSERT OR IGNORE INTO order_format_state (session_id, format_choice, format_key, rate)
    VALUES ('default_session', 'Reaction Video', 'reaction', 25.00)
  `).run();
} catch (e) {
  console.warn('order_format_state init note:', e.message);
}

// Creator schema migrations
const creatorCols = db.prepare("PRAGMA table_info(creators)").all().map(c => c.name);
if (!creatorCols.includes('formats')) {
  db.exec("ALTER TABLE creators ADD COLUMN formats TEXT;");
}
if (!creatorCols.includes('rating')) {
  db.exec("ALTER TABLE creators ADD COLUMN rating TEXT DEFAULT '5.0 (20)';");
}
if (!creatorCols.includes('completed_orders')) {
  db.exec("ALTER TABLE creators ADD COLUMN completed_orders INTEGER DEFAULT 0;");
}
if (!creatorCols.includes('shipping_address')) {
  db.exec("ALTER TABLE creators ADD COLUMN shipping_address TEXT;");
}
if (!creatorCols.includes('stripe_account_id')) {
  db.exec("ALTER TABLE creators ADD COLUMN stripe_account_id TEXT;");
}
if (!creatorCols.includes('stripe_connected')) {
  db.exec("ALTER TABLE creators ADD COLUMN stripe_connected INTEGER DEFAULT 0;");
}
if (!creatorCols.includes('stripe_payout_details')) {
  db.exec("ALTER TABLE creators ADD COLUMN stripe_payout_details TEXT;");
}
if (!creatorCols.includes('country')) {
  db.exec("ALTER TABLE creators ADD COLUMN country TEXT;");
}
if (!creatorCols.includes('country_code')) {
  db.exec("ALTER TABLE creators ADD COLUMN country_code TEXT;");
}
if (!creatorCols.includes('languages')) {
  db.exec("ALTER TABLE creators ADD COLUMN languages TEXT;");
}
if (!creatorCols.includes('gender')) {
  db.exec("ALTER TABLE creators ADD COLUMN gender TEXT;");
}
if (!creatorCols.includes('creator_type')) {
  db.exec("ALTER TABLE creators ADD COLUMN creator_type TEXT;");
}
if (!creatorCols.includes('bio')) {
  db.exec("ALTER TABLE creators ADD COLUMN bio TEXT;");
}
if (!creatorCols.includes('email')) {
  db.exec("ALTER TABLE creators ADD COLUMN email TEXT;");
}

// Seed default creators if empty or missing specialists
try {
  const insertCreatorStmt = db.prepare(`
    INSERT OR IGNORE INTO creators (
      id, name, handle, avatar, status, rate, formats, rating, completed_orders,
      country, country_code, languages, gender, creator_type, bio
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const initialCreators = [
    ['kris', 'Kris', '@kris_creator', 'assets/creators_page/kris.png', 'active', 30.00, JSON.stringify(['reaction', 'full_ugc']), '5.0 (28)', 14, 'Latvia', 'LV', 'English, Latvian', 'male', 'standard', 'High energy relatable tech & lifestyle creator'],
    ['angelika', 'Angelika', '@angelika_ugc', 'assets/creators_page/angelika.png', 'active', 35.00, JSON.stringify(['reaction', 'full_ugc']), '4.9 (42)', 22, 'Romania', 'RO', 'English, Romanian', 'female', 'exclusive', 'Beauty, lifestyle & viral hook reactions'],
    ['franci', 'Franci', '@franci_ugc', 'assets/creators_page/franci.png', 'active', 35.00, JSON.stringify(['reaction', 'full_ugc']), '5.0 (65)', 31, 'Latvia', 'LV', 'English', 'female', 'viral', 'Viral reaction specialist with 10M+ views'],
    ['emilia', 'Emilia', '@emilia_ugc', 'assets/creators_page/emilia.png', 'active', 30.00, JSON.stringify(['reaction', 'full_ugc']), '4.8 (19)', 9, 'Poland', 'PL', 'English, Latvian, Polish', 'female', 'standard', 'Authentic student & Gen-Z product demos'],
    ['andrea', 'Andrea', '@andrea_ugc', 'assets/creators_page/andrea.png', 'active', 40.00, JSON.stringify(['reaction', 'full_ugc']), '5.0 (31)', 18, 'Austria', 'AT', 'English, Romanian, German', 'female', 'exclusive', 'Fashion, fitness and luxury UGC producer'],
    ['creator_1', 'Sofia', '@sofia.ugc', 'avatar_1.png', 'active', 30.00, JSON.stringify(['reaction', 'full_ugc']), '5.0 (25)', 12, 'United States', 'US', 'English', 'female', 'exclusive', 'App walkthroughs & social proof'],
    ['creator_2', 'Maya', '@maya_creates', 'avatar_2.png', 'active', 30.00, JSON.stringify(['reaction']), '5.0 (20)', 15, 'United States', 'US', 'English', 'female', 'viral', 'Dating & lifestyle reaction hooks'],
    ['creator_3', 'Robert', '@robert_visuals', 'avatar_3.png', 'active', 50.00, JSON.stringify(['full_ugc']), '5.0 (35)', 20, 'United Kingdom', 'GB', 'English', 'male', 'exclusive', 'Professional studio with 4K setup and high conversion track record.'],
    ['creator_4', 'Sarah', '@sarah_lifestyle', 'avatar_full.png', 'active', 30.00, JSON.stringify(['full_ugc']), '4.9 (18)', 11, 'Canada', 'CA', 'English', 'female', 'standard', 'Wellness & daily routine testimonials'],
    ['creator_5', 'Franci', '@franci_reactions', 'assets/creators_page/franci.png', 'active', 35.00, JSON.stringify(['reaction']), '5.0 (50)', 28, 'Latvia', 'LV', 'English', 'female', 'viral', 'Ready to shoot reaction clips and curiosity hooks']
  ];

  for (const c of initialCreators) {
    insertCreatorStmt.run(...c);
  }
} catch (e) {
  console.warn('Creators seed note:', e.message);
}

// Ensure any legacy fake clips are cleared from library
try {
  db.prepare("DELETE FROM library_favorites WHERE clip_id LIKE 'clip-%'").run();
  db.prepare("DELETE FROM cart_items WHERE clip_id LIKE 'clip-%'").run();
  db.prepare("DELETE FROM library_clips WHERE id LIKE 'clip-%'").run();
} catch (e) {
  console.warn('Library cleanup note:', e.message);
}

module.exports = db;
