const express = require('express');
const router = express.Router();
const db = require('../db');
const { calculatePricing } = require('../services/pricingEngine');
const { analyzeScript } = require('../services/scriptEstimator');
const { checkCreatorsAvailability } = require('../services/creatorService');

const { getReactionTemplates } = require('../services/briefAiGenerator');

// Helper to generate IDs
function generateId(prefix = 'brief') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * GET /api/briefs/templates
 * Provides pre-built reaction prompt templates tailored to e-commerce, mobile applications, or beauty products.
 */
router.get('/templates', (req, res) => {
  try {
    const { format = 'reaction', niche = null } = req.query;
    const templates = getReactionTemplates(niche, format);
    res.json({
      success: true,
      format: format.toLowerCase().includes('full') ? 'Full UGC' : 'Reaction Video',
      templates
    });
  } catch (error) {
    console.error('Error fetching brief templates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/briefs/draft
 * Persists user's raw prompt text and links it to an active order or temporary session ID
 * before they navigate to the brief editor.
 */
router.post('/draft', (req, res) => {
  try {
    const {
      sessionId = 'guest_session',
      promptText = '',
      description = '',
      format = 'Reaction Video',
      formatKey = 'reaction',
      brandName = '',
      selectedCreators = [],
      briefId = null
    } = req.body;

    const textToSave = (promptText || description || '').trim();
    const draftId = `draft_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const effectiveBriefId = briefId || generateId('brief');

    const insertStmt = db.prepare(`
      INSERT INTO prompt_drafts (
        id, session_id, format, format_key, prompt_text,
        brand_name, selected_creators, brief_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    insertStmt.run(
      draftId,
      sessionId,
      format,
      formatKey,
      textToSave,
      brandName,
      JSON.stringify(selectedCreators),
      effectiveBriefId
    );

    res.json({
      success: true,
      draftId,
      briefId: effectiveBriefId,
      promptText: textToSave,
      format,
      formatKey,
      savedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error saving prompt draft:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/briefs/draft
 * Retrieves latest prompt draft for the active session
 */
router.get('/draft', (req, res) => {
  try {
    const sessionId = req.query.sessionId || req.headers['x-session-id'] || 'guest_session';
    let row = db.prepare('SELECT * FROM prompt_drafts WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1').get(sessionId);
    if (!row) {
      row = db.prepare('SELECT * FROM prompt_drafts ORDER BY updated_at DESC LIMIT 1').get();
    }

    if (row) {
      let selectedCreators = [];
      try { selectedCreators = JSON.parse(row.selected_creators || '[]'); } catch (e) {}
      return res.json({
        success: true,
        draft: {
          id: row.id,
          sessionId: row.session_id,
          format: row.format,
          formatKey: row.format_key,
          promptText: row.prompt_text,
          brandName: row.brand_name,
          selectedCreators,
          briefId: row.brief_id,
          updatedAt: row.updated_at
        }
      });
    }

    res.json({ success: true, draft: null });
  } catch (error) {
    console.error('Error loading prompt draft:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/briefs/save-draft
 * Creates a new draft brief or updates existing if id provided
 */
router.post('/save-draft', (req, res) => {
  try {
    const {
      id,
      sessionId,
      brandName = '',
      aboutBrand = '',
      filmingInstructions = '',
      qty = 6,
      format,
      selectedCreators = [],
      concepts = []
    } = req.body;

    const briefId = id || generateId('brief');
    const creatorCount = (Array.isArray(selectedCreators) && selectedCreators.length > 0) ? selectedCreators.length : 2;
    const hasExplicitPerCreator = Array.isArray(concepts) && concepts.length > 0 && concepts.every(c => c.perCreator !== undefined);
    const summedPerCreator = hasExplicitPerCreator
      ? concepts.reduce((sum, c) => sum + Math.max(1, parseInt(c.perCreator, 10) || 1), 0)
      : 0;
    const effectiveQty = (qty && (!hasExplicitPerCreator || Number(qty) !== summedPerCreator * creatorCount))
      ? parseInt(qty, 10)
      : (summedPerCreator > 0 ? (summedPerCreator * creatorCount) : (qty || 6));
    const pricing = calculatePricing(effectiveQty, creatorCount, format);

    // Analyze scripts for durations and calculate per-concept quantity & subtotal
    const analyzedConcepts = concepts.map(c => {
      const conceptPerCreator = c.perCreator !== undefined
        ? Math.max(1, parseInt(c.perCreator, 10) || 1)
        : Math.max(1, Math.round(effectiveQty / creatorCount / Math.max(1, concepts.length)));
      const conceptQty = conceptPerCreator * creatorCount;
      const conceptSubtotal = parseFloat((conceptQty * pricing.rate).toFixed(2));
      return {
        ...c,
        perCreator: conceptPerCreator,
        qty: conceptQty,
        rate: pricing.rate,
        subtotal: conceptSubtotal,
        analysis: analyzeScript(c.script || '')
      };
    });

    const creatorsJson = JSON.stringify(selectedCreators);
    const conceptsJson = JSON.stringify(analyzedConcepts);

    const existing = db.prepare('SELECT id FROM briefs WHERE id = ?').get(briefId);

    if (existing) {
      const updateStmt = db.prepare(`
        UPDATE briefs
        SET brand_name = ?, about_brand = ?, filming_instructions = ?,
            qty = ?, rate = ?, total = ?, per_creator = ?,
            selected_creators = ?, concepts = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      updateStmt.run(
        brandName, aboutBrand, filmingInstructions,
        pricing.quantity, pricing.rate, pricing.total, pricing.perCreator,
        creatorsJson, conceptsJson, briefId
      );
    } else {
      const insertStmt = db.prepare(`
        INSERT INTO briefs (
          id, session_id, brand_name, about_brand, filming_instructions,
          qty, rate, total, per_creator, selected_creators, concepts, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
      `);
      insertStmt.run(
        briefId, sessionId || 'guest_session', brandName, aboutBrand, filmingInstructions,
        pricing.quantity, pricing.rate, pricing.total, pricing.perCreator,
        creatorsJson, conceptsJson
      );
    }

    res.json({
      success: true,
      message: 'Draft brief saved successfully.',
      briefId,
      pricing,
      concepts: analyzedConcepts,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error saving draft brief:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/briefs/:id
 * Updates an existing brief draft
 */
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const {
      brandName = '',
      aboutBrand = '',
      filmingInstructions = '',
      qty = 6,
      format,
      selectedCreators = [],
      concepts = []
    } = req.body;

    const existing = db.prepare('SELECT id FROM briefs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Brief not found.' });
    }

    const creatorCount = (Array.isArray(selectedCreators) && selectedCreators.length > 0) ? selectedCreators.length : 2;
    const hasExplicitPerCreator = Array.isArray(concepts) && concepts.length > 0 && concepts.every(c => c.perCreator !== undefined);
    const summedPerCreator = hasExplicitPerCreator
      ? concepts.reduce((sum, c) => sum + Math.max(1, parseInt(c.perCreator, 10) || 1), 0)
      : 0;
    const effectiveQty = (qty && (!hasExplicitPerCreator || Number(qty) !== summedPerCreator * creatorCount))
      ? parseInt(qty, 10)
      : (summedPerCreator > 0 ? (summedPerCreator * creatorCount) : (qty || 6));
    const pricing = calculatePricing(effectiveQty, creatorCount, format);

    const analyzedConcepts = concepts.map(c => {
      const conceptPerCreator = c.perCreator !== undefined
        ? Math.max(1, parseInt(c.perCreator, 10) || 1)
        : Math.max(1, Math.round(effectiveQty / creatorCount / Math.max(1, concepts.length)));
      const conceptQty = conceptPerCreator * creatorCount;
      const conceptSubtotal = parseFloat((conceptQty * pricing.rate).toFixed(2));
      return {
        ...c,
        perCreator: conceptPerCreator,
        qty: conceptQty,
        rate: pricing.rate,
        subtotal: conceptSubtotal,
        analysis: analyzeScript(c.script || '')
      };
    });

    const updateStmt = db.prepare(`
      UPDATE briefs
      SET brand_name = ?, about_brand = ?, filming_instructions = ?,
          qty = ?, rate = ?, total = ?, per_creator = ?,
          selected_creators = ?, concepts = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    updateStmt.run(
      brandName, aboutBrand, filmingInstructions,
      pricing.quantity, pricing.rate, pricing.total, pricing.perCreator,
      JSON.stringify(selectedCreators), JSON.stringify(analyzedConcepts), id
    );

    res.json({
      success: true,
      message: 'Brief updated successfully.',
      briefId: id,
      pricing,
      concepts: analyzedConcepts,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error updating brief:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/briefs/:id
 * Retrieves an existing brief
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const brief = db.prepare('SELECT * FROM briefs WHERE id = ?').get(id);

    if (!brief) {
      return res.status(404).json({ success: false, error: 'Brief not found.' });
    }

    res.json({
      success: true,
      brief: {
        id: brief.id,
        sessionId: brief.session_id,
        brandName: brief.brand_name,
        aboutBrand: brief.about_brand,
        filmingInstructions: brief.filming_instructions,
        qty: brief.qty,
        rate: brief.rate,
        total: brief.total,
        perCreator: brief.per_creator,
        selectedCreators: brief.selected_creators ? JSON.parse(brief.selected_creators) : [],
        concepts: brief.concepts ? JSON.parse(brief.concepts) : [],
        status: brief.status,
        createdAt: brief.created_at,
        updatedAt: brief.updated_at
      }
    });
  } catch (error) {
    console.error('Error fetching brief:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/briefs/:id/review
 * Server-side Validation & Submission for Review
 * Recalculates and verifies prices, quantities, required fields, and creator availability
 */
router.post('/:id/review', (req, res) => {
  try {
    const { id } = req.params;
    const {
      brandName,
      aboutBrand,
      filmingInstructions,
      qty,
      selectedCreators = [],
      concepts = []
    } = req.body;

    const validationErrors = [];

    // Required fields validation
    if (!brandName || !brandName.trim()) validationErrors.push('Brand name is required.');
    if (!aboutBrand || !aboutBrand.trim()) validationErrors.push('About brand / product details are required.');
    if (!filmingInstructions || !filmingInstructions.trim()) validationErrors.push('Filming instructions are required.');

    if (!Array.isArray(concepts) || concepts.length === 0) {
      validationErrors.push('At least one concept script is required.');
    } else {
      concepts.forEach((concept, index) => {
        if (!concept.script || !concept.script.trim()) {
          validationErrors.push(`Concept ${index + 1} script is empty.`);
        }
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validationErrors
      });
    }

    // Verify creator availability
    const creatorStatus = checkCreatorsAvailability(selectedCreators);
    if (!creatorStatus.allAvailable) {
      return res.status(400).json({
        success: false,
        error: 'One or more selected creators are unavailable at this moment.',
        creators: creatorStatus.creators
      });
    }

    // Recalculate price server-side from summed per-creator quantities across concepts
    const creatorCount = (Array.isArray(selectedCreators) && selectedCreators.length > 0) ? selectedCreators.length : 2;
    const hasExplicitPerCreator = Array.isArray(concepts) && concepts.length > 0 && concepts.every(c => c.perCreator !== undefined);
    const summedPerCreator = hasExplicitPerCreator
      ? concepts.reduce((sum, c) => sum + Math.max(1, parseInt(c.perCreator, 10) || 1), 0)
      : 0;
    const effectiveQty = (qty && (!hasExplicitPerCreator || Number(qty) !== summedPerCreator * creatorCount))
      ? parseInt(qty, 10)
      : (summedPerCreator > 0 ? (summedPerCreator * creatorCount) : (qty || 6));
    const pricing = calculatePricing(effectiveQty, creatorCount, req.body.format);

    // Calculate script timings & per-concept video count and subtotal
    const analyzedConcepts = concepts.map(c => {
      const conceptPerCreator = c.perCreator !== undefined
        ? Math.max(1, parseInt(c.perCreator, 10) || 1)
        : Math.max(1, Math.round(effectiveQty / creatorCount / Math.max(1, concepts.length)));
      const conceptQty = conceptPerCreator * creatorCount;
      const conceptSubtotal = parseFloat((conceptQty * pricing.rate).toFixed(2));
      return {
        ...c,
        perCreator: conceptPerCreator,
        qty: conceptQty,
        rate: pricing.rate,
        subtotal: conceptSubtotal,
        analysis: analyzeScript(c.script)
      };
    });

    // Upsert brief record so it is always saved in the database
    const existing = db.prepare('SELECT id FROM briefs WHERE id = ?').get(id);
    if (existing) {
      const updateStmt = db.prepare(`
        UPDATE briefs
        SET brand_name = ?, about_brand = ?, filming_instructions = ?,
            qty = ?, rate = ?, total = ?, per_creator = ?,
            selected_creators = ?, concepts = ?, status = 'reviewed',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      updateStmt.run(
        brandName.trim(), aboutBrand.trim(), filmingInstructions.trim(),
        pricing.quantity, pricing.rate, pricing.total, pricing.perCreator,
        JSON.stringify(selectedCreators), JSON.stringify(analyzedConcepts), id
      );
    } else {
      const insertStmt = db.prepare(`
        INSERT INTO briefs (
          id, session_id, brand_name, about_brand, filming_instructions,
          qty, rate, total, per_creator, selected_creators, concepts, status
        ) VALUES (?, 'guest_session', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reviewed')
      `);

      insertStmt.run(
        id,
        brandName.trim(), aboutBrand.trim(), filmingInstructions.trim(),
        pricing.quantity, pricing.rate, pricing.total, pricing.perCreator,
        JSON.stringify(selectedCreators), JSON.stringify(analyzedConcepts)
      );
    }

    const verifiedPayload = {
      briefId: id,
      brandName: brandName.trim(),
      aboutBrand: aboutBrand.trim(),
      filmingInstructions: filmingInstructions.trim(),
      qty: pricing.quantity,
      rate: pricing.rate.toFixed(2),
      total: pricing.total.toFixed(2),
      perCreator: pricing.perCreator,
      concepts: analyzedConcepts,
      selectedCreators: creatorStatus.creators,
      selectedCreatorsCount: creatorStatus.creators.length,
      discountLabel: pricing.discountLabel,
      verifiedAt: new Date().toISOString()
    };

    res.json({
      success: true,
      message: 'Brief successfully validated and prepared for review.',
      verifiedOrder: verifiedPayload
    });
  } catch (error) {
    console.error('Error during brief review validation:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
