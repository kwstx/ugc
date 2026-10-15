const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new DatabaseSync(dbPath);

// Enable WAL mode & foreign keys for performance and integrity
db.exec('PRAGMA journal_mode = WAL;');
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

  CREATE TABLE IF NOT EXISTS brand_sessions (
    id TEXT PRIMARY KEY,
    brand_name TEXT NOT NULL,
    email TEXT,
    api_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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

// Seed default creators if empty
const countStmt = db.prepare('SELECT COUNT(*) as count FROM creators');
const creatorCount = countStmt.get().count;

if (creatorCount === 0) {
  const insertCreator = db.prepare(`
    INSERT INTO creators (id, name, handle, avatar, status, rate, formats, rating, shipping_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const initialCreators = [
    ['creator_1', 'Sofia', '@sofia.ugc', 'avatar_1.png', 'active', 30.00, JSON.stringify(['reaction', 'full_ugc']), '4.9 (48)', JSON.stringify({ street: '124 Market St #4', city: 'Austin', state: 'TX', zip: '78701' })],
    ['creator_2', 'Maya', '@maya_creates', 'avatar_2.png', 'active', 30.00, JSON.stringify(['reaction']), '5.0 (34)', JSON.stringify({ street: '89 Sunset Blvd', city: 'Los Angeles', state: 'CA', zip: '90028' })],
    ['creator_3', 'Robert', '@robert_visuals', 'avatar_3.png', 'active', 30.00, JSON.stringify(['full_ugc']), '4.8 (56)', JSON.stringify({ street: '450 Broadway', city: 'New York', state: 'NY', zip: '10013' })],
    ['creator_4', 'Sarah', '@sarah_lifestyle', 'avatar_full.png', 'active', 30.00, JSON.stringify(['reaction', 'full_ugc']), '5.0 (29)', JSON.stringify({ street: '772 Ocean Dr', city: 'Miami', state: 'FL', zip: '33139' })]
  ];

  for (const c of initialCreators) {
    insertCreator.run(...c);
  }
}

// Ensure creators have formats and ratings configured
const updateCreatorStmt = db.prepare('UPDATE creators SET formats = ?, rating = ?, shipping_address = ? WHERE id = ?');
try {
  updateCreatorStmt.run(JSON.stringify(['reaction', 'full_ugc']), '4.9 (48)', JSON.stringify({ street: '124 Market St #4', city: 'Austin', state: 'TX', zip: '78701' }), 'creator_1');
  updateCreatorStmt.run(JSON.stringify(['reaction']), '5.0 (34)', JSON.stringify({ street: '89 Sunset Blvd', city: 'Los Angeles', state: 'CA', zip: '90028' }), 'creator_2');
  updateCreatorStmt.run(JSON.stringify(['full_ugc']), '4.8 (56)', JSON.stringify({ street: '450 Broadway', city: 'New York', state: 'NY', zip: '10013' }), 'creator_3');
  updateCreatorStmt.run(JSON.stringify(['reaction', 'full_ugc']), '5.0 (29)', JSON.stringify({ street: '772 Ocean Dr', city: 'Miami', state: 'FL', zip: '33139' }), 'creator_4');

  const insertOrIgnoreCreator = db.prepare(`
    INSERT OR IGNORE INTO creators (id, name, handle, avatar, status, rate, formats, rating, completed_orders, shipping_address)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 0, ?)
  `);
  insertOrIgnoreCreator.run('creator_5', 'Franci', '@franci_ugc', 'assets/order/thumb_shocked.png', 25.00, JSON.stringify(['reaction']), '4.9 (88)', JSON.stringify({ street: '210 Pine St', city: 'Seattle', state: 'WA', zip: '98101' }));
  insertOrIgnoreCreator.run('creator_6', 'Marcus', '@marcus_fit', 'assets/library/clip_4.png', 35.00, JSON.stringify(['full_ugc']), '4.8 (26)', JSON.stringify({ street: '55 Boulder Way', city: 'Denver', state: 'CO', zip: '80202' }));
} catch (e) {
  console.warn('Creator update migration note:', e.message);
}

// Seed default library clips if empty
const clipCountStmt = db.prepare('SELECT COUNT(*) as count FROM library_clips');
const clipCount = clipCountStmt.get().count;

if (clipCount === 0) {
  const insertClip = db.prepare(`
    INSERT INTO library_clips (id, title, creator, handle, category, emotion, tags, duration, price, thumbnail, video_url, preview_url, rating, views_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const initialClips = [
    [
      'clip-1', 'Guy laughing uncontrollably at his phone', 'Alex M.', '@alex_ugc',
      'Productivity & Work', 'Laughing',
      JSON.stringify(['laughing', 'guy', 'phone', 'laughing at phone', 'funny', 'skits', 'amused', 'smile', 'happy']),
      '0:04', 15.00, 'assets/library/clip_1.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-1.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-1.mp4',
      '5.0 (42)', 1420
    ],
    [
      'clip-2', 'Shocked mouth wide open disbelief reaction', 'Franci', '@franci_ugc',
      "Women's Health", 'Shocked',
      JSON.stringify(['shocked', 'disbelief', 'mouth open', 'reaction', 'surprised', 'viral', 'hook', 'omg', 'jaw drop']),
      '0:03', 15.00, 'assets/order/thumb_shocked.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-2.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-2.mp4',
      '4.9 (88)', 2890
    ],
    [
      'clip-3', 'Emotional crying tears of relief reaction', 'Sarah T.', '@sarah_ugc',
      'Sleep & Wellness', 'Crying',
      JSON.stringify(['crying', 'emotional', 'tears', 'sad', 'touching', 'relief', 'reaction', 'female']),
      '0:05', 15.00, 'assets/book_creator/creator_crying.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-3.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-3.mp4',
      '5.0 (31)', 1130
    ],
    [
      'clip-4', 'Girl laughing and pointing at phone screen', 'Emilia', '@emilia_ugc',
      'Nutrition & Food', 'Laughing',
      JSON.stringify(['laughing', 'girl', 'phone', 'pointing', 'funny', 'happy', 'screen', 'laughing at phone']),
      '0:04', 15.00, 'assets/library/clip_2.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-4.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-4.mp4',
      '4.9 (64)', 2100
    ],
    [
      'clip-5', 'Mind blown head grab surprised expression', 'Kris', '@kris_creator',
      'Productivity & Work', 'Surprised',
      JSON.stringify(['mind blown', 'surprised', 'shocked', 'head grab', 'wow', 'disbelief', 'talking head']),
      '0:03', 15.00, 'assets/order/thumb_surprised.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-5.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-5.mp4',
      '4.8 (52)', 1840
    ],
    [
      'clip-6', 'Talking head direct camera hook explanation', 'Andrea', '@andrea_ugc',
      'Health & Fitness', 'Talking head',
      JSON.stringify(['talking head', 'explanation', 'hook', 'speaking', 'direct camera', 'review', 'skits']),
      '0:07', 15.00, 'assets/book_creator/creator_tank.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-6.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-6.mp4',
      '5.0 (79)', 3400
    ],
    [
      'clip-7', 'Couple funny banter and relationship reaction', 'Maya & Dan', '@maya_dan',
      'Relationships', 'Couples',
      JSON.stringify(['couples', 'skits', 'couple', 'banter', 'relationship', 'dating', 'funny', 'skit']),
      '0:06', 15.00, 'assets/library/clip_3.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-7.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-7.mp4',
      '4.9 (45)', 1620
    ],
    [
      'clip-8', 'Excited happy celebration jumping with joy', 'Robert K.', '@robert_k',
      'Health & Fitness', 'Happy',
      JSON.stringify(['happy', 'excited', 'celebrate', 'joy', 'win', 'laughing', 'smile']),
      '0:04', 15.00, 'assets/order/thumb_happy.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-8.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-8.mp4',
      '5.0 (19)', 980
    ],
    [
      'clip-9', 'Sneaky curious peek looking over shoulder', 'Angelika', '@angelika_ugc',
      'Dating', 'Skits',
      JSON.stringify(['peek', 'skits', 'curious', 'looking', 'phone', 'sneaky', 'suspicious']),
      '0:04', 15.00, 'assets/book_creator/creator_peek.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-9.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-9.mp4',
      '4.9 (37)', 1250
    ],
    [
      'clip-10', 'Gym workout routine & energy check', 'Marcus', '@marcus_fit',
      'Health & Fitness', 'Talking head',
      JSON.stringify(['gym', 'fitness', 'workout', 'health', 'body', 'energy', 'health & fitness']),
      '0:05', 15.00, 'assets/library/clip_4.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-10.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-10.mp4',
      '4.8 (26)', 1540
    ],
    [
      'clip-11', 'Green screen product demo with gestures', 'Alex M.', '@alex_ugc',
      'Gut Health', 'Talking head',
      JSON.stringify(['greenscreen', 'green screen', 'product demo', 'pointing', 'review', 'demo', 'pointing at screen']),
      '0:06', 15.00, 'assets/order/thumb_greenscreen.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-11.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-11.mp4',
      '5.0 (61)', 2450
    ],
    [
      'clip-12', 'App demo live mobile walkthrough reaction', 'Emilia', '@emilia_ugc',
      'Education & Study', 'Talking head',
      JSON.stringify(['app demo', 'mobile', 'phone', 'tech', 'walkthrough', 'talking head', 'skits']),
      '0:08', 15.00, 'assets/order/thumb_app_demo.png',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/clips/clip-12.mp4',
      'https://pub-a179e3c7817f4ed39aefde80a344155f.r2.dev/previews/clip-12.mp4',
      '4.9 (43)', 1910
    ]
  ];

  for (const c of initialClips) {
    insertClip.run(...c);
  }
}

module.exports = db;
