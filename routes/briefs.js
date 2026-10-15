const express = require('express');
const router = express.Router();
const db = require('../db');
const { calculatePricing } = require('../services/pricingEngine');
const { analyzeScript } = require('../services/scriptEstimator');
const { checkCreatorsAvailability } = require('../services/creatorService');

// Helper to generate IDs
function generateId(prefix = 'brief') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

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
      selectedCreators = [],
      concepts = []
    } = req.body;

    const briefId = id || generateId('brief');
    const pricing = calculatePricing(qty, selectedCreators.length || 2);

    // Analyze scripts for durations
    const analyzedConcepts = concepts.map(c => ({
      ...c,
      analysis: analyzeScript(c.script || '')
    }));

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
      selectedCreators = [],
      concepts = []
    } = req.body;

    const existing = db.prepare('SELECT id FROM briefs WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Brief not found.' });
    }

    const pricing = calculatePricing(qty, selectedCreators.length || 2);
    const analyzedConcepts = concepts.map(c => ({
      ...c,
      analysis: analyzeScript(c.script || '')
    }));

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

    // Recalculate price server-side
    const pricing = calculatePricing(qty || 6, selectedCreators.length || 2);

    // Calculate script timings
    const analyzedConcepts = concepts.map(c => ({
      ...c,
      analysis: analyzeScript(c.script)
    }));

    // Update brief record
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
