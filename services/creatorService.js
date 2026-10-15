const db = require('../db');

/**
 * Creator Availability & Verification Service
 */

function checkCreatorsAvailability(creators = []) {
  if (!Array.isArray(creators) || creators.length === 0) {
    return {
      allAvailable: true,
      creators: []
    };
  }

  const results = [];
  let allAvailable = true;

  const selectStmt = db.prepare('SELECT * FROM creators WHERE id = ? OR LOWER(name) = LOWER(?)');
  const insertStmt = db.prepare(`
    INSERT INTO creators (id, name, handle, avatar, status, rate)
    VALUES (?, ?, ?, ?, 'active', 30.00)
  `);

  for (const c of creators) {
    const identifier = (typeof c === 'string') ? c : (c.id || c.name);
    const name = (typeof c === 'string') ? c : (c.name || 'Creator');
    const avatar = (typeof c === 'object' && c.avatar) ? c.avatar : 'avatar_1.png';

    let found = selectStmt.get(identifier, identifier);

    // If creator doesn't exist in local DB yet, auto-register them
    if (!found) {
      const newId = `creator_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      insertStmt.run(newId, name, `@${name.toLowerCase()}`, avatar);
      found = { id: newId, name, handle: `@${name.toLowerCase()}`, avatar, status: 'active', rate: 30.00 };
    }

    const isAvailable = found.status === 'active';
    if (!isAvailable) {
      allAvailable = false;
    }

    results.push({
      id: found.id,
      name: found.name,
      avatar: found.avatar || avatar,
      status: found.status,
      available: isAvailable,
      rate: found.rate
    });
  }

  return {
    allAvailable,
    creators: results
  };
}

module.exports = {
  checkCreatorsAvailability
};
