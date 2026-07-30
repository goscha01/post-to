// Automation rules API.
//   GET    /api/automations              — list rules
//   POST   /api/automations              — create rule
//   GET    /api/automations/:id          — fetch one
//   PATCH  /api/automations/:id          — update
//   DELETE /api/automations/:id          — delete
//   POST   /api/automations/:id/run      — test run (bypasses schedule, honors auto_publish)
//   GET    /api/automations/:id/runs     — recent runs (default limit 20)

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/authMiddleware');
const automationsService = require('../services/automationsService');
const automationExecutor = require('../services/automationExecutor');
const logger = require('../utils/logger');

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const rows = await automationsService.listForUser(req.user.userId);
    res.json({ automations: rows });
  } catch (err) {
    logger.error('automations.list_failed', { error: err.message, user_id: req.user.userId });
    res.status(500).json({ error: 'Failed to list automations' });
  }
});

router.get('/:id', [param('id').isUUID()], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const row = await automationsService.getForUser(req.user.userId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ automation: row });
  } catch (err) {
    logger.error('automations.get_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to load automation' });
  }
});

router.post(
  '/',
  [
    body('name').isString().isLength({ min: 1, max: 255 }),
    body('kind').isIn(automationsService.RULE_KINDS),
    body('cadence').isObject(),
    body('targets').isArray({ min: 1 }),
    body('topic_source').optional().isIn(automationsService.TOPIC_SOURCES),
    body('topics').optional().isArray(),
    body('image_source').optional().isIn(automationsService.IMAGE_SOURCES),
    body('fixed_image_url').optional({ nullable: true }).isString().isLength({ max: 2048 }),
    body('image_prompt_template').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    body('business_context').optional().isObject(),
    body('auto_publish').optional().isBoolean(),
    body('active').optional().isBoolean(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errs.array() });
    try {
      const row = await automationsService.createRule(req.user.userId, req.body);
      logger.info('automations.created', { user_id: req.user.userId, id: row.id, kind: row.kind });
      res.status(201).json({ automation: row });
    } catch (err) {
      logger.error('automations.create_failed', { error: err.message, user_id: req.user.userId });
      res.status(err.status || 500).json({ error: err.message || 'Failed to create automation' });
    }
  }
);

router.patch(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().isString().isLength({ min: 1, max: 255 }),
    body('cadence').optional().isObject(),
    body('targets').optional().isArray(),
    body('topic_source').optional().isIn(automationsService.TOPIC_SOURCES),
    body('topics').optional().isArray(),
    body('image_source').optional().isIn(automationsService.IMAGE_SOURCES),
    body('fixed_image_url').optional({ nullable: true }).isString().isLength({ max: 2048 }),
    body('image_prompt_template').optional({ nullable: true }).isString().isLength({ max: 2000 }),
    body('business_context').optional().isObject(),
    body('auto_publish').optional().isBoolean(),
    body('active').optional().isBoolean(),
  ],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ error: 'Invalid input', details: errs.array() });
    try {
      const row = await automationsService.updateRule(req.user.userId, req.params.id, req.body);
      res.json({ automation: row });
    } catch (err) {
      logger.error('automations.update_failed', { error: err.message, id: req.params.id });
      res.status(err.status || 500).json({ error: err.message || 'Failed to update automation' });
    }
  }
);

router.delete('/:id', [param('id').isUUID()], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    await automationsService.deleteRule(req.user.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error('automations.delete_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: 'Failed to delete automation' });
  }
});

// Test-run: fire the rule NOW regardless of schedule. Same code path the
// scheduler uses — honors auto_publish, so a rule with auto_publish=false
// still generates a draft and stops. Great for confirming a new rule is
// wired up before flipping the switch.
router.post('/:id/run', [param('id').isUUID()], async (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ error: 'Invalid id' });
  try {
    const rule = await automationsService.getForUser(req.user.userId, req.params.id);
    if (!rule) return res.status(404).json({ error: 'Not found' });
    const result = await automationExecutor.runRule(rule, { trigger: 'test' });
    res.json({ run: result });
  } catch (err) {
    logger.error('automations.test_run_failed', { error: err.message, id: req.params.id });
    res.status(500).json({ error: err.message || 'Test run failed' });
  }
});

router.get(
  '/:id/runs',
  [param('id').isUUID(), query('limit').optional().isInt({ min: 1, max: 100 }).toInt()],
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ error: 'Invalid input' });
    try {
      const { data, error } = await supabase
        .from('automation_runs')
        .select('*')
        .eq('rule_id', req.params.id)
        .eq('user_id', req.user.userId)
        .order('started_at', { ascending: false })
        .limit(req.query.limit || 20);
      if (error) throw error;
      res.json({ runs: data || [] });
    } catch (err) {
      logger.error('automations.runs_list_failed', { error: err.message, id: req.params.id });
      res.status(500).json({ error: 'Failed to load runs' });
    }
  }
);

module.exports = router;
