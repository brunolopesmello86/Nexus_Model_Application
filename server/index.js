if (!process.env.VERCEL) require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..')));

// ── Bootstrap migrations — run once at module init so all endpoints are safe ──
// Each endpoint previously had inline ALTERs, but many endpoints reference these
// columns in read paths (SELECT ...). On a cold DB this would crash with
// "column does not exist" before the write-path ALTER could ever run.
let _bootstrapPromise = null;
async function ensureSchema() {
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    const stmts = [
      "ALTER TABLE games ADD COLUMN IF NOT EXISTS board_milestones JSONB NOT NULL DEFAULT '[]'",
      "ALTER TABLE games ADD COLUMN IF NOT EXISTS board_risks JSONB NOT NULL DEFAULT '[]'",
      "ALTER TABLE games ADD COLUMN IF NOT EXISTS loop_sessions JSONB NOT NULL DEFAULT '[]'",
      "ALTER TABLE games ADD COLUMN IF NOT EXISTS board_instances JSONB NOT NULL DEFAULT '{}'",
      "ALTER TABLE games ADD COLUMN IF NOT EXISTS password_hash TEXT",
      "ALTER TABLE games ADD COLUMN IF NOT EXISTS anchors JSONB NOT NULL DEFAULT '[]'",
      "ALTER TABLE games ADD COLUMN IF NOT EXISTS practice_maturity JSONB NOT NULL DEFAULT '{}'",
    ];
    for (const s of stmts) {
      try { await db.query(s); } catch (e) { console.warn('bootstrap ALTER failed (non-fatal):', s, e.message); }
    }
  })();
  return _bootstrapPromise;
}
// Guard: run bootstrap before any /api request
app.use('/api', async (req, res, next) => {
  try { await ensureSchema(); next(); } catch (e) { next(); }
});

// ── Auth: login & access control (signup, verification code, password) ──
app.use('/api/auth', require('./auth/routes'));

// ── Board access enforcement (step 4) — OFF unless NEXUS_ENFORCE_ACCESS=true ──
// When off, every board endpoint behaves exactly as before. When on, boards are
// visible only to their assigned members (Super Admin sees all); non-members get 404.
const access = require('./auth/access');
const authSession = require('./auth/session');
const ENFORCE = () => String(process.env.NEXUS_ENFORCE_ACCESS || '').trim().toLowerCase() === 'true';
async function requireBoard(req, res, gameId) {
  const user = await authSession.getSessionUser(req);
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return null; }
  if (!(await access.canAccessGame(user, gameId))) { res.status(404).json({ error: 'Game not found' }); return null; }
  return user;
}
async function requireSuperAdminReq(req, res) {
  const user = await authSession.getSessionUser(req);
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return null; }
  if (!user.is_super_admin) { res.status(403).json({ error: 'Only an administrator can do this.' }); return null; }
  return user;
}

// ── Health ──
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── Companies ──
app.get('/api/companies', async (req, res) => {
  try {
    if (ENFORCE()) {
      const user = await authSession.getSessionUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      if (!user.is_super_admin) {
        const visible = await access.visibleGameIds(user);
        if (!visible.length) return res.json([]);
        const { rows } = await db.query(`
          SELECT c.*, COUNT(g.id)::int AS game_count
          FROM companies c JOIN games g ON g.company_id = c.id
          WHERE g.id = ANY($1)
          GROUP BY c.id ORDER BY c.name`, [visible]);
        return res.json(rows);
      }
    }
    const { rows } = await db.query(`
      SELECT c.*, COALESCE(g.cnt, 0)::int AS game_count
      FROM companies c
      LEFT JOIN (SELECT company_id, COUNT(*) AS cnt FROM games GROUP BY company_id) g
        ON g.company_id = c.id
      ORDER BY c.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies', async (req, res) => {
  const { name, slug } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
  try {
    if (ENFORCE() && !(await requireSuperAdminReq(req, res))) return;
    const { rows } = await db.query(
      'INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING *',
      [name, slug]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── Games ──
app.get('/api/companies/:companyId/games', async (req, res) => {
  try {
    let visible = null;
    if (ENFORCE()) {
      const user = await authSession.getSessionUser(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      visible = await access.visibleGameIds(user); // null = all (super admin)
      if (Array.isArray(visible) && !visible.length) return res.json([]);
    }
    const params = [req.params.companyId];
    let sql = `SELECT id, company_id, name, description, fitness_score,
             cycle_number, cycle_phase, created_at, updated_at,
             (password_hash IS NOT NULL) AS has_password
      FROM games WHERE company_id = $1`;
    if (Array.isArray(visible)) { params.push(visible); sql += ` AND id = ANY($2)`; }
    sql += ` ORDER BY updated_at DESC`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/:companyId/games', async (req, res) => {
  const { name, description, password } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    if (ENFORCE() && !(await requireSuperAdminReq(req, res))) return;
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS password_hash TEXT');
    const pwHash = password ? hashPassword(password) : null;
    const { rows } = await db.query(
      'INSERT INTO games (company_id, name, description, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.companyId, name, description || null, pwHash]
    );
    const row = rows[0];
    row.has_password = !!pwHash;
    delete row.password_hash;
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/games/:gameId', async (req, res) => {
  try {
    if (ENFORCE() && !(await requireBoard(req, res, req.params.gameId))) return;
    const { rows } = await db.query('SELECT * FROM games WHERE id = $1', [req.params.gameId]);
    if (!rows.length) return res.status(404).json({ error: 'Game not found' });
    const row = rows[0];
    row.has_password = !!row.password_hash;
    delete row.password_hash;
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change / add / remove a game's password
// Body: { currentPassword: string, newPassword: string|null }
// - If game has a password, currentPassword must match
// - newPassword null/empty removes the password
app.patch('/api/games/:gameId/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  try {
    if (ENFORCE() && !(await requireBoard(req, res, req.params.gameId))) return;
    const { rows } = await db.query('SELECT password_hash FROM games WHERE id = $1', [req.params.gameId]);
    if (!rows.length) return res.status(404).json({ error: 'Game not found' });
    const existing = rows[0].password_hash;
    if (existing) {
      if (!currentPassword) return res.status(401).json({ error: 'Current password required' });
      if (hashPassword(currentPassword) !== existing) return res.status(401).json({ error: 'Wrong current password' });
    }
    const newHash = newPassword ? hashPassword(newPassword) : null;
    await db.query('UPDATE games SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, req.params.gameId]);
    res.json({ ok: true, has_password: !!newHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify game password before entering
app.post('/api/games/:gameId/verify', async (req, res) => {
  const { password } = req.body;
  try {
    const { rows } = await db.query('SELECT password_hash FROM games WHERE id = $1', [req.params.gameId]);
    if (!rows.length) return res.status(404).json({ error: 'Game not found' });
    const game = rows[0];
    if (!game.password_hash) return res.json({ ok: true });
    if (!password) return res.status(401).json({ error: 'Password required' });
    if (hashPassword(password) !== game.password_hash) return res.status(401).json({ error: 'Wrong password' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/games/:gameId', async (req, res) => {
  const {
    board_state, agent_assignments, active_drivers,
    cycle_number, cycle_phase, completed_phases,
    log_entries, custom_items, fitness_score,
    connections, board_markers, domain_definitions,
    experiment_results, practice_repetitions, transformation_horizons,
    board_milestones, board_risks, loop_sessions, board_instances, anchors,
    practice_maturity
  } = req.body;
  try {
    if (ENFORCE() && !(await requireBoard(req, res, req.params.gameId))) return;
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS board_milestones JSONB NOT NULL DEFAULT \'[]\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS board_risks JSONB NOT NULL DEFAULT \'[]\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS loop_sessions JSONB NOT NULL DEFAULT \'[]\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS board_instances JSONB NOT NULL DEFAULT \'{}\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS anchors JSONB NOT NULL DEFAULT \'[]\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS practice_maturity JSONB NOT NULL DEFAULT \'{}\'');
    const { rows } = await db.query(`
      UPDATE games SET
        board_state = $1, agent_assignments = $2, active_drivers = $3,
        cycle_number = $4, cycle_phase = $5, completed_phases = $6,
        log_entries = $7, custom_items = $8, fitness_score = $9,
        connections = $10, board_markers = $11, domain_definitions = $12,
        experiment_results = $13, practice_repetitions = $14,
        transformation_horizons = $15, board_milestones = $16, board_risks = $17,
        loop_sessions = $18, board_instances = $19, anchors = $20,
        practice_maturity = $21, updated_at = NOW()
      WHERE id = $22
      RETURNING id, updated_at
    `, [
      JSON.stringify(board_state), JSON.stringify(agent_assignments),
      JSON.stringify(active_drivers), cycle_number, cycle_phase,
      JSON.stringify(completed_phases), JSON.stringify(log_entries),
      JSON.stringify(custom_items), fitness_score || 0,
      JSON.stringify(connections || []), JSON.stringify(board_markers || []),
      JSON.stringify(domain_definitions || []),
      JSON.stringify(experiment_results || {}), JSON.stringify(practice_repetitions || {}),
      JSON.stringify(transformation_horizons || {}),
      JSON.stringify(board_milestones || []), JSON.stringify(board_risks || []),
      JSON.stringify(loop_sessions || []),
      JSON.stringify(board_instances || {}),
      JSON.stringify(anchors || []),
      JSON.stringify(practice_maturity || {}),
      req.params.gameId
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Game not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/games/:gameId', async (req, res) => {
  try {
    if (ENFORCE()) {
      const u = await requireBoard(req, res, req.params.gameId);
      if (!u) return;
      if (!u.is_super_admin) return res.status(403).json({ error: 'Only an administrator can delete a board.' });
    }
    // Check password if game has one
    const { rows } = await db.query('SELECT password_hash FROM games WHERE id = $1', [req.params.gameId]);
    if (!rows.length) return res.status(404).json({ error: 'Game not found' });
    if (rows[0].password_hash) {
      // Prefer JSON body (UTF-8 safe); fall back to header for older clients
      const pw = (req.body && req.body.password) || req.headers['x-game-password'] || '';
      if (hashPassword(pw) !== rows[0].password_hash) return res.status(401).json({ error: 'Wrong password' });
    }
    await db.query('DELETE FROM games WHERE id = $1', [req.params.gameId]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a game. Body: { name, password }. Password required only if the game has one.
app.patch('/api/games/:gameId/rename', async (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    if (ENFORCE() && !(await requireBoard(req, res, req.params.gameId))) return;
    const { rows } = await db.query('SELECT password_hash FROM games WHERE id = $1', [req.params.gameId]);
    if (!rows.length) return res.status(404).json({ error: 'Game not found' });
    if (rows[0].password_hash) {
      if (hashPassword(password || '') !== rows[0].password_hash) return res.status(401).json({ error: 'Wrong password' });
    }
    const upd = await db.query('UPDATE games SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name', [name.trim(), req.params.gameId]);
    res.json(upd.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Capabilities Library — NTT DATA Nexus Transformation (v2 · 58 caps · 348 practices) ──
// Source: NTT-DATA-Nexus-Capabilities-Map.xlsx + NTT-DATA-Nexus-Practices.pptx
// Domains: Strategy & Portfolio · Product & Delivery · Technology & Architecture · People, Culture & Governance · Operations
const SEED_CAPABILITIES = [

  // ═══════════════════════════════════════════
  // STRATEGY & PORTFOLIO — 11 capabilities
  // ═══════════════════════════════════════════
  { name: 'Portfolio Governance', domain: 'Strategy & Portfolio', source: 'Nexus',
    description: 'Structures and rhythms for portfolio-level decisions, prioritisation and oversight.',
    practices: [
      { name: 'Portfolio Review Cadence', level: 'F', description: 'Establish a regular rhythm for reviewing the portfolio to maintain alignment and visibility.' },
      { name: 'Portfolio Kanban Board', level: 'F', description: 'Visualise all portfolio items and their status on a shared Kanban board.' },
      { name: 'Investment Horizon Classification', level: 'D', description: 'Classify investments by time horizon (run/grow/transform) to balance the portfolio.' },
      { name: 'Portfolio Health Dashboard', level: 'D', description: 'Create a real-time view of portfolio health, progress and risk indicators.' },
      { name: 'Lightweight Stage Gates', level: 'A', description: 'Apply minimal, outcome-focused gates to ensure initiatives pass value thresholds before proceeding.' },
      { name: 'Continuous Portfolio Rebalancing', level: 'A', description: 'Continuously adjust the portfolio mix as market conditions and learnings evolve.' },
    ]
  },
  { name: 'Investment Logic', domain: 'Strategy & Portfolio', source: 'Nexus',
    description: 'How investment cases are framed, evaluated and updated based on learning.',
    practices: [
      { name: 'Lean Business Case Template', level: 'F', description: 'Use a lightweight one-pager to frame the problem, hypothesis and expected outcome before committing investment.' },
      { name: 'Hypothesis-Driven Investment', level: 'F', description: 'Treat each investment as a hypothesis to be tested, with clear success criteria defined upfront.' },
      { name: 'Outcome-Based Investment Thesis', level: 'D', description: 'Frame investments around desired outcomes rather than outputs or deliverables.' },
      { name: 'Rolling Investment Reviews', level: 'D', description: 'Review and update investment cases on a rolling basis as new information becomes available.' },
      { name: 'Kill Criteria Definition', level: 'A', description: 'Define explicit conditions under which an investment will be stopped to avoid sunk-cost traps.' },
      { name: 'Portfolio Learning Library', level: 'A', description: 'Capture and share lessons from past investments to improve future decision-making.' },
    ]
  },
  { name: 'Strategic Rhythm', domain: 'Strategy & Portfolio', source: 'Nexus',
    description: 'Regular cadences for reviewing strategy, allocating resources and adjusting direction.',
    practices: [
      { name: 'Nested Cadence Design', level: 'F', description: 'Design nested planning cadences (weekly, quarterly, annual) that align team and portfolio rhythms.' },
      { name: 'Strategy Communication Calendar', level: 'F', description: 'Schedule regular touchpoints to communicate strategy updates across all levels.' },
      { name: 'Quarterly Planning Cycle', level: 'D', description: 'Run structured quarterly planning events to align priorities and resources to strategy.' },
      { name: 'Rolling 12-Month Plan', level: 'D', description: 'Maintain a rolling 12-month outlook that is updated regularly to reflect current realities.' },
      { name: 'Annual Strategy Retreat', level: 'A', description: 'Facilitate an annual off-site to revisit, challenge and reset the strategic direction.' },
      { name: 'Strategy Feedback Loop', level: 'A', description: 'Create systematic mechanisms to feed execution learnings back into strategic planning.' },
    ]
  },
  { name: 'Course Correction', domain: 'Strategy & Portfolio', source: 'Nexus',
    description: 'Ability to detect misalignment early and change course without sunk-cost bias.',
    practices: [
      { name: 'Early Warning Indicators', level: 'F', description: 'Define leading indicators that signal when an initiative is drifting off track before it becomes critical.' },
      { name: 'Pivot vs Persevere Framework', level: 'F', description: 'Use a structured framework to decide when to change direction versus stay the course.' },
      { name: 'Pre-Mortem Analysis', level: 'D', description: 'Imagine a future failure and work backwards to identify and mitigate risks in advance.' },
      { name: 'Escalation Thresholds', level: 'D', description: 'Define clear thresholds that trigger escalation to senior decision-makers.' },
      { name: 'Course Correction Retrospective', level: 'A', description: 'Run dedicated retrospectives when a pivot occurs to extract systemic learning.' },
      { name: 'Anti-Sunk-Cost Governance', level: 'A', description: 'Build governance guardrails that make it safe and expected to stop unviable investments.' },
    ]
  },
  { name: 'Prioritisation', domain: 'Strategy & Portfolio', source: 'Nexus',
    description: 'Mechanisms for ranking and sequencing initiatives across the portfolio.',
    practices: [
      { name: 'Weighted Scoring Model', level: 'F', description: 'Apply a consistent scoring model with weighted criteria to compare initiatives objectively.' },
      { name: 'Explicit Prioritisation Criteria', level: 'F', description: 'Define and publish the criteria used to prioritise work so decisions are transparent.' },
      { name: 'Cross-Domain Prioritisation Forum', level: 'D', description: 'Run a regular cross-functional forum to resolve competing priorities across domains.' },
      { name: 'Deprioritisation Log', level: 'D', description: 'Maintain a visible log of what has been deprioritised and why, to manage expectations.' },
      { name: 'Dynamic Reprioritisation', level: 'A', description: 'Enable rapid reprioritisation in response to market signals without lengthy approval chains.' },
      { name: 'Opportunity Cost Transparency', level: 'A', description: 'Make the opportunity cost of prioritisation decisions explicit to improve strategic trade-offs.' },
    ]
  },
  { name: 'Resource Allocation', domain: 'Strategy & Portfolio', source: 'Nexus',
    description: 'How people, funding and capacity are assigned and rebalanced dynamically.',
    practices: [
      { name: 'Skill Inventory Mapping', level: 'F', description: 'Map the skills and capacity available across teams to inform allocation decisions.' },
      { name: 'Capacity Buffer Policy', level: 'F', description: 'Reserve a portion of team capacity for unplanned work and strategic exploration.' },
      { name: 'Dynamic Resource Allocation', level: 'D', description: 'Enable resources to flow to highest-value work through lightweight reallocation mechanisms.' },
      { name: 'Transparent Allocation Model', level: 'D', description: 'Make resource allocation decisions visible to all stakeholders to build trust and reduce politics.' },
      { name: 'Cross-Domain Mobility Programme', level: 'A', description: 'Create structured opportunities for people to move across domains to build resilience and learning.' },
      { name: 'Value-per-Person Metric', level: 'A', description: 'Track the value delivered per person to optimise team sizing and composition.' },
    ]
  },
  { name: 'Strategic Clarity', domain: 'Strategy & Portfolio', source: 'Nexus',
    description: 'Degree to which teams understand the "why" behind the strategy.',
    practices: [
      { name: 'Strategy on a Page', level: 'F', description: 'Distil the strategy into a single visual that teams can reference and share easily.' },
      { name: 'Strategy Translation Sessions', level: 'F', description: 'Run sessions where leaders translate corporate strategy into team-level implications.' },
      { name: 'Strategic Narrative', level: 'D', description: 'Craft a compelling story about where the organisation is going and why it matters.' },
      { name: 'Strategy Pulse Surveys', level: 'D', description: 'Regularly survey teams to measure how well the strategy is understood and believed.' },
      { name: 'Strategy AMA Sessions', level: 'A', description: 'Run open "Ask Me Anything" sessions with senior leaders to deepen strategic understanding.' },
      { name: 'Living Strategy Document', level: 'A', description: 'Maintain a dynamic strategy document that is updated as learning evolves — not just annually.' },
    ]
  },
  { name: 'OKR & Goals Mgmt', domain: 'Strategy & Portfolio', source: 'Nexus',
    description: 'Frameworks for setting, aligning and tracking objectives at every level.',
    practices: [
      { name: 'OKR Three-Level Cascade', level: 'F', description: 'Cascade OKRs from company to team level ensuring each layer connects to the one above.' },
      { name: 'Bi-Weekly OKR Check-ins', level: 'F', description: 'Run short bi-weekly check-ins to assess OKR progress and surface blockers early.' },
      { name: 'OKR Scoring and Reflection', level: 'D', description: 'Score OKRs at the end of each cycle and hold structured reflection on what was learned.' },
      { name: 'Aspirational vs Committed OKRs', level: 'D', description: 'Distinguish between stretch aspirational OKRs and committed operational ones to calibrate ambition.' },
      { name: 'OKR Alignment Health Check', level: 'A', description: 'Regularly audit whether OKRs are genuinely aligned or just locally optimised.' },
      { name: 'OKR Outcome Dashboard', level: 'A', description: 'Build a real-time dashboard showing OKR status and outcome progress across the organisation.' },
    ]
  },
  { name: 'Customer Feedback', domain: 'Strategy & Portfolio', source: 'Accelerate',
    description: 'Mechanisms to actively seek, gather and act on customer input to steer portfolio direction.',
    practices: [
      { name: 'Continuous Customer Interview Programme', level: 'F', description: 'Run ongoing customer interviews to continuously surface needs, pains and opportunities.' },
      { name: 'NPS / CSAT Measurement', level: 'F', description: 'Measure Net Promoter Score and customer satisfaction regularly to track relationship health.' },
      { name: 'Feedback Synthesis Process', level: 'D', description: 'Create a repeatable process to synthesise qualitative feedback into actionable insights.' },
      { name: 'Customer Feedback Dashboard', level: 'D', description: 'Build a shared dashboard that makes customer feedback visible to all product and delivery teams.' },
      { name: 'Time-to-Insight SLA', level: 'A', description: 'Define a service-level agreement for how quickly customer feedback is converted into decisions.' },
      { name: 'Customer Advisory Board', level: 'A', description: 'Establish a formal advisory board of key customers to co-shape product and portfolio direction.' },
    ]
  },
  { name: 'Small Batch Work', domain: 'Strategy & Portfolio', source: 'Accelerate',
    description: 'Decomposing work into small units of value to reduce risk and accelerate learning.',
    practices: [
      { name: 'Maximum Batch Size Policy', level: 'F', description: 'Define and enforce a maximum batch size for work items to keep delivery cycles short.' },
      { name: 'Story Splitting Workshops', level: 'F', description: 'Run workshops to teach teams how to split large stories into thin vertical slices.' },
      { name: 'MVP/MVE Discipline', level: 'D', description: 'Apply rigorous MVP and MVE thinking to resist scope creep and validate assumptions cheaply.' },
      { name: 'Batch Size Metrics', level: 'D', description: 'Track average batch size over time to ensure the organisation is trending towards smaller increments.' },
      { name: 'Portfolio WIP Limits', level: 'A', description: 'Apply WIP limits at the portfolio level to prevent overloading the system with too many initiatives.' },
      { name: 'Value Increment Planning', level: 'A', description: 'Plan delivery in explicit value increments, each of which delivers standalone customer value.' },
    ]
  },
  { name: 'Value Stream Visibility', domain: 'Strategy & Portfolio', source: 'Accelerate',
    description: 'End-to-end visibility of how value flows from idea to customer outcome.',
    practices: [
      { name: 'Value Stream Mapping Workshop', level: 'F', description: 'Facilitate a cross-functional workshop to map the current state of a key value stream.' },
      { name: 'Lead Time Measurement', level: 'F', description: 'Measure end-to-end lead time from idea to delivery to establish a flow baseline.' },
      { name: 'Flow Efficiency Calculation', level: 'D', description: 'Calculate the ratio of active work time to total lead time to identify where value is being delayed.' },
      { name: 'Value Stream Dashboard', level: 'D', description: 'Build a live dashboard showing flow metrics across the value stream.' },
      { name: 'Quarterly VSM Refresh', level: 'A', description: 'Refresh the value stream map quarterly to track improvement and identify emerging bottlenecks.' },
      { name: 'Cross-Team Flow Reviews', level: 'A', description: 'Run regular cross-team reviews focused on end-to-end flow rather than local team metrics.' },
    ]
  },

  // ═══════════════════════════════════════════
  // PRODUCT & DELIVERY — 14 capabilities
  // ═══════════════════════════════════════════
  { name: 'Flow Optimisation', domain: 'Product & Delivery', source: 'Nexus',
    description: 'Reducing waste and bottlenecks to maximise throughput of value.',
    practices: [
      { name: 'Flow Visualisation Board', level: 'F', description: 'Create a board that makes all work, queues and blockers visible across the delivery system.' },
      { name: 'WIP Limits per Stage', level: 'F', description: 'Set explicit limits on work-in-progress at each workflow stage to prevent overloading.' },
      { name: 'Bottleneck Identification', level: 'D', description: 'Use flow metrics to identify the constraint in the system and focus improvement effort there.' },
      { name: 'Flow Metrics Dashboard', level: 'D', description: 'Track throughput, cycle time and WIP on a shared dashboard to make flow visible to all.' },
      { name: 'Waste Elimination Sprints', level: 'A', description: 'Run dedicated improvement sprints focused on identifying and eliminating specific waste types.' },
      { name: 'Automated Flow Analytics', level: 'A', description: 'Automate collection and analysis of flow data to surface patterns and opportunities at scale.' },
    ]
  },
  { name: 'Feedback Loops', domain: 'Product & Delivery', source: 'Nexus',
    description: 'Fast, reliable mechanisms to learn from users, markets and operations.',
    practices: [
      { name: 'Production Monitoring Alerts', level: 'F', description: 'Set up alerting on production systems so the team knows immediately when something goes wrong.' },
      { name: 'Weekly Usability Testing', level: 'F', description: 'Conduct at least one usability test session per week with real users to generate continuous feedback.' },
      { name: 'Feature Flag Rollouts', level: 'D', description: 'Use feature flags to release to a subset of users and gather targeted feedback before full rollout.' },
      { name: 'Build–Measure–Learn Cycle', level: 'D', description: 'Implement the full Build–Measure–Learn loop with explicit hypotheses and outcome tracking.' },
      { name: 'Internal Alpha Programme', level: 'A', description: 'Run a structured internal alpha with real users before external release to catch issues early.' },
      { name: 'Automated Anomaly Detection', level: 'A', description: 'Use machine learning or statistical methods to automatically detect anomalies in user and system behaviour.' },
    ]
  },
  { name: 'Cycle Time Mgmt', domain: 'Product & Delivery', source: 'Nexus',
    description: 'Measuring and shortening end-to-end delivery time across the value stream.',
    practices: [
      { name: 'Cycle Time Baseline', level: 'F', description: 'Measure and record the current average cycle time to establish a starting point for improvement.' },
      { name: 'Cycle Time Targets', level: 'F', description: 'Set explicit targets for cycle time reduction and make progress visible to the team.' },
      { name: 'Cumulative Flow Diagrams', level: 'D', description: 'Use cumulative flow diagrams to visualise where work is accumulating and flow is breaking down.' },
      { name: 'Handoff Reduction', level: 'D', description: 'Identify and reduce the number of handoffs in the delivery process to cut waiting time.' },
      { name: 'Cycle Time Retrospectives', level: 'A', description: 'Run retrospectives specifically focused on cycle time data to drive targeted improvements.' },
      { name: 'Per-Story Cycle Time SLAs', level: 'A', description: 'Define service-level agreements for cycle time by story type and track compliance over time.' },
    ]
  },
  { name: 'Team Topology', domain: 'Product & Delivery', source: 'Nexus',
    description: 'Designing team structures and interactions to enable fast, safe delivery.',
    practices: [
      { name: 'Team Type Classification', level: 'F', description: 'Classify all teams into stream-aligned, platform, enabling or complicated-subsystem types.' },
      { name: 'Cognitive Load Assessment', level: 'F', description: 'Assess the cognitive load on each team and adjust scope or support to keep it manageable.' },
      { name: 'Interaction Mode Definition', level: 'D', description: 'Define whether teams interact via collaboration, X-as-a-service or facilitation modes.' },
      { name: "Conway's Law Audit", level: 'D', description: "Audit whether the software architecture mirrors the team structure — and change one if they don't align." },
      { name: 'Team Topology Roadmap', level: 'A', description: 'Create a roadmap for evolving team topology as the product and organisation scale.' },
      { name: 'Thinnest Viable Platform', level: 'A', description: 'Design the internal platform to be as thin as possible while still reducing cognitive load for teams.' },
    ]
  },
  { name: 'Experimentation', domain: 'Product & Delivery', source: 'Nexus',
    description: 'Culture and tooling to run safe-to-fail experiments at pace.',
    practices: [
      { name: 'Experiment Hypothesis Template', level: 'F', description: 'Standardise hypothesis writing using a template: "We believe X will result in Y, evidenced by Z."' },
      { name: 'Safe-to-Fail Sandbox', level: 'F', description: 'Create a dedicated environment where teams can run experiments without risk to production.' },
      { name: 'Experiment Velocity Tracking', level: 'D', description: 'Track the number of experiments run per period as a leading indicator of learning rate.' },
      { name: 'Experiment Retrospectives', level: 'D', description: 'Run retrospectives after each experiment cycle to extract learning and improve the process.' },
      { name: 'A/B Testing Infrastructure', level: 'A', description: 'Build infrastructure that enables controlled A/B tests in production with statistical rigour.' },
      { name: 'Celebrating Failed Experiments', level: 'A', description: 'Formally celebrate well-designed experiments that fail to reinforce a learning culture.' },
    ]
  },
  { name: 'Continuous Delivery', domain: 'Product & Delivery', source: 'Nexus',
    description: 'Automated pipelines enabling frequent, low-risk releases.',
    practices: [
      { name: 'Deployment Pipeline Baseline', level: 'F', description: 'Establish a basic automated pipeline that builds, tests and deploys code on every commit.' },
      { name: 'Sprint-Cadence Releases', level: 'F', description: 'Release to production at the end of every sprint as a stepping stone to continuous deployment.' },
      { name: 'Blue/Green Deployments', level: 'D', description: 'Use blue/green deployment patterns to enable zero-downtime releases and instant rollback.' },
      { name: 'Deployment Frequency Metric', level: 'D', description: 'Track and publish how often the team deploys to production as a key flow metric.' },
      { name: 'Change Failure Rate Reduction', level: 'A', description: 'Measure and systematically reduce the percentage of changes that cause production incidents.' },
      { name: 'Chaos Engineering Practice', level: 'A', description: 'Intentionally inject failures into the system to discover weaknesses before they cause incidents.' },
    ]
  },
  { name: 'Quality Practices', domain: 'Product & Delivery', source: 'Nexus',
    description: 'Test strategies and standards that build quality in rather than inspecting it out.',
    practices: [
      { name: 'Test Pyramid Implementation', level: 'F', description: 'Structure tests as a pyramid with many unit tests, fewer integration tests and fewer E2E tests.' },
      { name: 'Definition of Done with Quality', level: 'F', description: 'Include explicit quality criteria (tests passing, coverage thresholds) in the Definition of Done.' },
      { name: 'Code Review Standards', level: 'D', description: 'Define standards for code reviews that focus on quality, security and maintainability.' },
      { name: 'Defect Escape Rate Tracking', level: 'D', description: 'Measure how many defects escape to production and use the data to drive quality improvement.' },
      { name: 'Pair and Mob Programming', level: 'A', description: 'Use pair and mob programming practices to spread knowledge and catch defects at the source.' },
      { name: 'Quality Engineering Culture', level: 'A', description: 'Shift quality ownership to the whole team, making quality engineering a shared discipline not a gate.' },
    ]
  },
  { name: 'Roadmap Mgmt', domain: 'Product & Delivery', source: 'Nexus',
    description: 'Communicating and adapting delivery plans with stakeholders over time.',
    practices: [
      { name: 'Now/Next/Later Format', level: 'F', description: 'Use the Now/Next/Later format to communicate roadmap priorities without false date precision.' },
      { name: 'Monthly Roadmap Reviews', level: 'F', description: 'Review and update the roadmap monthly with stakeholders to maintain alignment.' },
      { name: 'Assumption Mapping', level: 'D', description: 'Map the assumptions behind roadmap items and prioritise those with the highest uncertainty and impact.' },
      { name: 'Dependency Visibility', level: 'D', description: 'Make cross-team and cross-product dependencies visible on the roadmap to enable proactive management.' },
      { name: 'Roadmap Retrospectives', level: 'A', description: 'Run retrospectives on roadmap accuracy to improve forecasting and reduce planning waste.' },
      { name: 'Outcome-Based Roadmap', level: 'A', description: 'Shift the roadmap from features to outcomes, showing what business results will be achieved and when.' },
    ]
  },
  { name: 'Version Control', domain: 'Product & Delivery', source: 'Accelerate',
    description: 'All production artefacts — code, config, scripts, docs — version-controlled.',
    practices: [
      { name: 'Everything-in-VCS Policy', level: 'F', description: 'Establish a policy that all production artefacts must be stored in version control.' },
      { name: 'Branch Protection Rules', level: 'F', description: 'Configure branch protection to prevent direct commits to main and enforce review gates.' },
      { name: 'Config Separation from Code', level: 'D', description: 'Separate application configuration from code so environments differ only in config, not code.' },
      { name: 'Infrastructure as Code', level: 'D', description: 'Manage all infrastructure through version-controlled code to enable reproducibility and auditability.' },
      { name: 'Secrets Management', level: 'A', description: 'Use a secrets management solution to store credentials securely and outside of version control.' },
      { name: 'Repository Standards', level: 'A', description: 'Define and enforce standards for repository structure, naming, and documentation across all teams.' },
    ]
  },
  { name: 'Deploy Automation', domain: 'Product & Delivery', source: 'Accelerate',
    description: 'Deployment process is fully automated; no manual steps to production.',
    practices: [
      { name: 'Deployment Pipeline Inventory', level: 'F', description: 'Inventory all existing deployment processes to identify gaps and manual steps.' },
      { name: 'Self-Service Deployment', level: 'F', description: 'Enable teams to trigger deployments themselves without depending on a separate ops team.' },
      { name: 'Environment Parity', level: 'D', description: 'Ensure development, staging and production environments are as identical as possible.' },
      { name: 'Deployment Duration SLO', level: 'D', description: 'Set a service-level objective for deployment pipeline duration and track compliance.' },
      { name: 'Automated Rollback', level: 'A', description: 'Implement automated rollback that triggers when post-deployment health checks fail.' },
      { name: 'Progressive Delivery', level: 'A', description: 'Use canary releases and progressive rollouts to reduce the blast radius of new deployments.' },
    ]
  },
  { name: 'Continuous Integration', domain: 'Product & Delivery', source: 'Accelerate',
    description: 'Developers integrate code to trunk at least daily, validated by automated build.',
    practices: [
      { name: 'Daily Commit Policy', level: 'F', description: 'Establish a team norm that every developer commits to the shared trunk at least once per day.' },
      { name: 'Sub-10-Minute Build', level: 'F', description: 'Optimise the CI build to complete in under 10 minutes to keep feedback loops tight.' },
      { name: 'Red Build Policy', level: 'D', description: 'Establish and enforce a policy that a failing build is the top team priority until resolved.' },
      { name: 'Build Success Rate Tracking', level: 'D', description: 'Track build success rate over time and use it as a leading indicator of integration health.' },
      { name: 'CI Dashboard Visibility', level: 'A', description: 'Make the CI dashboard visible on a shared screen so build status is always visible to the team.' },
      { name: 'Merge Queue Management', level: 'A', description: 'Use a merge queue to serialise and validate all changes before they land on the main branch.' },
    ]
  },
  { name: 'Trunk-Based Dev.', domain: 'Product & Delivery', source: 'Accelerate',
    description: 'All developers work on a single trunk branch with very short-lived feature branches.',
    practices: [
      { name: 'Branch Lifetime Policy', level: 'F', description: 'Define and enforce a maximum branch lifetime (e.g. 1 day) to prevent long-lived divergence.' },
      { name: 'Feature Flag Adoption', level: 'F', description: 'Adopt feature flags to decouple deployment from release, enabling trunk-based development safely.' },
      { name: 'Automatic Branch Cleanup', level: 'D', description: 'Automate deletion of merged or stale branches to keep the repository clean.' },
      { name: 'Merge Conflict Retrospective', level: 'D', description: 'Track and retrospect on merge conflicts as a signal that branches are living too long.' },
      { name: 'Trunk Health Dashboard', level: 'A', description: 'Monitor trunk health in real time, including build status, coverage and deployment readiness.' },
      { name: 'Continuous Code Review', level: 'A', description: 'Shift from batch code reviews to continuous small reviews that are completed within hours.' },
    ]
  },
  { name: 'Test Automation', domain: 'Product & Delivery', source: 'Accelerate',
    description: 'Automated test suite covers unit, integration and acceptance tests with fast feedback.',
    practices: [
      { name: 'Test Coverage Baseline', level: 'F', description: 'Measure and publish current test coverage to establish a baseline for improvement.' },
      { name: 'Test in CI Pipeline', level: 'F', description: 'Ensure all tests run automatically in the CI pipeline on every commit.' },
      { name: 'Flaky Test Management', level: 'D', description: 'Track and systematically eliminate flaky tests that undermine trust in the test suite.' },
      { name: 'Contract Testing', level: 'D', description: 'Use consumer-driven contract tests to validate integrations between services independently.' },
      { name: 'Acceptance Test Automation', level: 'A', description: 'Automate acceptance tests that validate business behaviour, not just technical correctness.' },
      { name: 'Test Analytics Dashboard', level: 'A', description: 'Build a dashboard showing test health trends: coverage, flakiness, failure rates over time.' },
    ]
  },
  { name: 'Test Data Management', domain: 'Product & Delivery', source: 'Accelerate',
    description: 'Test data available on demand; production-like datasets handled safely in test environments.',
    practices: [
      { name: 'Synthetic Data Generators', level: 'F', description: 'Build generators that create realistic synthetic test data on demand without using production data.' },
      { name: 'Data Anonymisation Pipeline', level: 'F', description: 'Create an automated pipeline to anonymise production data for use in test environments.' },
      { name: 'Test Data as Code', level: 'D', description: 'Manage test data definitions in version control alongside application code.' },
      { name: 'On-Demand Test Data API', level: 'D', description: 'Expose a self-service API that teams can call to provision test data instantly.' },
      { name: 'Test Data Quality Reviews', level: 'A', description: 'Regularly review the quality of test data to ensure it remains representative of production.' },
      { name: 'Data Subsetting Strategy', level: 'A', description: 'Create representative subsets of production data that are small enough to use in CI pipelines.' },
    ]
  },

  // ═══════════════════════════════════════════
  // TECHNOLOGY & ARCHITECTURE — 9 capabilities
  // ═══════════════════════════════════════════
  { name: 'Architecture Decisions', domain: 'Technology & Architecture', source: 'Nexus',
    description: 'Making and recording architectural choices that balance speed, cost and risk.',
    practices: [
      { name: 'Architecture Decision Records', level: 'F', description: 'Use ADRs to document significant architectural decisions with context, options and rationale.' },
      { name: 'Lightweight RFC Process', level: 'F', description: 'Implement a simple Request-for-Comments process for proposing and reviewing architectural changes.' },
      { name: 'ADR Review Cadence', level: 'D', description: 'Establish a regular cadence to review existing ADRs and update those that are no longer valid.' },
      { name: 'Architecture Guild', level: 'D', description: 'Form a cross-team architecture guild to align standards and share decisions across the organisation.' },
      { name: 'Fitness Function Automation', level: 'A', description: 'Automate architectural fitness functions that continuously validate the architecture against defined principles.' },
      { name: 'Future-State Architecture Workshops', level: 'A', description: 'Run facilitated workshops to design and validate target architecture states collaboratively.' },
    ]
  },
  { name: 'Tech Standards', domain: 'Technology & Architecture', source: 'Nexus',
    description: 'Shared conventions that reduce cognitive load and enable safe autonomy.',
    practices: [
      { name: 'Tech Radar Publication', level: 'F', description: 'Publish a technology radar that classifies tools and languages into adopt, trial, assess and hold.' },
      { name: 'Standards Working Group', level: 'F', description: 'Form a working group responsible for defining, maintaining and communicating technical standards.' },
      { name: 'Linting and Static Analysis', level: 'D', description: 'Enforce coding standards automatically through linting and static analysis in the CI pipeline.' },
      { name: 'Standards Adoption Metrics', level: 'D', description: 'Track adoption rates of key standards across teams to identify gaps and drive improvement.' },
      { name: 'Deprecation Process', level: 'A', description: 'Define a structured process for deprecating technologies with clear timelines and migration paths.' },
      { name: 'Inner Source Programme', level: 'A', description: 'Apply open-source practices internally to enable teams to contribute to shared codebases.' },
    ]
  },
  { name: 'Platform Engineering', domain: 'Technology & Architecture', source: 'Nexus',
    description: 'Internal platforms that amplify team productivity and reduce repetition.',
    practices: [
      { name: 'Developer Experience Survey', level: 'F', description: 'Survey developers regularly to understand pain points and prioritise platform improvements.' },
      { name: 'Platform as a Product', level: 'F', description: 'Treat the internal platform as a product with a roadmap, SLAs and user-centric design.' },
      { name: 'Self-Service Capabilities', level: 'D', description: 'Build self-service capabilities that enable teams to provision environments and tools without tickets.' },
      { name: 'Platform Adoption Metrics', level: 'D', description: 'Track which teams are using the platform and measure the value it delivers to adopters.' },
      { name: 'Platform Roadmap Communication', level: 'A', description: 'Publish and regularly update the platform roadmap so teams can plan around upcoming capabilities.' },
      { name: 'Paved Road and Off-Road', level: 'A', description: 'Offer a well-supported "paved road" while allowing teams to go "off-road" with documented trade-offs.' },
    ]
  },
  { name: 'Technical Debt Mgmt', domain: 'Technology & Architecture', source: 'Nexus',
    description: 'Intentional strategies for managing, paying down and preventing tech debt.',
    practices: [
      { name: 'Tech Debt Register', level: 'F', description: 'Maintain a shared register of known technical debt items with estimated cost and impact.' },
      { name: 'Debt Allocation Policy', level: 'F', description: 'Reserve a percentage of each sprint for paying down technical debt as a first-class activity.' },
      { name: 'Strangler Fig Pattern', level: 'D', description: 'Use the Strangler Fig pattern to incrementally replace legacy components without a big-bang rewrite.' },
      { name: 'Debt Quadrant Classification', level: 'D', description: 'Classify debt by reckless/prudent × deliberate/inadvertent to prioritise the right items to address.' },
      { name: 'Debt Trend Tracking', level: 'A', description: 'Track the trajectory of technical debt over time to ensure it is reducing rather than accumulating.' },
      { name: 'Boy Scout Rule Enforcement', level: 'A', description: 'Enforce the Boy Scout Rule: always leave the code a little cleaner than you found it.' },
    ]
  },
  { name: 'Tooling Strategy', domain: 'Technology & Architecture', source: 'Nexus',
    description: 'Selecting and standardising tools that support the transformation goals.',
    practices: [
      { name: 'Tool Inventory', level: 'F', description: 'Create a comprehensive inventory of all tools in use across the organisation.' },
      { name: 'Bake-Off Process', level: 'F', description: 'Run structured bake-offs to evaluate competing tools against defined criteria before adopting.' },
      { name: 'Tool Consolidation Reviews', level: 'D', description: 'Review the tool landscape regularly to identify redundant tools and consolidation opportunities.' },
      { name: 'Total Cost of Ownership', level: 'D', description: 'Calculate the full TCO of tools including licences, training and integration costs.' },
      { name: 'Tool NPS', level: 'A', description: 'Survey teams on their satisfaction with tools using NPS to drive data-informed consolidation.' },
      { name: 'Build vs Buy Framework', level: 'A', description: 'Apply a consistent framework to decide when to build, buy or open-source tooling needs.' },
    ]
  },
  { name: 'Continuous Evolution', domain: 'Technology & Architecture', source: 'Nexus',
    description: 'Keeping the architecture current through deliberate, incremental change.',
    practices: [
      { name: 'Architecture Backlog', level: 'F', description: 'Maintain a dedicated backlog of architecture improvement items, visible alongside product work.' },
      { name: 'Quarterly Architecture Reviews', level: 'F', description: 'Hold quarterly reviews to assess the architecture against current and future needs.' },
      { name: 'Evolutionary Architecture Principles', level: 'D', description: 'Define principles that guide incremental architecture change, such as reversibility and composability.' },
      { name: 'Architecture Health Scorecard', level: 'D', description: 'Score the architecture against health dimensions and track improvement over time.' },
      { name: 'Architecture Debt Tracking', level: 'A', description: 'Track architecture-level debt separately from code debt to manage strategic evolution explicitly.' },
      { name: 'Continuous Architecture Practice', level: 'A', description: 'Embed architecture review into the delivery process so it is ongoing rather than periodic.' },
    ]
  },
  { name: 'Loosely Coupled Arch.', domain: 'Technology & Architecture', source: 'Accelerate',
    description: 'System components independently deployable; changes in one do not require changes in others.',
    practices: [
      { name: 'Bounded Context Mapping', level: 'F', description: 'Use DDD bounded contexts to define clear ownership boundaries between system components.' },
      { name: 'Contract-First API Design', level: 'F', description: 'Design APIs contract-first so consumers and producers can evolve independently.' },
      { name: 'Consumer-Driven Contract Tests', level: 'D', description: 'Implement consumer-driven contract tests to validate API compatibility without end-to-end tests.' },
      { name: 'Async Messaging Adoption', level: 'D', description: 'Adopt asynchronous messaging patterns to further decouple services and improve resilience.' },
      { name: 'Deployment Independence Metric', level: 'A', description: 'Measure the percentage of deployments that require no coordination with other teams.' },
      { name: 'Anti-Corruption Layer Pattern', level: 'A', description: 'Implement anti-corruption layers to shield clean domain models from legacy system influence.' },
    ]
  },
  { name: 'Empowered Team Arch.', domain: 'Technology & Architecture', source: 'Accelerate',
    description: 'Teams choose their own tools and technologies without requiring approval from external bodies.',
    practices: [
      { name: 'Technology Guardrails', level: 'F', description: 'Define guardrails (security, compliance, interoperability) within which teams have full autonomy.' },
      { name: 'Lightweight RFC for Exceptions', level: 'F', description: 'Create a lightweight process for teams to propose exceptions to guardrails transparently.' },
      { name: 'Architecture Decision Sharing', level: 'D', description: 'Create a shared space for teams to publish their architecture decisions and learn from each other.' },
      { name: 'Tech Choice Retrospectives', level: 'D', description: 'Retrospect on technology choices made by teams to share learnings across the organisation.' },
      { name: 'Architecture Unconferences', level: 'A', description: 'Run unconference-style architecture events where teams set the agenda and drive the conversations.' },
      { name: 'Autonomy Pulse Survey', level: 'A', description: 'Regularly measure teams\' perceived autonomy over technical decisions as an organisational health indicator.' },
    ]
  },
  { name: 'Security Shift Left', domain: 'Technology & Architecture', source: 'Accelerate',
    description: 'Security integrated throughout delivery; devs own security practices, not a separate gate.',
    practices: [
      { name: 'SAST in CI Pipeline', level: 'F', description: 'Integrate Static Application Security Testing into the CI pipeline to catch vulnerabilities early.' },
      { name: 'Dependency Vulnerability Checks', level: 'F', description: 'Automatically scan all dependencies for known vulnerabilities on every build.' },
      { name: 'Security Champions Programme', level: 'D', description: 'Embed security champions in each team to build security capability close to the code.' },
      { name: 'Threat Modelling Practice', level: 'D', description: 'Run threat modelling sessions for new features to identify security risks before building.' },
      { name: 'Security Unit Tests', level: 'A', description: 'Write unit tests that explicitly validate security properties and behaviours in the codebase.' },
      { name: 'MTTR Security Tracking', level: 'A', description: 'Track mean time to remediate security vulnerabilities as a key operational security metric.' },
    ]
  },

  // ═══════════════════════════════════════════
  // PEOPLE, CULTURE & GOVERNANCE — 12 capabilities
  // ═══════════════════════════════════════════
  { name: 'Psychological Safety', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'Creating conditions where people speak up, take risks and learn without fear.',
    practices: [
      { name: 'Psychological Safety Assessment', level: 'F', description: "Measure the team's current level of psychological safety using a validated survey instrument." },
      { name: 'Working Agreements', level: 'F', description: 'Co-create explicit team working agreements that define norms for safe collaboration.' },
      { name: 'Blameless Post-Mortems', level: 'D', description: 'Run post-mortems that focus on systemic causes rather than individual blame.' },
      { name: 'Manager Safety Training', level: 'D', description: 'Train managers in the behaviours that build and destroy psychological safety in their teams.' },
      { name: 'Failure Celebration Rituals', level: 'A', description: 'Create rituals that publicly celebrate well-intentioned failures to normalise learning from mistakes.' },
      { name: 'Safety Climate Monitoring', level: 'A', description: 'Continuously monitor psychological safety climate using pulse surveys and behavioural indicators.' },
    ]
  },
  { name: 'Power Distribution', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'How authority and decision-making are distributed across the organisation.',
    practices: [
      { name: 'Decision Authority Mapping', level: 'F', description: 'Map who has authority over which decisions to make the current power distribution explicit.' },
      { name: 'DACI/RACI Clarification', level: 'F', description: 'Use DACI or RACI frameworks to clarify decision roles and reduce confusion at team boundaries.' },
      { name: 'Decision Escalation Framework', level: 'D', description: 'Define clear criteria for when decisions should escalate and to whom.' },
      { name: 'Decision Latency Tracking', level: 'D', description: 'Measure how long decisions take and use the data to identify and remove decision bottlenecks.' },
      { name: 'Delegation Board', level: 'A', description: 'Use a Delegation Board to explicitly agree on delegation levels for each decision type.' },
      { name: 'Authority Audit', level: 'A', description: 'Run a regular audit to check whether decision authority is still appropriately distributed.' },
    ]
  },
  { name: 'Culture Design', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'Intentional shaping of norms, rituals and artefacts to support transformation.',
    practices: [
      { name: 'Participatory Values Creation', level: 'F', description: 'Engage the whole organisation in defining values to build genuine commitment rather than compliance.' },
      { name: 'Observable Behaviour Definition', level: 'F', description: 'Translate values into specific, observable behaviours that people can act on daily.' },
      { name: 'Culture Health Assessment', level: 'D', description: 'Assess culture health regularly using validated instruments to track change over time.' },
      { name: 'Culture Artefact Audit', level: 'D', description: 'Audit physical and digital artefacts to check they reinforce rather than contradict the desired culture.' },
      { name: 'Leader as Culture Role Model', level: 'A', description: 'Hold leaders accountable for modelling the desired culture through their daily behaviours.' },
      { name: 'Culture Evolution Roadmap', level: 'A', description: 'Create an explicit roadmap for culture evolution with milestones and measurement checkpoints.' },
    ]
  },
  { name: 'Leadership Dev.', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'Growing leaders who can operate effectively in ambiguous, fast-changing contexts.',
    practices: [
      { name: 'Leadership Competency Framework', level: 'F', description: 'Define the competencies required for effective leadership in the transformation context.' },
      { name: '360 Feedback Cycles', level: 'F', description: 'Run regular 360-degree feedback cycles to give leaders multi-perspective development input.' },
      { name: 'Executive Coaching Programme', level: 'D', description: 'Pair senior leaders with experienced coaches to accelerate personal development.' },
      { name: 'Leadership Flight Simulator', level: 'D', description: 'Use simulation exercises to develop leadership skills in a safe, consequence-free environment.' },
      { name: 'Leadership Community of Practice', level: 'A', description: 'Create a community of practice where leaders share challenges and develop together.' },
      { name: 'Succession Planning', level: 'A', description: 'Build a proactive succession plan to ensure leadership continuity and develop the next generation.' },
    ]
  },
  { name: 'Governance Patterns', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'Lightweight structures that guide behaviour without creating bureaucracy.',
    practices: [
      { name: 'Governance Inventory', level: 'F', description: 'Inventory all existing governance processes to identify which are necessary versus bureaucratic.' },
      { name: 'Guardrails not Gates', level: 'F', description: 'Replace approval gates with guardrails that teams can self-check against without seeking permission.' },
      { name: 'Governance Overhead Metric', level: 'D', description: 'Measure the time teams spend on governance activities to identify and reduce unnecessary overhead.' },
      { name: 'Policy as Code', level: 'D', description: 'Encode governance policies as automated checks that run in the delivery pipeline.' },
      { name: 'Lightweight Governance Forum', level: 'A', description: 'Replace heavyweight governance committees with a lightweight forum that meets frequently and decides fast.' },
      { name: 'Governance Retrospectives', level: 'A', description: 'Run retrospectives on governance processes to continuously simplify and improve them.' },
    ]
  },
  { name: 'Meaning Making', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'Connecting daily work to purpose and strategy to sustain motivation.',
    practices: [
      { name: 'OKR Line-of-Sight Workshop', level: 'F', description: 'Run workshops to help each team see how their work connects to the company OKRs.' },
      { name: 'Customer Story Sharing', level: 'F', description: 'Regularly share real customer stories so teams understand the human impact of their work.' },
      { name: 'Purpose Alignment Surveys', level: 'D', description: 'Survey teams to measure how connected they feel to the organisational purpose.' },
      { name: 'Why We Do This Sessions', level: 'D', description: 'Run "Why We Do This" sessions where leaders explain the strategic rationale behind key decisions.' },
      { name: 'Meaning Recognition Programme', level: 'A', description: 'Create a programme that recognises and celebrates contributions that embody the organisational purpose.' },
      { name: 'Purpose-Driven Retrospectives', level: 'A', description: 'Run retrospectives that connect improvements back to the team\'s purpose and the customer impact.' },
    ]
  },
  { name: 'Change Readiness', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'Organisational capacity to absorb and adapt to ongoing change.',
    practices: [
      { name: 'Change Readiness Assessment', level: 'F', description: 'Assess the organisation\'s readiness for change before launching major transformation initiatives.' },
      { name: 'Change Calendar Management', level: 'F', description: 'Maintain a change calendar to prevent change overload and coordinate the pace of transformation.' },
      { name: 'Internal Change Coaches', level: 'D', description: 'Train and deploy internal change coaches to support teams through transformation initiatives.' },
      { name: 'Change Adoption Tracking', level: 'D', description: 'Track adoption rates of key changes to identify where additional support is needed.' },
      { name: 'Change Retrospectives', level: 'A', description: 'Run retrospectives after significant change initiatives to extract learning and improve change capability.' },
      { name: 'Resilience Building Programme', level: 'A', description: 'Run a programme specifically designed to build individual and organisational resilience to change.' },
    ]
  },
  { name: 'Team Health', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'Monitoring and improving team dynamics, wellbeing and performance.',
    practices: [
      { name: 'Team Health Check Model', level: 'F', description: 'Use a structured health check model (e.g. Spotify Squad Health Check) to baseline team health.' },
      { name: 'Psychological Safety Baseline', level: 'F', description: 'Measure psychological safety as a core team health metric from the start.' },
      { name: 'Early Warning System', level: 'D', description: 'Implement an early warning system to detect team health deterioration before it becomes critical.' },
      { name: 'Team Effectiveness Workshops', level: 'D', description: 'Run targeted workshops to address specific team effectiveness gaps identified through health checks.' },
      { name: 'Wellbeing Support Access', level: 'A', description: 'Ensure all team members have clear access to wellbeing support resources when needed.' },
      { name: 'Team Health Trend Dashboard', level: 'A', description: 'Build a dashboard showing team health trends over time to track the impact of interventions.' },
    ]
  },
  { name: 'Learning & Dev.', domain: 'People, Culture & Governance', source: 'Nexus',
    description: 'Systems for acquiring new skills and sharing knowledge at every level.',
    practices: [
      { name: 'Individual Development Plans', level: 'F', description: 'Create and maintain IDPs for every team member aligned to personal and organisational goals.' },
      { name: 'Learning Time Policy', level: 'F', description: 'Protect dedicated learning time in each sprint so development is not crowded out by delivery.' },
      { name: 'Capability Academy Programme', level: 'D', description: 'Build an internal academy that provides structured learning pathways for key transformation capabilities.' },
      { name: 'Skills Taxonomy', level: 'D', description: 'Define a skills taxonomy for the organisation to enable consistent skills mapping and gap analysis.' },
      { name: 'Knowledge Sharing Rituals', level: 'A', description: 'Establish recurring rituals (lightning talks, guilds, brown-bags) that make knowledge sharing habitual.' },
      { name: 'Learning Effectiveness Metrics', level: 'A', description: 'Measure whether learning investments are translating into behaviour change and performance improvement.' },
    ]
  },
  { name: 'Generative Culture', domain: 'People, Culture & Governance', source: 'Accelerate',
    description: 'Westrum organisational culture typology: high cooperation, shared risks, bridging.',
    practices: [
      { name: 'Westrum Culture Survey', level: 'F', description: 'Use the Westrum culture survey to measure where the organisation sits on the pathological–generative spectrum.' },
      { name: 'Blameless Incident Reviews', level: 'F', description: 'Standardise blameless incident reviews as the default response to all significant operational failures.' },
      { name: 'Information Flow Improvement', level: 'D', description: 'Identify and remove barriers to information flow so that the right information reaches the right people.' },
      { name: 'Cross-Boundary Knowledge Sharing', level: 'D', description: 'Create deliberate mechanisms for knowledge to cross team and department boundaries.' },
      { name: 'Risk-Sharing Practices', level: 'A', description: 'Implement practices that distribute risk-taking across the organisation rather than concentrating it at the top.' },
      { name: 'Generative Culture Indicators', level: 'A', description: 'Define and track leading behavioural indicators of generative culture across the organisation.' },
    ]
  },
  { name: 'Cross-Team Collaboration', domain: 'People, Culture & Governance', source: 'Accelerate',
    description: 'Active, structured collaboration across team and organisational boundaries.',
    practices: [
      { name: 'Dependency Mapping', level: 'F', description: 'Map cross-team dependencies explicitly to make collaboration needs visible and manageable.' },
      { name: 'Shared Dependency Backlog', level: 'F', description: 'Maintain a shared backlog for cross-team dependencies to ensure they are prioritised and resolved.' },
      { name: 'Cross-Team Retrospectives', level: 'D', description: 'Run retrospectives that span team boundaries to surface and resolve systemic collaboration issues.' },
      { name: 'Cross-Functional Hackathons', level: 'D', description: 'Run hackathons that bring people from different teams and disciplines together around shared problems.' },
      { name: 'Collaboration Health Metric', level: 'A', description: 'Define and track a metric for cross-team collaboration health to drive continuous improvement.' },
      { name: 'Org Network Analysis', level: 'A', description: 'Use organisational network analysis to understand and improve informal collaboration patterns.' },
    ]
  },
  { name: 'Transformational Leadership', domain: 'People, Culture & Governance', source: 'Accelerate',
    description: 'Leaders who inspire, communicate clear vision, and support innovation and learning.',
    practices: [
      { name: 'Transformational Leadership Assessment', level: 'F', description: 'Assess leaders against a transformational leadership model to identify development needs.' },
      { name: 'Leader Vision Communication', level: 'F', description: 'Develop leaders\' ability to communicate a compelling vision that motivates and aligns teams.' },
      { name: 'Leader Shadow Programme', level: 'D', description: 'Run a shadow programme where leaders shadow other leaders to accelerate learning.' },
      { name: 'Skip-Level Connections', level: 'D', description: 'Enable skip-level conversations between senior leaders and individual contributors to build alignment.' },
      { name: 'Leadership Visible Participation', level: 'A', description: 'Track and encourage leaders to visibly participate in transformation activities as role models.' },
      { name: 'Leadership 360 Aligned to Transformation', level: 'A', description: 'Run 360-degree feedback aligned specifically to transformation leadership behaviours.' },
    ]
  },

  // ═══════════════════════════════════════════
  // OPERATIONS — 12 capabilities
  // ═══════════════════════════════════════════
  { name: 'Operational Habits', domain: 'Operations', source: 'Nexus',
    description: 'Day-to-day behaviours and rituals that reinforce the desired operating model.',
    practices: [
      { name: 'Operating Rhythm Design', level: 'F', description: 'Design the day-to-day and week-to-week rhythm of meetings, check-ins and ceremonies.' },
      { name: 'Visual Management Board', level: 'F', description: 'Create a physical or digital visual management board that makes operational status visible at a glance.' },
      { name: 'Operating Model Retrospectives', level: 'D', description: 'Run retrospectives specifically on the operating model to continuously refine it.' },
      { name: 'Toil Reduction Programme', level: 'D', description: 'Identify and systematically eliminate toil — repetitive, manual work that does not add value.' },
      { name: 'Habit Stacking for Change', level: 'A', description: 'Use habit stacking techniques to embed new operational behaviours into existing routines.' },
      { name: 'Operational Fitness Functions', level: 'A', description: 'Define automated fitness functions that continuously validate operational health.' },
    ]
  },
  { name: 'Process Improvement', domain: 'Operations', source: 'Nexus',
    description: 'Systematic identification and elimination of waste in operational processes.',
    practices: [
      { name: 'Continuous Improvement Backlog', level: 'F', description: 'Maintain a visible backlog of process improvement opportunities accessible to all teams.' },
      { name: 'Waste Identification Exercise', level: 'F', description: 'Run structured exercises to identify the eight types of waste in key operational processes.' },
      { name: 'Kaizen Events', level: 'D', description: 'Run focused Kaizen improvement events to make rapid, targeted improvements in specific processes.' },
      { name: 'A3 Problem Solving', level: 'D', description: 'Use the A3 structured problem-solving format to analyse root causes and define countermeasures.' },
      { name: 'Improvement Velocity Tracking', level: 'A', description: 'Track the rate at which improvements are identified, implemented and validated.' },
      { name: 'Value Stream Optimisation', level: 'A', description: 'Apply value stream analysis to optimise end-to-end operational processes, not just local steps.' },
    ]
  },
  { name: 'Tooling Adoption', domain: 'Operations', source: 'Nexus',
    description: 'Ensuring tools are actually used effectively, not just installed.',
    practices: [
      { name: 'Tool Usage Metrics', level: 'F', description: 'Instrument tools to measure actual usage and identify where adoption has stalled.' },
      { name: 'Tool Onboarding Sprints', level: 'F', description: 'Run dedicated onboarding sprints when introducing new tools to ensure teams are set up for success.' },
      { name: 'Tool Champions Network', level: 'D', description: 'Identify and empower tool champions within each team who support adoption and gather feedback.' },
      { name: 'Tool NPS Tracking', level: 'D', description: 'Survey tool users with NPS questions to track satisfaction and identify tools that need improvement.' },
      { name: 'Zero-Usage Retirement Policy', level: 'A', description: 'Define a policy to retire tools that fall below a minimum usage threshold to reduce tooling bloat.' },
      { name: 'Tool ROI Assessment', level: 'A', description: 'Assess the return on investment of key tools to make evidence-based decisions on continuation or replacement.' },
    ]
  },
  { name: 'Performance Metrics', domain: 'Operations', source: 'Nexus',
    description: 'Measurement systems that inform decisions rather than just reporting status.',
    practices: [
      { name: 'Metrics Hierarchy Design', level: 'F', description: 'Design a hierarchy of metrics from strategic outcomes down to operational leading indicators.' },
      { name: 'Leading vs Lagging Indicators', level: 'F', description: 'Identify and track both leading indicators (predictive) and lagging indicators (outcomes) for key goals.' },
      { name: 'Action-Oriented Metrics', level: 'D', description: 'Ensure every tracked metric has an owner and a defined response protocol when it crosses a threshold.' },
      { name: 'Real-Time Operational Dashboard', level: 'D', description: 'Build a real-time operational dashboard that gives teams immediate visibility of performance.' },
      { name: 'Metric Credibility Check', level: 'A', description: 'Regularly challenge metric definitions to ensure they measure what actually matters, not what is easy to count.' },
      { name: 'Metric Sunset Reviews', level: 'A', description: 'Run periodic reviews to retire metrics that no longer drive useful action.' },
    ]
  },
  { name: 'Communication Rhythms', domain: 'Operations', source: 'Nexus',
    description: 'Structured cadences for information flow across teams and layers.',
    practices: [
      { name: 'Communication Calendar Audit', level: 'F', description: 'Audit all recurring meetings and communication channels to identify gaps and redundancy.' },
      { name: 'Async-First Communication', level: 'F', description: 'Establish async-first norms to reduce meeting overload and enable distributed team collaboration.' },
      { name: 'Weekly Written Updates', level: 'D', description: 'Replace status meetings with concise weekly written updates that teams can read asynchronously.' },
      { name: 'Communication Charter', level: 'D', description: 'Create a communication charter that defines which channels to use for which types of messages.' },
      { name: 'Deep Work Protection', level: 'A', description: 'Block time for focused deep work across the organisation by reducing interruptions and meetings.' },
      { name: 'Communication Effectiveness Survey', level: 'A', description: 'Survey the organisation regularly on communication effectiveness to identify systemic issues.' },
    ]
  },
  { name: 'Knowledge Mgmt', domain: 'Operations', source: 'Nexus',
    description: 'Capturing and making accessible the institutional knowledge needed to operate.',
    practices: [
      { name: 'Knowledge Base Implementation', level: 'F', description: 'Implement a searchable knowledge base as the single source of truth for institutional knowledge.' },
      { name: 'Documentation in Definition of Done', level: 'F', description: 'Include documentation updates in the Definition of Done to keep knowledge current.' },
      { name: 'Knowledge Audit', level: 'D', description: 'Audit the knowledge base regularly to identify gaps, outdated content and orphaned articles.' },
      { name: 'Knowledge Sharing Rituals', level: 'D', description: 'Create recurring rituals (e.g. lunch-and-learns, knowledge newsletters) to make sharing habitual.' },
      { name: 'Knowledge Base Health Metrics', level: 'A', description: 'Track knowledge base health using metrics like search success rate, content freshness and contribution rate.' },
      { name: 'Expert Maps', level: 'A', description: 'Create and maintain maps of expertise across the organisation so people know who to consult.' },
    ]
  },
  { name: 'Incident Mgmt', domain: 'Operations', source: 'Nexus',
    description: 'Responding to and learning from operational failures quickly and safely.',
    practices: [
      { name: 'Incident Response Playbook', level: 'F', description: 'Create a clear playbook that defines how incidents are detected, communicated and resolved.' },
      { name: 'MTTD and MTTR Tracking', level: 'F', description: 'Track Mean Time to Detect and Mean Time to Resolve as core operational SLOs.' },
      { name: 'Blameless Post-Mortems', level: 'D', description: 'Run blameless post-mortems after every significant incident to extract systemic learning.' },
      { name: 'Incident Trend Retrospectives', level: 'D', description: 'Run periodic retrospectives on incident trends to identify and address recurring patterns.' },
      { name: 'Runbook Automation', level: 'A', description: 'Automate runbook steps to reduce response time and eliminate manual errors during incidents.' },
      { name: 'Game Day Exercises', level: 'A', description: 'Run regular Game Day exercises that simulate production failures to test and improve response capability.' },
    ]
  },
  { name: 'Lightweight Change Approval', domain: 'Operations', source: 'Accelerate',
    description: 'Lightweight, risk-based process for authorising changes; no heavyweight CAB for standard changes.',
    practices: [
      { name: 'Change Classification System', level: 'F', description: 'Classify all changes into standard, normal and emergency categories with different approval paths.' },
      { name: 'Standard Change Library', level: 'F', description: 'Build a library of pre-approved standard changes that can be deployed without additional approval.' },
      { name: 'Peer Review as Approval', level: 'D', description: 'Use peer code review as the primary approval mechanism for standard changes, replacing CAB.' },
      { name: 'Change Lead Time Tracking', level: 'D', description: 'Measure how long changes take from approval request to deployment to identify and reduce delays.' },
      { name: 'CAB Elimination Review', level: 'A', description: 'Run a formal review to assess whether remaining CAB processes can be eliminated or further simplified.' },
      { name: 'Change Failure Rate vs Speed', level: 'A', description: 'Track the relationship between change speed and failure rate to validate that faster is also safer.' },
    ]
  },
  { name: 'Infra & App Monitoring', domain: 'Operations', source: 'Accelerate',
    description: 'Comprehensive monitoring of system health and business metrics with actionable alerts.',
    practices: [
      { name: 'Four Golden Signals', level: 'F', description: 'Instrument all services with the four golden signals: latency, traffic, errors and saturation.' },
      { name: 'Service Level Objectives', level: 'F', description: 'Define SLOs for all customer-facing services and track error budgets against them.' },
      { name: 'Observability Stack Implementation', level: 'D', description: 'Implement a full observability stack covering metrics, logs and traces.' },
      { name: 'SLO-Based Alerting', level: 'D', description: 'Configure alerts based on SLO burn rate rather than static thresholds to reduce alert fatigue.' },
      { name: 'Business Metrics Monitoring', level: 'A', description: 'Extend monitoring beyond technical metrics to include business KPIs in the same observability stack.' },
      { name: 'Distributed Tracing', level: 'A', description: 'Implement distributed tracing to enable end-to-end request visibility across all services.' },
    ]
  },
  { name: 'Proactive Sys. Health', domain: 'Operations', source: 'Accelerate',
    description: 'Proactively managing system capacity, health and reliability before issues arise.',
    practices: [
      { name: 'Capacity Planning Cadence', level: 'F', description: 'Establish a regular cadence for capacity planning to prevent resource exhaustion surprises.' },
      { name: 'Disaster Recovery Runbooks', level: 'F', description: 'Create and test disaster recovery runbooks for all critical systems.' },
      { name: 'Availability Tracking', level: 'D', description: 'Track service availability against SLO targets and trend it over time.' },
      { name: 'Chaos Engineering Practice', level: 'D', description: 'Run controlled chaos engineering experiments to proactively discover system weaknesses.' },
      { name: 'Self-Healing Automation', level: 'A', description: 'Implement automated self-healing mechanisms that resolve known failure modes without human intervention.' },
      { name: 'Reliability Engineering Sprints', level: 'A', description: 'Run dedicated reliability engineering sprints focused on improving system resilience.' },
    ]
  },
  { name: 'WIP Limits', domain: 'Operations', source: 'Accelerate',
    description: 'Explicit limits on work-in-progress to expose bottlenecks and improve flow.',
    practices: [
      { name: 'WIP Limit Definition', level: 'F', description: 'Define explicit WIP limits for each stage of the workflow and make them visible on the board.' },
      { name: 'Board Enforcement', level: 'F', description: 'Enforce WIP limits on the board so exceeding them is immediately visible and triggers action.' },
      { name: 'WIP Age Tracking', level: 'D', description: 'Track how long each work item has been in progress to identify stale items and blockers.' },
      { name: 'Stop Starting Retrospectives', level: 'D', description: 'Run retrospectives focused on the "stop starting, start finishing" principle to reinforce WIP discipline.' },
      { name: 'WIP Limit Experiments', level: 'A', description: 'Run controlled experiments with different WIP limits to find the optimum for the team\'s context.' },
      { name: 'Portfolio-Level WIP Limits', level: 'A', description: 'Apply WIP limits at the portfolio level to prevent too many initiatives running simultaneously.' },
    ]
  },
  { name: 'Work Visualization', domain: 'Operations', source: 'Accelerate',
    description: 'Visual boards and radiators making work, flow and blockers visible to the whole team.',
    practices: [
      { name: 'Team Kanban Board', level: 'F', description: 'Implement a team Kanban board that makes all work, its status and blockers visible.' },
      { name: 'Blocker Swim Lane', level: 'F', description: 'Add a dedicated blocker swim lane to the board to make impediments visible and prioritised.' },
      { name: 'Cumulative Flow Diagrams', level: 'D', description: 'Generate and review cumulative flow diagrams to spot flow problems before they become crises.' },
      { name: 'Board Health Reviews', level: 'D', description: 'Regularly review the board setup to ensure it is still accurately reflecting the team\'s workflow.' },
      { name: 'Radiator Design', level: 'A', description: 'Design and maintain information radiators that make key metrics visible without requiring anyone to ask.' },
      { name: 'Automated Board Analytics', level: 'A', description: 'Automate collection of board analytics to generate flow reports without manual data extraction.' },
    ]
  },

  // ═══════════════════════════════════════════
  // AGILITY (Scrum · XP · Agnostic Agility) — 2 capabilities
  // ═══════════════════════════════════════════
  { name: 'Agility', domain: 'Product & Delivery', source: 'Scrum · XP · Agnostic Agility',
    description: 'Team-level agile delivery — the deduplicated blend of Scrum, Extreme Programming and Agnostic Agility patterns that generate good delivery habits.',
    practices: [
      { name: 'Sprint', level: 'F', description: 'Work in a fixed-length timebox that produces a Done, potentially releasable increment each cycle.' },
      { name: 'Sprint Planning', level: 'F', description: 'Collaboratively plan the sprint goal and select the work the team commits to for the sprint.' },
      { name: 'Daily Scrum', level: 'F', description: 'Hold a short daily sync for the team to inspect progress toward the sprint goal and re-plan.' },
      { name: 'Sprint Review', level: 'F', description: 'Inspect the increment with stakeholders and adapt the product backlog based on feedback.' },
      { name: 'Sprint Retrospective', level: 'F', description: 'Reflect on how the team worked and commit to concrete improvements for the next sprint.' },
      { name: 'Product Backlog', level: 'F', description: 'Maintain a single, ordered, transparent list of everything that might be needed in the product (the agile backlog).' },
      { name: 'Sprint Backlog', level: 'F', description: 'Make the sprint goal, selected items and the plan to deliver them visible to the whole team.' },
      { name: 'Product Increment', level: 'F', description: 'Deliver a concrete, integrated step of usable value each sprint that meets the Definition of Done.' },
      { name: 'Definition of Done', level: 'F', description: 'Agree a shared, explicit quality checklist that every increment must meet before it is considered complete.' },
      { name: 'Sprint Goal', level: 'F', description: 'Set a single coherent objective for the sprint that gives the team focus and room to self-organise.' },
      { name: 'Product Owner Role', level: 'F', description: 'Empower one person accountable for maximising product value and owning the product backlog.' },
      { name: 'Scrum Master Role', level: 'F', description: 'Enable a servant-leader who fosters the team, removes impediments and coaches agile ways of working.' },
      { name: 'Development Team Role', level: 'F', description: 'Form a small, self-managing team of makers collectively accountable for delivering the increment.' },
      { name: 'Backlog Refinement', level: 'D', description: 'Continuously break down, clarify and estimate backlog items so they are ready before planning.' },
      { name: 'Product Goal', level: 'D', description: 'Anchor the backlog to a longer-term product objective that describes a future state to progress toward.' },
      { name: 'Velocity', level: 'D', description: 'Track how much work the team completes per sprint to forecast and inform planning, not to compare teams.' },
      { name: 'Burndown & Burnup Charts', level: 'D', description: 'Visualise remaining or completed work over time to expose progress and flow risks early.' },
      { name: 'Pair Programming', level: 'D', description: 'Two developers work together at one workstation to raise quality, share knowledge and reduce defects.' },
      { name: 'Test-Driven Development (TDD)', level: 'D', description: 'Write a failing test before the code, then make it pass and refactor — red, green, refactor.' },
      { name: 'Continuous Integration', level: 'D', description: 'Integrate and automatically test everyone’s work many times a day to catch problems immediately.' },
      { name: 'Refactoring', level: 'D', description: 'Continuously improve the internal design of code without changing its behaviour to keep it easy to change.' },
      { name: 'Simple Design', level: 'D', description: 'Build the simplest thing that works today (YAGNI) and evolve the design as real needs emerge.' },
      { name: 'Collective Code Ownership', level: 'D', description: 'Let anyone on the team improve any part of the codebase, removing single points of failure.' },
      { name: 'Coding Standards', level: 'F', description: 'Adopt shared conventions so the whole codebase reads as if written by one hand.' },
      { name: 'Sustainable Pace', level: 'F', description: 'Work at a pace the team can sustain indefinitely, protecting energy, focus and quality.' },
      { name: 'Whole Team & On-Site Customer', level: 'D', description: 'Keep the customer and all needed skills together so questions are answered fast and feedback is immediate.' },
      { name: 'Small Releases', level: 'D', description: 'Release working software frequently in small increments to shorten feedback and reduce risk.' },
      { name: 'Acceptance Test-Driven Development', level: 'D', description: 'Define acceptance tests with the customer up front so "done" is objective and shared.' },
      { name: 'Spike Solution', level: 'D', description: 'Run a small time-boxed experiment or prototype to reduce technical or design uncertainty.' },
      { name: 'System Metaphor', level: 'A', description: 'Share a simple story or shared vocabulary of how the system works to align design and communication.' },
      { name: 'Continuous Delivery', level: 'A', description: 'Keep software always in a releasable state through automated build, test and deployment pipelines.' },
      { name: 'User Stories', level: 'F', description: 'Express requirements as short, value-focused stories from the user’s perspective to drive conversation.' },
      { name: 'Timeboxing', level: 'F', description: 'Fix the time available for an activity and flex scope, forcing prioritisation and decisions.' },
      { name: 'Iterative Development', level: 'F', description: 'Revisit and improve the product in repeated cycles of circular improvement rather than one big pass.' },
      { name: 'Inspection & Transparency', level: 'F', description: 'Make work and progress visible and inspect it frequently so problems surface early.' },
      { name: 'Adaptation', level: 'F', description: 'Adjust the product, plan or process quickly the moment inspection reveals a meaningful deviation.' },
      { name: 'Business Value Focus', level: 'F', description: 'Order and pull work by the value it delivers so the most valuable outcomes are realised first.' },
      { name: 'Context — Definition of Value', level: 'F', description: 'Continually ask "what is value today?" and let the current context define what the team optimises for.' },
      { name: 'Safe-to-Fail Experiments', level: 'D', description: 'Frame changes as small hypotheses that are safe to fail, run them, and keep only what works.' },
      { name: 'Bite-Size Work (Small Batch)', level: 'D', description: 'Slice work into the smallest valuable batches to improve flow, feedback and predictability.' },
      { name: 'Feedback Loops', level: 'F', description: 'Design fast, frequent feedback loops with users and the system to enable continuous learning.' },
      { name: 'Course Correction', level: 'D', description: 'Build in existential flexibility to change direction based on evidence rather than defending the plan.' },
      { name: 'Continuous Learning', level: 'D', description: 'Invest in team and self growth so capability compounds over time.' },
      { name: 'Continuous Quality', level: 'D', description: 'Keep quality and simplicity built-in every step rather than inspected-in at the end.' },
      { name: 'Limit Work in Progress', level: 'D', description: 'Cap the amount of work started at once to expose bottlenecks and finish faster.' },
      { name: 'Agile Estimating', level: 'D', description: 'Estimate relatively (story points, planning poker) to plan lightly and respond to change.' },
      { name: 'Multi-Disciplinary Team', level: 'D', description: 'Bring diverse, cross-functional skills into one team to expand learning and remove hand-offs.' },
      { name: 'The Law of the Small Team', level: 'D', description: 'Keep teams small and high-trust so they can move fast and self-organise.' },
      { name: 'The Law of the Customer', level: 'D', description: 'Anchor everything in empathy, dialogue and collaboration with the customer.' },
    ]
  },
  { name: 'Agility at Scale', domain: 'Product & Delivery', source: 'Scrum@Scale · Nexus · Agnostic Agility',
    description: 'Coordinating many agile teams as one network of teams — the practices that scale team-level agility across an organisation while minimising dependencies.',
    practices: [
      { name: 'The Law of the Network', level: 'F', description: 'Treat the organisation as a network of interacting teams and agents rather than a hierarchy of silos.' },
      { name: 'Common Sprint Cadence', level: 'F', description: 'Synchronise sprints across teams so integration, planning and review align on a shared rhythm.' },
      { name: 'Scrum of Scrums', level: 'F', description: 'Run a regular cross-team sync where team representatives coordinate work and surface dependencies.' },
      { name: 'Cross-Team Backlog Refinement', level: 'F', description: 'Refine a shared backlog across teams so dependencies and integration are understood before planning.' },
      { name: 'Nexus Integration Team', level: 'D', description: 'Stand up an accountable integration team that ensures a single integrated increment each sprint.' },
      { name: 'Single Integrated Increment', level: 'D', description: 'Combine all teams’ work into one integrated, Done increment that is genuinely usable together.' },
      { name: 'Cross-Team Continuous Integration', level: 'D', description: 'Integrate every team’s work continuously so scaling problems are exposed daily, not at the end.' },
      { name: 'Dependency Mapping & Management', level: 'D', description: 'Make cross-team dependencies visible and actively reduce or sequence them to protect flow.' },
      { name: 'Communities of Practice', level: 'D', description: 'Form cross-team guilds so skills, standards and learning spread horizontally across the network.' },
      { name: 'Aligned Autonomy', level: 'A', description: 'Give teams decentralised execution against shared goals — alignment on the what, autonomy on the how.' },
      { name: 'Descaling & Minimal Dependencies', level: 'A', description: 'Design team topologies and product boundaries to minimise dependencies rather than manage them.' },
    ]
  },
];

async function seedCapabilitiesIfEmpty(force = false) {
  try {
    // Ensure domain/source/level columns exist (idempotent migrations)
    await db.query('ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS domain TEXT');
    await db.query('ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS source TEXT');
    await db.query('ALTER TABLE practices ADD COLUMN IF NOT EXISTS level TEXT');

    const { rows } = await db.query('SELECT COUNT(*) FROM capabilities');
    const count = parseInt(rows[0].count);
    // Only seed when the library is truly empty. Never re-seed just because the
    // count changed — a destructive DELETE + re-insert re-issues every practice
    // UUID and orphans every board's practice-maturity / experiment data.
    if (!force && count > 0) return;

    // Bulk delete + re-insert inside a single transaction (avoids Vercel timeout)
    await db.query('BEGIN');
    await db.query('DELETE FROM practices');
    await db.query('DELETE FROM capabilities');

    // ── Bulk INSERT capabilities ─────────────────────────────────────────
    const cNames   = SEED_CAPABILITIES.map(c => c.name);
    const cDescs   = SEED_CAPABILITIES.map(c => c.description);
    const cDomains = SEED_CAPABILITIES.map(c => c.domain);
    const cSources = SEED_CAPABILITIES.map(c => c.source);
    const cOrders  = SEED_CAPABILITIES.map((_, i) => i + 1);
    const { rows: capRows } = await db.query(
      `INSERT INTO capabilities (name, description, domain, source, sort_order)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[])
       RETURNING id, sort_order`,
      [cNames, cDescs, cDomains, cSources, cOrders]
    );
    capRows.sort((a, b) => a.sort_order - b.sort_order);

    // ── Bulk INSERT practices ────────────────────────────────────────────
    const pCapIds = [], pNames = [], pDescs = [], pLevels = [], pOrders = [];
    SEED_CAPABILITIES.forEach((cap, i) => {
      const capId = capRows[i].id;
      cap.practices.forEach((p, j) => {
        pCapIds.push(capId);
        pNames.push(p.name);
        pDescs.push(p.description);
        pLevels.push(p.level || null);
        pOrders.push(j + 1);
      });
    });
    await db.query(
      `INSERT INTO practices (capability_id, name, description, level, sort_order)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::int[])`,
      [pCapIds, pNames, pDescs, pLevels, pOrders]
    );

    await db.query('COMMIT');
    console.log(`NTT DATA Nexus Capabilities Library seeded: ${SEED_CAPABILITIES.length} capabilities, ${pNames.length} practices`);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('Seed error:', err.message);
  }
}

// Non-destructive: realign each seeded capability's org domain by name.
// Corrects the live DB to the canonical org domains (Strategy & Portfolio,
// Product & Delivery, …) without deleting capabilities or practices.
async function remapCapabilityDomains() {
  try {
    await db.query('ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS domain TEXT');
    const names   = SEED_CAPABILITIES.map(c => c.name);
    const domains = SEED_CAPABILITIES.map(c => c.domain);
    const { rowCount } = await db.query(
      `UPDATE capabilities AS c
         SET domain = m.domain
        FROM unnest($1::text[], $2::text[]) AS m(name, domain)
       WHERE c.name = m.name
         AND c.domain IS DISTINCT FROM m.domain`,
      [names, domains]
    );
    if (rowCount > 0) console.log(`Capability domains realigned: ${rowCount} updated`);
  } catch (err) {
    console.error('Domain remap error:', err.message);
  }
}

// ── Artificial Intelligence capabilities (business + technology) ──────────
// Added non-destructively (insert-by-name-if-missing) so they don't trigger a
// full re-seed or delete any existing/custom capabilities.
const AI_CAPABILITIES = [
  // ── Business-facing AI ──
  { name: 'AI Strategy & Governance', domain: 'Artificial Intelligence', source: 'Nexus AI',
    description: 'How the organization frames AI ambition, governs its use and manages risk responsibly.',
    practices: [
      { name: 'AI Ambition & Value Framing', level: 'F', description: 'Define where AI can create value and set a clear, outcome-based ambition tied to strategy.' },
      { name: 'Responsible AI Policy', level: 'F', description: 'Publish principles for fair, transparent and accountable AI that teams can apply day to day.' },
      { name: 'AI Governance Board', level: 'D', description: 'Stand up a cross-functional body to approve, prioritise and oversee AI initiatives.' },
      { name: 'Model & Use-Case Inventory', level: 'D', description: 'Maintain a live register of AI use cases and models with owners, purpose and risk tier.' },
      { name: 'AI Risk & Compliance Register', level: 'A', description: 'Track regulatory, ethical and operational AI risks with mitigations and review cadence.' },
      { name: 'AI Ethics Review', level: 'A', description: 'Run structured ethics reviews for higher-risk use cases before and during deployment.' },
    ]
  },
  { name: 'AI Value & Adoption', domain: 'Artificial Intelligence', source: 'Nexus AI',
    description: 'Turning AI opportunities into adopted, value-generating change across the business.',
    practices: [
      { name: 'Use-Case Discovery & Prioritisation', level: 'F', description: 'Surface candidate use cases and rank them by value, feasibility and risk.' },
      { name: 'Value Hypothesis per Use Case', level: 'F', description: 'State the measurable outcome each AI use case is expected to move, and how it is tested.' },
      { name: 'Human-in-the-Loop Design', level: 'D', description: 'Design where humans review, override or approve AI output to keep judgement in the loop.' },
      { name: 'AI Change & Upskilling', level: 'D', description: 'Prepare people with the skills, framing and support to work alongside AI.' },
      { name: 'Adoption Metrics & Feedback', level: 'A', description: 'Measure real usage and gather user feedback to steer iteration, not just go-live.' },
      { name: 'Benefits Realisation Tracking', level: 'A', description: 'Follow value from hypothesis to realised outcome and feed learnings back to the portfolio.' },
    ]
  },
  { name: 'AI-Augmented Ways of Working', domain: 'Artificial Intelligence', source: 'Nexus AI',
    description: 'Embedding AI assistants and copilots into how teams do their everyday work.',
    practices: [
      { name: 'Assistant & Copilot Patterns', level: 'F', description: 'Establish reusable patterns for how teams use assistants safely and effectively.' },
      { name: 'Acceptable-Use Guardrails', level: 'F', description: 'Set clear, practical rules for what may (and may not) be shared with AI tools.' },
      { name: 'Knowledge Retrieval for Teams', level: 'D', description: 'Give teams grounded answers from their own trusted knowledge via retrieval.' },
      { name: 'AI-Assisted Decision Support', level: 'D', description: 'Use AI to summarise, draft and surface options while people make the call.' },
      { name: 'Prompt & Template Library', level: 'A', description: 'Curate shared, versioned prompts and templates so good practice spreads.' },
      { name: 'Productivity Measurement', level: 'A', description: 'Assess the real impact of AI on flow and quality, avoiding vanity metrics.' },
    ]
  },
  // ── Technology-facing AI ──
  { name: 'Data Foundation for AI', domain: 'Artificial Intelligence', source: 'Nexus AI',
    description: 'The data quality, access and governance that make AI trustworthy and possible.',
    practices: [
      { name: 'Data Quality & Lineage', level: 'F', description: 'Ensure data is accurate and traceable from source to model input.' },
      { name: 'Data Contracts', level: 'F', description: 'Agree explicit schemas and expectations between data producers and consumers.' },
      { name: 'Privacy & PII Handling', level: 'D', description: 'Protect sensitive data with minimisation, masking and access controls.' },
      { name: 'Labeling & Annotation', level: 'D', description: 'Produce high-quality labelled data with consistent, reviewed guidelines.' },
      { name: 'Feature Store', level: 'A', description: 'Share consistent, reusable features across training and serving.' },
      { name: 'Vector Store & Embeddings', level: 'A', description: 'Manage embeddings and vector search for retrieval and semantic use cases.' },
    ]
  },
  { name: 'ML Engineering & MLOps', domain: 'Artificial Intelligence', source: 'Nexus AI',
    description: 'Engineering discipline to build, ship and operate machine-learning models reliably.',
    practices: [
      { name: 'Experiment Tracking', level: 'F', description: 'Record datasets, parameters and metrics so experiments are comparable and reproducible.' },
      { name: 'Reproducible Training', level: 'F', description: 'Pin data, code and environment so a model can be rebuilt deterministically.' },
      { name: 'Model Registry & Versioning', level: 'D', description: 'Version, stage and govern models from candidate to production.' },
      { name: 'Model CI/CD Pipelines', level: 'D', description: 'Automate testing, packaging and deployment of models like any other software.' },
      { name: 'Automated Retraining', level: 'A', description: 'Refresh models on schedule or trigger as data and performance change.' },
      { name: 'Training/Serving Parity', level: 'A', description: 'Guarantee features and logic match between training and live serving.' },
    ]
  },
  { name: 'LLM & Generative AI Engineering', domain: 'Artificial Intelligence', source: 'Nexus AI',
    description: 'Building reliable applications on large language and generative models.',
    practices: [
      { name: 'Prompt Engineering & Templating', level: 'F', description: 'Design, test and version prompts as first-class, reviewable artifacts.' },
      { name: 'Retrieval-Augmented Generation (RAG)', level: 'F', description: 'Ground generation in trusted sources to improve accuracy and reduce hallucination.' },
      { name: 'Evaluation & Benchmarking (Evals)', level: 'D', description: 'Score outputs against curated test sets and quality criteria before shipping changes.' },
      { name: 'Guardrails & Safety Filters', level: 'D', description: 'Constrain inputs and outputs to keep responses safe, on-policy and on-topic.' },
      { name: 'Fine-Tuning & Adapters', level: 'A', description: 'Adapt models to domain data when prompting and retrieval are not enough.' },
      { name: 'Cost & Latency Optimisation', level: 'A', description: 'Tune models, caching and routing to balance quality, speed and spend.' },
    ]
  },
  { name: 'AI Observability & Assurance', domain: 'Artificial Intelligence', source: 'Nexus AI',
    description: 'Monitoring, testing and assuring AI systems in production for quality and safety.',
    practices: [
      { name: 'Model Monitoring & Drift Detection', level: 'F', description: 'Watch inputs and outputs for drift and degradation over time.' },
      { name: 'Groundedness & Hallucination Checks', level: 'F', description: 'Verify generated answers are supported by sources and flag unsupported claims.' },
      { name: 'Bias & Fairness Testing', level: 'D', description: 'Test for and mitigate unfair or biased behaviour across groups.' },
      { name: 'Model Performance SLOs', level: 'D', description: 'Define and track service-level objectives for accuracy, latency and availability.' },
      { name: 'Red-Teaming & Adversarial Testing', level: 'A', description: 'Probe models for jailbreaks, misuse and failure modes before attackers do.' },
      { name: 'Incident Response for AI', level: 'A', description: 'Detect, triage and remediate AI incidents with clear ownership and learning.' },
    ]
  },
];

// ── Operations Codex — full practice-cards deck (12 capabilities, 72 cards) ──
// Source: Nexus-OPS-Practices-Library-Cards. The rich card content
// (WHAT/WHY/HOW/WHO/SCENARIO) lives client-side in index.html (PRACTICE_CARDS);
// the DB only needs name/level/description. Added non-destructively by name.
const OPS_CAPABILITIES = [
  {
    "name": "Incident Management",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Detecting, responding to, coordinating and learning from production incidents.",
    "practices": [
      {
        "name": "Incident Severity Classification",
        "level": "F",
        "description": "A defined, shared taxonomy for classifying incident severity — P1 through P4 with explicit criteria for each level"
      },
      {
        "name": "On-Call Rotation Design",
        "level": "F",
        "description": "A structured, equitable on-call rotation that distributes the operational burden across the engineering team — nobody is permanently on-call"
      },
      {
        "name": "Incident Commander Role",
        "level": "D",
        "description": "A defined Incident Commander (IC) role for all P1 and P2 incidents — a single person who owns incident coordination, decision-making, and…"
      },
      {
        "name": "Incident Communication Templates",
        "level": "D",
        "description": "Pre-written, structured templates for all incident communication types: initial notification, status update (every 30 minutes during P1/P2), and…"
      },
      {
        "name": "Mean Time to Detect Optimisation",
        "level": "A",
        "description": "A focused programme to reduce the average time between when a problem begins and when the team first knows about it — MTTD"
      },
      {
        "name": "Game Day Exercises",
        "level": "A",
        "description": "Quarterly, planned exercises where the team simulates major incident scenarios to practise and improve their incident response capabilities in a…"
      }
    ]
  },
  {
    "name": "Continuous Monitoring",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Knowing the health of systems and services before customers do.",
    "practices": [
      {
        "name": "Health Check Endpoints",
        "level": "F",
        "description": "A standard /health endpoint (and /ready endpoint) on every service — responding with structured JSON indicating the service's operational status and…"
      },
      {
        "name": "Alert Routing and Escalation",
        "level": "F",
        "description": "A defined configuration specifying where each alert goes, who receives it, and what happens if no one acknowledges it within the defined timeframe"
      },
      {
        "name": "Capacity Monitoring",
        "level": "D",
        "description": "Continuous monitoring of infrastructure capacity utilisation against defined limits — with early warning alerts before capacity constraints affect…"
      },
      {
        "name": "Synthetic Monitoring",
        "level": "D",
        "description": "Automated tests that continuously simulate real user journeys against the production environment — verifying that critical user flows work end-to-end…"
      },
      {
        "name": "Business Metrics Monitoring",
        "level": "A",
        "description": "Monitoring and alerting on business metrics — not just system metrics — to detect incidents that are invisible to infrastructure monitoring"
      },
      {
        "name": "Observability Budget",
        "level": "A",
        "description": "An explicit, managed budget allocation for observability infrastructure — monitoring, logging, tracing, and synthetic testing — treated as a product…"
      }
    ]
  },
  {
    "name": "Change Management",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Shipping change safely and frequently with fast, low-risk approval and rollback.",
    "practices": [
      {
        "name": "Change Advisory Board (Lightweight)",
        "level": "F",
        "description": "A weekly, time-boxed (30-minute) forum for reviewing planned high-risk changes — not all changes, only those meeting defined risk criteria"
      },
      {
        "name": "Rollback Procedures",
        "level": "F",
        "description": "Documented, tested, and regularly practised rollback procedures for every production deployment type"
      },
      {
        "name": "Deployment Window Policy",
        "level": "D",
        "description": "An explicit policy defining when high-risk deployments may and may not occur — protecting the team from deployment-related incidents during high-risk…"
      },
      {
        "name": "Forward and Backward Compatibility",
        "level": "D",
        "description": "An engineering discipline ensuring that changes to APIs, data formats, and interfaces are compatible with both their predecessors (backward…"
      },
      {
        "name": "Deployment Frequency Targets",
        "level": "A",
        "description": "Explicit quarterly targets for how often each service deploys to production — set based on DORA benchmarks and current performance, increasing over…"
      },
      {
        "name": "Environment Promotion Pipeline",
        "level": "A",
        "description": "A structured, automated process for promoting code from development through staging environments to production — with defined quality gates at each…"
      }
    ]
  },
  {
    "name": "Delivery Cadence",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "A steady, predictable rhythm of planning, integrating and releasing work.",
    "practices": [
      {
        "name": "Sprint Rhythm Standardisation",
        "level": "F",
        "description": "A consistent, predictable sprint rhythm that is identical week over week — same day for planning, same day for review, same day for retrospective,…"
      },
      {
        "name": "Sprint Review Stakeholder Management",
        "level": "F",
        "description": "A structured approach to managing stakeholder participation in sprint reviews — defining who should attend, how they receive value, and how their…"
      },
      {
        "name": "Cross-Team Release Coordination",
        "level": "D",
        "description": "A structured process for coordinating releases that involve changes from multiple teams — ensuring dependencies are resolved, release sequences are…"
      },
      {
        "name": "Release Notes Practice",
        "level": "D",
        "description": "A consistent practice of producing structured release notes for every production release — targeted at different audiences (technical team, product…"
      },
      {
        "name": "Continuous Integration Cadence",
        "level": "A",
        "description": "A team norm where all engineers integrate their code into the main branch at least once per day — enabling the team to detect integration conflicts…"
      },
      {
        "name": "Trunk-Based Development",
        "level": "A",
        "description": "A version control practice where all engineers commit directly to the main branch (trunk) — or use very short-lived branches (less than 1 day) that…"
      }
    ]
  },
  {
    "name": "Service Level Management",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Defining, measuring and managing reliability against explicit objectives.",
    "practices": [
      {
        "name": "SLO Definition Workshop",
        "level": "F",
        "description": "A facilitated session where engineering and product jointly define Service Level Objectives for each critical service — connecting technical metrics…"
      },
      {
        "name": "Error Budget Policy",
        "level": "F",
        "description": "A documented policy specifying what happens when the error budget for a service is consumed at different rates — connecting reliability metrics to…"
      },
      {
        "name": "SLO Review Cadence",
        "level": "D",
        "description": "A regular, structured review of SLO performance — monthly for engineering teams, quarterly for leadership and product teams"
      },
      {
        "name": "Customer SLA Management",
        "level": "D",
        "description": "A structured process for managing commercial Service Level Agreements with enterprise customers — ensuring commitments match capabilities and…"
      },
      {
        "name": "Reliability Roadmap",
        "level": "A",
        "description": "A planned, sequenced set of reliability investments — improving SLO achievement, reducing MTTD/MTTR, and building resilience — treated as a product…"
      },
      {
        "name": "Multi-Region Reliability",
        "level": "A",
        "description": "Architecture and operational practices enabling the system to continue serving users in one geographic region when another region experiences a…"
      }
    ]
  },
  {
    "name": "Platform Operations",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Running the platform as a product — infrastructure, cost and self-service.",
    "practices": [
      {
        "name": "Infrastructure as Code Standards",
        "level": "F",
        "description": "Standards for how all infrastructure is defined, managed, and deployed as code — covering tooling, file organisation, variable management, module…"
      },
      {
        "name": "Container Orchestration Standards",
        "level": "F",
        "description": "Defined standards for deploying and managing containerised applications — covering Kubernetes configuration, resource limits, health probes, affinity…"
      },
      {
        "name": "Toil Quantification",
        "level": "D",
        "description": "A structured measurement of operational toil — the repetitive, manual work that operational teams perform that provides no enduring value"
      },
      {
        "name": "Cost Optimisation Programme",
        "level": "D",
        "description": "A structured, ongoing programme to identify and implement cloud infrastructure cost optimisation opportunities — running quarterly"
      },
      {
        "name": "Platform Self-Service Expansion",
        "level": "A",
        "description": "A continuous programme to expand the set of capabilities stream-aligned teams can self-serve from the internal developer platform — reducing their…"
      },
      {
        "name": "GitOps Implementation",
        "level": "A",
        "description": "A deployment model where the entire desired state of the system — application configuration, infrastructure, and Kubernetes manifests — is declared…"
      }
    ]
  },
  {
    "name": "Knowledge Management",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Capturing and sharing operational knowledge so it outlives any individual.",
    "practices": [
      {
        "name": "Runbook Standards",
        "level": "F",
        "description": "A defined standard for how all operational runbooks are structured, maintained, and tested — ensuring they are usable under pressure by any engineer,…"
      },
      {
        "name": "Architecture Documentation",
        "level": "F",
        "description": "Living documentation that captures the architecture of each service and the system as a whole — maintained alongside the code, not as a separate…"
      },
      {
        "name": "Post-Incident Knowledge Capture",
        "level": "D",
        "description": "A structured process for capturing and distributing the knowledge generated in every significant incident — ensuring the learning benefits the whole…"
      },
      {
        "name": "Onboarding Documentation",
        "level": "D",
        "description": "Comprehensive, maintained documentation specifically designed for engineers joining the team — enabling them to become productive contributors within…"
      },
      {
        "name": "Engineering Wiki Governance",
        "level": "A",
        "description": "A structured governance model for the engineering wiki — defining who creates content, how it is reviewed, how it is kept current, and when it is…"
      },
      {
        "name": "Technical Writing Investment",
        "level": "A",
        "description": "A deliberate investment in the quality of engineering documentation — treating technical writing as a professional discipline, not an administrative…"
      }
    ]
  },
  {
    "name": "Continuous Improvement",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Systematically removing waste and turning learning into measurable improvement.",
    "practices": [
      {
        "name": "Kaizen Culture",
        "level": "F",
        "description": "A team-wide commitment to continuous, incremental improvement — every team member regularly identifies and acts on small improvement opportunities…"
      },
      {
        "name": "Retrospective Action Tracking",
        "level": "F",
        "description": "A disciplined process for tracking, reviewing, and closing retrospective action items — ensuring retrospectives produce lasting change, not just good…"
      },
      {
        "name": "Improvement Backlog Management",
        "level": "D",
        "description": "A separate, visible backlog dedicated to technical and process improvement items — maintained alongside (but distinct from) the feature and bug…"
      },
      {
        "name": "Learning from Incidents Programme",
        "level": "D",
        "description": "A structured programme that converts incident learnings into operational improvements — treating incidents as the richest source of operational…"
      },
      {
        "name": "DORA Metrics Programme",
        "level": "A",
        "description": "A structured programme measuring the four DORA metrics (Deployment Frequency, Lead Time for Changes, Change Failure Rate, and Mean Time to Restore) —…"
      },
      {
        "name": "Engineering Effectiveness Review",
        "level": "A",
        "description": "A quarterly structured review of overall engineering effectiveness — examining DORA metrics, technical health metrics, team health metrics, and…"
      }
    ]
  },
  {
    "name": "Capacity Planning",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Anticipating demand and scaling capacity ahead of need, cost-effectively.",
    "practices": [
      {
        "name": "Traffic Pattern Analysis",
        "level": "F",
        "description": "A regular analysis of production traffic patterns — understanding how demand varies by time of day, day of week, seasonal events, and product release…"
      },
      {
        "name": "Load Testing Cadence",
        "level": "F",
        "description": "Regularly scheduled load tests — run before every major release and at least quarterly against the current production system — verifying that the…"
      },
      {
        "name": "Capacity Forecasting Model",
        "level": "D",
        "description": "A quantitative model that forecasts infrastructure capacity requirements 6–12 months ahead — based on traffic growth trends, planned product changes,…"
      },
      {
        "name": "Cost vs Performance Trade-off Analysis",
        "level": "D",
        "description": "A structured analytical approach to making informed decisions about infrastructure investment — evaluating the cost of capacity vs the performance…"
      },
      {
        "name": "Predictive Auto-Scaling",
        "level": "A",
        "description": "Auto-scaling that acts before traffic arrives — using scheduled scaling (based on known traffic patterns) and predictive scaling (using ML models to…"
      },
      {
        "name": "Infrastructure Chaos Testing",
        "level": "A",
        "description": "Structured, planned experiments that test infrastructure resilience by intentionally creating infrastructure failure scenarios — verifying that the…"
      }
    ]
  },
  {
    "name": "Release Management",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Coordinating, de-risking and measuring how software reaches production.",
    "practices": [
      {
        "name": "Release Checklist",
        "level": "F",
        "description": "A standard, mandatory checklist completed before every production release — ensuring all required steps are verified, not assumed"
      },
      {
        "name": "Release Candidate Process",
        "level": "F",
        "description": "A defined process for creating and validating Release Candidates (RCs) — specific software versions that have passed all quality gates and are…"
      },
      {
        "name": "Release Impact Assessment",
        "level": "D",
        "description": "A structured analysis of the potential impact of a planned release — examining risk, affected systems, customer impact, and mitigation strategies…"
      },
      {
        "name": "Hotfix Process",
        "level": "D",
        "description": "A defined, streamlined process for deploying urgent fixes to production outside the normal release cadence — with explicit criteria for when the…"
      },
      {
        "name": "Zero-Downtime Migration Strategy",
        "level": "A",
        "description": "A comprehensive strategy for executing major system migrations (database migrations, major version upgrades, infrastructure changes) with no…"
      },
      {
        "name": "Release Metrics Programme",
        "level": "A",
        "description": "A comprehensive set of release metrics that track the effectiveness, safety, and efficiency of the release process — measured continuously and…"
      }
    ]
  },
  {
    "name": "Reliability Engineering",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Engineering for resilience, error budgets and reliability as a first-class goal.",
    "practices": [
      {
        "name": "Reliability Baseline Assessment",
        "level": "F",
        "description": "An initial comprehensive assessment of the current reliability posture — measuring MTTD, MTTR, incident frequency, SLO achievement, and change…"
      },
      {
        "name": "Blameless Post-Incident Reviews",
        "level": "F",
        "description": "Every significant incident (P1 and P2) triggers a structured blameless review within 72 hours — no exceptions"
      },
      {
        "name": "Error Budget Management",
        "level": "D",
        "description": "A structured practice of tracking, managing, and acting on error budget consumption — using the error budget as the primary mechanism for balancing…"
      },
      {
        "name": "Chaos Engineering Practice",
        "level": "D",
        "description": "The disciplined practice of intentionally introducing controlled failures into the production system to identify weaknesses before they cause…"
      },
      {
        "name": "Reliability OKRs",
        "level": "A",
        "description": "OKRs set specifically for reliability metrics — elevating reliability to the same strategic importance as feature delivery and business outcomes"
      },
      {
        "name": "SRE Embedded Model",
        "level": "A",
        "description": "A deployment model where SRE expertise is embedded directly within delivery teams — not centralised in a separate SRE team that acts as a shared…"
      }
    ]
  },
  {
    "name": "DORA Excellence",
    "domain": "Operations",
    "source": "Nexus Codex · Operations",
    "description": "Driving elite delivery performance using the four DORA metrics.",
    "practices": [
      {
        "name": "DORA Metrics Baseline",
        "level": "F",
        "description": "An initial measurement of all four DORA metrics (Deployment Frequency, Lead Time for Changes, Change Failure Rate, and Mean Time to Restore) —…"
      },
      {
        "name": "DORA Improvement Planning",
        "level": "F",
        "description": "A structured process for translating DORA metric baselines into actionable improvement plans — identifying the specific practices and investments…"
      },
      {
        "name": "Deployment Frequency Programme",
        "level": "D",
        "description": "A focused, time-boxed programme to remove all blockers to increasing deployment frequency — treating deployment frequency as a product capability,…"
      },
      {
        "name": "Lead Time Reduction Programme",
        "level": "D",
        "description": "A structured programme to reduce the time from a commit entering the codebase to it being available in production — targeting the DORA Lead Time for…"
      },
      {
        "name": "Elite DORA Target Programme",
        "level": "A",
        "description": "A sustained programme targeting Elite DORA performance across all four metrics — maintained as an ongoing engineering excellence commitment, not a…"
      },
      {
        "name": "DORA Culture Programme",
        "level": "A",
        "description": "A programme to embed DORA thinking — the four metrics, their causal relationships, and their business implications — into the culture of the…"
      }
    ]
  }
];

// ── Technology & Architecture Codex — full deck (9 capabilities, 54 cards) ──
const TA_CAPABILITIES = [
  {
    "name": "Architecture Vision",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "A shared, evolving architectural direction that guides decisions without over-constraining teams.",
    "practices": [
      {
        "name": "Architecture Decision Records",
        "level": "F",
        "description": "Short, structured documents capturing every significant architecture decision: context, options considered, decision made, and consequences"
      },
      {
        "name": "Architecture Principles",
        "level": "F",
        "description": "A concise set of 6–10 guiding principles that shape all technical decisions — expressing the non-negotiable technical values of the organisation"
      },
      {
        "name": "Architecture Fitness Functions",
        "level": "D",
        "description": "Automated tests that continuously verify the system's compliance with architectural principles and non-functional requirements"
      },
      {
        "name": "Technical Radar",
        "level": "D",
        "description": "A visual, opinionated tool that categorises technologies, tools, platforms, and languages into four rings: Adopt (use in new work), Trial (experiment…"
      },
      {
        "name": "Architecture Runway",
        "level": "A",
        "description": "A buffer of architectural enablers — infrastructure, platform capabilities, and structural improvements — that exist ahead of feature delivery needs,…"
      },
      {
        "name": "Evolutionary Architecture Practice",
        "level": "A",
        "description": "A disciplined approach to making architectural changes incrementally and continuously — rather than in periodic big-bang redesign efforts"
      }
    ]
  },
  {
    "name": "Loose Coupling",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "Designing systems whose parts can change independently, reducing blast radius and coordination.",
    "practices": [
      {
        "name": "Service Interface Contracts",
        "level": "F",
        "description": "Explicit, versioned API contracts defining the interface between services — specifying inputs, outputs, error formats, and versioning semantics"
      },
      {
        "name": "Dependency Inversion Training",
        "level": "F",
        "description": "A structured training programme teaching all engineers the principles of dependency inversion and loose coupling — not just the theoretical principle…"
      },
      {
        "name": "Event-Driven Decoupling",
        "level": "D",
        "description": "An architectural pattern where services communicate through events (messages) on a shared event bus rather than through synchronous direct API calls"
      },
      {
        "name": "Contract Testing",
        "level": "D",
        "description": "Automated tests that verify service interface contracts are honoured by both the providing and consuming sides — without requiring both services to…"
      },
      {
        "name": "Domain-Driven Design Application",
        "level": "A",
        "description": "The practice of modelling software systems around the business domain — using a shared language (Ubiquitous Language) between technical and…"
      },
      {
        "name": "Dependency Analysis Tooling",
        "level": "A",
        "description": "Automated tooling that continuously maps, visualises, and scores the dependency relationships within and between services — producing a dependency…"
      }
    ]
  },
  {
    "name": "Platform Thinking",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "Treating internal platforms as products that give teams paved, self-service paths.",
    "practices": [
      {
        "name": "Internal Developer Platform Definition",
        "level": "F",
        "description": "A clearly defined scope and mission statement for the internal developer platform: what capabilities it provides, what it does not provide, and what…"
      },
      {
        "name": "Platform Onboarding Docs",
        "level": "F",
        "description": "Comprehensive, maintained documentation enabling any engineer to self-serve platform capabilities without needing to ask the platform team"
      },
      {
        "name": "Platform as a Product",
        "level": "D",
        "description": "Managing the internal developer platform using the same product thinking applied to external products: user research with engineers, product roadmap,…"
      },
      {
        "name": "Developer Experience Metrics",
        "level": "D",
        "description": "A set of metrics measuring the experience of engineers using the platform and internal tooling — quantifying friction, frustration, and…"
      },
      {
        "name": "Golden Path Definition",
        "level": "A",
        "description": "The explicitly designed and supported 'paved road' for the most common development patterns — the path of least resistance that also reflects best…"
      },
      {
        "name": "Platform Health Scorecard",
        "level": "A",
        "description": "A structured quarterly assessment of platform health across 5–7 dimensions: reliability, performance, usability, adoption, security, documentation…"
      }
    ]
  },
  {
    "name": "Security Engineering",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "Building security into how software is designed, built and shipped — not bolted on.",
    "practices": [
      {
        "name": "Security in Definition of Done",
        "level": "F",
        "description": "Explicit security criteria embedded in the team's Definition of Done — required for every story, not just 'security stories'"
      },
      {
        "name": "Dependency Vulnerability Scanning",
        "level": "F",
        "description": "Automated scanning of all third-party dependencies for known vulnerabilities — run on every build and on a daily schedule against current production…"
      },
      {
        "name": "Threat Modelling",
        "level": "D",
        "description": "A structured analysis process that identifies and prioritises security threats to a system before building or deploying it — not after"
      },
      {
        "name": "Security Champion Programme",
        "level": "D",
        "description": "A network of engineers — one per team — who receive additional security training and serve as the first point of security contact within their team"
      },
      {
        "name": "Continuous Security Scanning",
        "level": "A",
        "description": "A comprehensive, automated security scanning system running continuously across the full software supply chain — from developer workstation to…"
      },
      {
        "name": "Incident Response Playbook",
        "level": "A",
        "description": "A documented, practised response plan for each category of security incident — specifying roles, actions, escalation paths, communication protocols,…"
      }
    ]
  },
  {
    "name": "Cloud Native Practices",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "Engineering for the cloud — containers, automation, resilience and elasticity by default.",
    "practices": [
      {
        "name": "12-Factor App Standards",
        "level": "F",
        "description": "A set of 12 engineering principles for building cloud-native applications that are portable, scalable, and maintainable"
      },
      {
        "name": "Container Standards",
        "level": "F",
        "description": "Defined standards for building and maintaining container images: base image policy, layer caching, security scanning, image tagging, and registry…"
      },
      {
        "name": "Auto-Scaling Configuration",
        "level": "D",
        "description": "Configured and tested automatic scaling policies for all production services — scaling up when demand exceeds capacity, scaling down when demand drops"
      },
      {
        "name": "Cost Attribution Dashboard",
        "level": "D",
        "description": "A real-time dashboard showing cloud infrastructure cost broken down by service, team, environment, and resource type"
      },
      {
        "name": "FinOps Practice",
        "level": "A",
        "description": "A cross-functional practice (Engineering + Finance + Product) that manages cloud spend as a business metric — not purely a technical concern"
      },
      {
        "name": "Site Reliability Engineering",
        "level": "A",
        "description": "A practice discipline that applies software engineering principles to infrastructure and operations — replacing manual operations work with…"
      }
    ]
  },
  {
    "name": "Observability",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "Making systems understandable in production through metrics, logs and traces.",
    "practices": [
      {
        "name": "Structured Logging Standard",
        "level": "F",
        "description": "A team-wide standard for how all application logs are formatted — using structured (JSON) format with mandatory fields: timestamp, service name, log…"
      },
      {
        "name": "Metric Instrumentation Standards",
        "level": "F",
        "description": "A standard for how all services instrument and expose metrics — using a consistent format (Prometheus metrics), naming convention, and mandatory…"
      },
      {
        "name": "Distributed Tracing Implementation",
        "level": "D",
        "description": "End-to-end tracing of requests as they flow through multiple services — using a distributed tracing system (Jaeger, Zipkin, AWS X-Ray, Datadog APM)"
      },
      {
        "name": "SLO Dashboard",
        "level": "D",
        "description": "A real-time dashboard displaying Service Level Objectives (SLOs) and Error Budgets for all production services — the primary operational health view…"
      },
      {
        "name": "Observability-Driven Development",
        "level": "A",
        "description": "A development practice where instrumentation is added before or alongside feature code — not as an afterthought after deployment"
      },
      {
        "name": "Runbook Automation",
        "level": "A",
        "description": "The progressive automation of operational runbooks — converting manual, step-by-step response procedures into automated scripts or workflows"
      }
    ]
  },
  {
    "name": "Technical Debt Management",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "Making technical debt visible, prioritised and deliberately paid down.",
    "practices": [
      {
        "name": "Technical Debt Register",
        "level": "F",
        "description": "A visible, maintained catalogue of all known technical debt items — classified by type, impact, effort to resolve, and priority"
      },
      {
        "name": "Boy Scout Rule Adoption",
        "level": "F",
        "description": "A team norm where every engineer, on every PR, makes the code they touch slightly better than they found it — refactoring one small thing per PR as a…"
      },
      {
        "name": "Debt Prioritisation Framework",
        "level": "D",
        "description": "A structured method for comparing and prioritising technical debt items against each other and against feature work — using consistent criteria"
      },
      {
        "name": "Architecture Review Board (Lightweight)",
        "level": "D",
        "description": "A lightweight, low-overhead forum for reviewing and approving significant architectural decisions — meeting bi-weekly for 60 minutes maximum"
      },
      {
        "name": "Incremental Modernisation",
        "level": "A",
        "description": "A structured approach to modernising legacy systems incrementally — replacing them piece by piece while maintaining production operation, rather than…"
      },
      {
        "name": "Technical Health OKRs",
        "level": "A",
        "description": "OKRs set specifically for technical health metrics — elevating technical quality to the same strategic importance as feature delivery and business…"
      }
    ]
  },
  {
    "name": "Infrastructure As Code",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "Defining and evolving infrastructure declaratively, versioned and automated.",
    "practices": [
      {
        "name": "Everything-in-VCS Policy",
        "level": "F",
        "description": "An explicit policy that ALL production-relevant artefacts must be version controlled: application code, infrastructure definitions, configuration…"
      },
      {
        "name": "Terraform Standards",
        "level": "F",
        "description": "Defined standards for how all infrastructure is coded in Terraform (or equivalent IaC tool): module structure, state management, variable naming,…"
      },
      {
        "name": "GitOps Implementation",
        "level": "D",
        "description": "A deployment model where the entire desired state of the system — application configuration, infrastructure, and Kubernetes manifests — is declared…"
      },
      {
        "name": "Infrastructure Drift Detection",
        "level": "D",
        "description": "Automated monitoring that continuously compares the declared infrastructure state (in version control) with the actual running state — and alerts…"
      },
      {
        "name": "Immutable Infrastructure",
        "level": "A",
        "description": "An infrastructure design principle where servers and containers are never modified after deployment — they are replaced with new versions rather than…"
      },
      {
        "name": "Platform Self-Service Expansion",
        "level": "A",
        "description": "A continuous programme to expand the set of capabilities stream-aligned teams can self-serve from the internal developer platform — reducing their…"
      }
    ]
  },
  {
    "name": "Database Reliability",
    "domain": "Technology & Architecture",
    "source": "Nexus Codex · Technology & Architecture",
    "description": "Operating data stores for performance, safe change and dependable recovery.",
    "practices": [
      {
        "name": "Database Migration Standards",
        "level": "F",
        "description": "Explicit standards for how database schema changes are managed, reviewed, and deployed — making schema changes as safe and repeatable as application…"
      },
      {
        "name": "Query Performance Review",
        "level": "F",
        "description": "A monthly practice of reviewing the 10 slowest queries in each production database — identifying candidates for optimisation"
      },
      {
        "name": "Backup and Recovery Testing",
        "level": "D",
        "description": "A documented, regularly tested backup and recovery procedure — verified quarterly by actually restoring a production backup to a recovery environment"
      },
      {
        "name": "Database Observability",
        "level": "D",
        "description": "Comprehensive monitoring of database health: connection pool utilisation, query throughput, replication lag, lock contention, table bloat, index…"
      },
      {
        "name": "Zero-Downtime Schema Changes",
        "level": "A",
        "description": "An engineering practice ensuring all database schema changes can be deployed to production without any service interruption — even for tables with…"
      },
      {
        "name": "Read Replica Strategy",
        "level": "A",
        "description": "A deliberate strategy for distributing database read load across read replicas — routing read-heavy queries away from the primary database"
      }
    ]
  }
];

// ── Product & Delivery Codex — full deck (14 capabilities, 84 cards) ──
const PD_CAPABILITIES = [
  {
    "name": "Delivery Capacity Planning",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Measuring and planning delivery against the team's actual capacity — the ratio of available hours in a work cycle to the work produced — and committing to backlog items within that constraint.",
    "practices": [
      {
        "name": "Capacity Ratio Baseline",
        "level": "F",
        "description": "Measure real delivery capacity as the ratio of available hours in a work cycle to the work actually produced — establishing throughput (backlog items completed per available hour) as the empirical baseline for planning, rather than estimating effort task by task."
      },
      {
        "name": "Backlog-Constrained Capacity Planning",
        "level": "D",
        "description": "Plan each cycle by pulling backlog work items up to the limit of available hours — treating hours as the constraint (the time the team actually has), not the unit of estimation — so commitments reflect demonstrated throughput instead of optimistic per-task effort estimates."
      }
    ]
  },
  {
    "name": "Flow Optimization",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Flow Optimization — product & delivery practices.",
    "practices": [
      {
        "name": "Flow Visualisation Board",
        "level": "F",
        "description": "A visual board (physical or digital) showing all work items in the team's system and their current state"
      },
      {
        "name": "WIP Limits per Stage",
        "level": "F",
        "description": "Explicit limits on how many work items can be in each workflow stage simultaneously"
      },
      {
        "name": "Bottleneck Identification",
        "level": "D",
        "description": "A systematic practice of identifying the slowest or most constrained stage in the team's workflow — the stage that limits the throughput of the…"
      },
      {
        "name": "Flow Metrics Dashboard",
        "level": "D",
        "description": "A real-time digital dashboard displaying the team's key flow metrics: lead time, cycle time, throughput, WIP levels, and flow efficiency"
      },
      {
        "name": "Waste Elimination Sprints",
        "level": "A",
        "description": "Dedicated sprint cycles (or partial sprints) where the team focuses entirely on identifying and eliminating waste in their delivery process — not on…"
      },
      {
        "name": "Automated Flow Analytics",
        "level": "A",
        "description": "A fully automated flow analytics system that continuously monitors the delivery process — identifying bottlenecks, predicting delivery dates, and…"
      }
    ]
  },
  {
    "name": "Feedback Loops",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Feedback Loops — product & delivery practices.",
    "practices": [
      {
        "name": "Production Monitoring Alerts",
        "level": "F",
        "description": "A set of automated alerts that notify the team immediately when production systems behave outside defined parameters — before customers report the…"
      },
      {
        "name": "Weekly Usability Testing",
        "level": "F",
        "description": "A structured practice of conducting at least one usability test per week with a real user — not a quarterly research project, a continuous rhythm"
      },
      {
        "name": "Feature Flag Rollouts",
        "level": "D",
        "description": "A deployment practice where new features are deployed to production behind a feature flag — initially invisible to users, then progressively exposed…"
      },
      {
        "name": "Build–Measure–Learn Cycle",
        "level": "D",
        "description": "A structured iteration loop where every feature or experiment follows the same 3-phase cycle: Build (the minimum version), Measure (against…"
      },
      {
        "name": "Internal Alpha Programme",
        "level": "A",
        "description": "A structured programme where new features are first deployed to internal employees — not external customers — to identify critical issues before…"
      },
      {
        "name": "Automated Anomaly Detection",
        "level": "A",
        "description": "Machine learning or statistical models embedded in the monitoring stack that automatically identify unusual patterns in system behaviour — without…"
      }
    ]
  },
  {
    "name": "Cycle Time Management",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Cycle Time Management — product & delivery practices.",
    "practices": [
      {
        "name": "Cycle Time Baseline",
        "level": "F",
        "description": "An initial measurement of how long work items take from 'started' to 'done' — establishing the baseline before any improvement effort begins"
      },
      {
        "name": "Cycle Time Targets",
        "level": "F",
        "description": "Explicit, team-agreed targets for cycle time by work item type — specific enough to be actionable, ambitious enough to require improvement"
      },
      {
        "name": "Cumulative Flow Diagrams",
        "level": "D",
        "description": "A chart displaying the count of work items in each workflow stage over time — showing flow, WIP levels, and lead time visually in a single view"
      },
      {
        "name": "Handoff Reduction",
        "level": "D",
        "description": "A systematic effort to identify and eliminate unnecessary handoffs in the delivery process — stages where work moves from one person, team, or system…"
      },
      {
        "name": "Cycle Time Retrospectives",
        "level": "A",
        "description": "A structured retrospective format focused specifically on cycle time performance — analysing the previous sprint's cycle time distribution and…"
      },
      {
        "name": "Per-Story Cycle Time SLAs",
        "level": "A",
        "description": "Explicit service level agreements attached to specific story types or categories — customers or stakeholders know the maximum time a specific type of…"
      }
    ]
  },
  {
    "name": "Team Topology",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Team Topology — product & delivery practices.",
    "practices": [
      {
        "name": "Team Type Classification",
        "level": "F",
        "description": "Explicitly classifying each team against the four Team Topologies types: Stream-Aligned, Platform, Enabling, or Complicated-Subsystem"
      },
      {
        "name": "Cognitive Load Assessment",
        "level": "F",
        "description": "A structured assessment of the cognitive load each team carries — the total complexity of the systems, domains, and interactions they are responsible…"
      },
      {
        "name": "Interaction Mode Definition",
        "level": "D",
        "description": "For each pair of teams that interact, an explicit definition of the interaction mode: Collaboration (working closely together for a defined period),…"
      },
      {
        "name": "Conway's Law Audit",
        "level": "D",
        "description": "A structured audit examining whether the organisation's team structure mirrors (and therefore constrains) its software architecture — Conway's Law:…"
      },
      {
        "name": "Team Topology Roadmap",
        "level": "A",
        "description": "A planned, phased evolution of the organisation's team topology over 12–18 months — specifying the target topology, the transition states, and the…"
      },
      {
        "name": "Thinnest Viable Platform",
        "level": "A",
        "description": "A design principle for platform teams: build and maintain only the platform capabilities that stream-aligned teams actually need and cannot easily…"
      }
    ]
  },
  {
    "name": "Experimentation",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Experimentation — product & delivery practices.",
    "practices": [
      {
        "name": "Experiment Hypothesis Template",
        "level": "F",
        "description": "A structured one-page template for defining any experiment before it is built — containing: hypothesis statement, key assumption, build specification…"
      },
      {
        "name": "Safe-to-Fail Sandbox",
        "level": "F",
        "description": "A designated environment (technical, organisational, and cultural) where experiments can be tried without the risk of production impact, political…"
      },
      {
        "name": "Experiment Velocity Tracking",
        "level": "D",
        "description": "A metric tracking how many experiments the team runs per sprint/month — measuring the organisation's rate of validated learning, not just its rate of…"
      },
      {
        "name": "Experiment Retrospectives",
        "level": "D",
        "description": "A structured retrospective format dedicated to reviewing the quality and outcomes of experiments run in the previous quarter — distinct from sprint…"
      },
      {
        "name": "A/B Testing Infrastructure",
        "level": "A",
        "description": "A fully automated, self-service system enabling any team member to create and run A/B tests in production without requiring engineering intervention…"
      },
      {
        "name": "Celebrating Failed Experiments",
        "level": "A",
        "description": "A deliberate, recurring practice of publicly recognising and celebrating experiments that refuted their hypothesis — treating a 'no' answer as equal…"
      }
    ]
  },
  {
    "name": "Continuous Delivery",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Continuous Delivery — product & delivery practices.",
    "practices": [
      {
        "name": "Deployment Pipeline Baseline",
        "level": "F",
        "description": "An initial measurement of the current deployment pipeline: how long it takes, how often it is run, what stages exist, its reliability (pass rate),…"
      },
      {
        "name": "Sprint-Cadence Releases",
        "level": "F",
        "description": "The practice of releasing to production at the end of every sprint — creating a predictable release cadence aligned to the delivery rhythm"
      },
      {
        "name": "Blue/Green Deployments",
        "level": "D",
        "description": "A deployment pattern maintaining two identical production environments (Blue and Green) — only one serves live traffic at any time"
      },
      {
        "name": "Deployment Frequency Metric",
        "level": "D",
        "description": "A tracked metric measuring how often the team deploys to production — expressed as deploys per day, week, or month"
      },
      {
        "name": "Change Failure Rate Reduction",
        "level": "A",
        "description": "A focused improvement programme targeting the percentage of deployments that cause a degradation in service requiring a hotfix, rollback, or forward…"
      },
      {
        "name": "Chaos Engineering Practice",
        "level": "A",
        "description": "The disciplined practice of intentionally introducing controlled failures into the production system to identify weaknesses before they cause…"
      }
    ]
  },
  {
    "name": "Quality Practices",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Quality Practices — product & delivery practices.",
    "practices": [
      {
        "name": "Test Pyramid Implementation",
        "level": "F",
        "description": "A testing strategy structuring tests in three layers: many fast unit tests at the base, fewer integration tests in the middle, and few slow…"
      },
      {
        "name": "Definition of Done with Quality",
        "level": "F",
        "description": "An explicit team agreement specifying what 'done' means for a story — including specific quality criteria that must be met before the story can be…"
      },
      {
        "name": "Code Review Standards",
        "level": "D",
        "description": "A published, team-agreed set of standards for what a code review should examine and how it should be conducted"
      },
      {
        "name": "Defect Escape Rate Tracking",
        "level": "D",
        "description": "A metric measuring the percentage of defects discovered in production vs total defects discovered (production + testing)"
      },
      {
        "name": "Pair and Mob Programming",
        "level": "A",
        "description": "Pair programming: two developers work on the same code at the same time — one 'driver' types, one 'navigator' reviews and guides; roles rotate…"
      },
      {
        "name": "Quality Engineering Culture",
        "level": "A",
        "description": "A team-wide culture where quality is everyone's responsibility — not the sole domain of QA engineers or code reviewers"
      }
    ]
  },
  {
    "name": "Roadmap Management",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Roadmap Management — product & delivery practices.",
    "practices": [
      {
        "name": "Now/Next/Later Format",
        "level": "F",
        "description": "A simple three-column roadmap format: Now (current sprint or quarter — committed), Next (following sprint or quarter — directional), Later (beyond…"
      },
      {
        "name": "Monthly Roadmap Reviews",
        "level": "F",
        "description": "A structured monthly session where the Product Owner reviews the roadmap with all key stakeholders — not to report progress, but to update direction…"
      },
      {
        "name": "Assumption Mapping",
        "level": "D",
        "description": "A facilitated workshop technique for surfacing and prioritising the assumptions underlying a product, feature, or initiative — distinguishing between…"
      },
      {
        "name": "Dependency Visibility",
        "level": "D",
        "description": "A practice of making all cross-team and cross-system dependencies visible in the roadmap and sprint planning tools — not just internal work items"
      },
      {
        "name": "Roadmap Retrospectives",
        "level": "A",
        "description": "A quarterly retrospective examining the quality of the team's roadmap — not sprint execution, but the quality of the roadmap itself as a planning and…"
      },
      {
        "name": "Outcome-Based Roadmap",
        "level": "A",
        "description": "A roadmap structured around outcomes the product team is trying to achieve — not around features they plan to ship"
      }
    ]
  },
  {
    "name": "Version Control",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Version Control — product & delivery practices.",
    "practices": [
      {
        "name": "Everything-in-VCS Policy",
        "level": "F",
        "description": "An explicit policy that ALL production-relevant artefacts must be version controlled: application code, infrastructure definitions, configuration…"
      },
      {
        "name": "Branch Protection Rules",
        "level": "F",
        "description": "Automated rules enforced by the version control system that prevent direct commits to protected branches (main, production) without passing defined…"
      },
      {
        "name": "Config Separation from Code",
        "level": "D",
        "description": "A design and deployment principle where all configuration that varies between environments (database connection strings, API endpoints, feature…"
      },
      {
        "name": "Infrastructure as Code",
        "level": "D",
        "description": "The practice of managing and provisioning infrastructure through machine-readable definition files in version control — not through manual…"
      },
      {
        "name": "Trunk-Based Development",
        "level": "A",
        "description": "A version control practice where all engineers commit directly to the main branch (trunk) — or use very short-lived branches (less than 1 day) that…"
      },
      {
        "name": "Continuous Integration Cadence",
        "level": "A",
        "description": "A team norm where all engineers integrate their code into the main branch at least once per day — enabling the team to detect integration conflicts…"
      }
    ]
  },
  {
    "name": "Continuous Integration",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Continuous Integration — product & delivery practices.",
    "practices": [
      {
        "name": "CI Pipeline Standards",
        "level": "F",
        "description": "Defined standards for how all CI pipelines are structured, what quality gates they include, and what 'passing' means for a pipeline run"
      },
      {
        "name": "Build Failure Response Protocol",
        "level": "F",
        "description": "A defined team norm specifying how quickly and how a broken CI build must be addressed — making build health a shared team responsibility"
      },
      {
        "name": "Test Parallelisation",
        "level": "D",
        "description": "A technique for running test suites faster by splitting them across multiple parallel execution workers — reducing total feedback time without…"
      },
      {
        "name": "Pipeline as Code",
        "level": "D",
        "description": "CI/CD pipeline configuration stored in version control as code — not configured through web UIs that have no audit trail"
      },
      {
        "name": "Flaky Test Management",
        "level": "A",
        "description": "A systematic programme to identify, track, quarantine, and eliminate tests that fail intermittently without code changes — 'flaky tests'"
      },
      {
        "name": "Pipeline Performance OKRs",
        "level": "A",
        "description": "Explicit quarterly OKRs set for CI/CD pipeline performance — elevating pipeline health to the same strategic importance as product feature delivery"
      }
    ]
  },
  {
    "name": "Test Automation",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Test Automation — product & delivery practices.",
    "practices": [
      {
        "name": "Automated Test Coverage Baseline",
        "level": "F",
        "description": "An initial measurement of the current state of automated test coverage across the codebase — establishing the baseline before any investment in…"
      },
      {
        "name": "Test-First Development Norm",
        "level": "F",
        "description": "A team norm where automated tests are written before or alongside production code — not as a retrospective afterthought"
      },
      {
        "name": "Contract Testing",
        "level": "D",
        "description": "Automated tests that verify service interface contracts are honoured by both the providing and consuming sides — without requiring both services to…"
      },
      {
        "name": "End-to-End Test Strategy",
        "level": "D",
        "description": "A defined strategy for how end-to-end tests are scoped, written, maintained, and managed — preventing the E2E test sprawl that slows pipelines and…"
      },
      {
        "name": "Test Impact Analysis",
        "level": "A",
        "description": "A technique that identifies which tests are affected by a specific code change — and runs only those tests, rather than the full suite, for fast…"
      },
      {
        "name": "Testing Knowledge Sharing",
        "level": "A",
        "description": "A structured programme for spreading testing skills and knowledge across the engineering team — treating testing as a professional discipline that…"
      }
    ]
  },
  {
    "name": "Deployment Patterns",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Techniques for releasing change safely and frequently — blue-green, canary, feature flags.",
    "practices": [
      {
        "name": "Deployment Runbook",
        "level": "F",
        "description": "A documented, step-by-step procedure for every production deployment type — covering: pre-deployment checklist, deployment steps, post-deployment…"
      },
      {
        "name": "Canary Deployment Pattern",
        "level": "F",
        "description": "A deployment practice that routes a small percentage of production traffic (1–5%) to the new version before rolling it out to all users"
      },
      {
        "name": "Deployment Frequency Optimisation",
        "level": "D",
        "description": "A structured programme to remove blockers to increasing deployment frequency — identifying and eliminating the processes, gates, and cultural factors…"
      },
      {
        "name": "Environment Parity",
        "level": "D",
        "description": "The engineering discipline of maintaining staging and development environments that are as close to production as possible — same infrastructure,…"
      },
      {
        "name": "Progressive Delivery Framework",
        "level": "A",
        "description": "A comprehensive framework combining multiple deployment risk-reduction techniques: feature flags, canary deployments, A/B testing, and dark launches…"
      },
      {
        "name": "Deployment Analytics",
        "level": "A",
        "description": "A comprehensive analytics system that collects, aggregates, and surfaces insights from every deployment — enabling data-driven decisions about…"
      }
    ]
  },
  {
    "name": "Loosely Coupled Architecture",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Designing components that change independently to enable autonomous, fast delivery.",
    "practices": [
      {
        "name": "Service Interface Contracts",
        "level": "F",
        "description": "Explicit, versioned API contracts defining the interface between services — specifying inputs, outputs, error formats, and versioning semantics"
      },
      {
        "name": "Dependency Analysis Baseline",
        "level": "F",
        "description": "An initial analysis of the current inter-service and inter-module dependency structure — establishing what is tightly coupled before designing any…"
      },
      {
        "name": "Event-Driven Decoupling",
        "level": "D",
        "description": "An architectural pattern where services communicate through events (messages) on a shared event bus rather than through synchronous direct API calls"
      },
      {
        "name": "Architecture Fitness Functions",
        "level": "D",
        "description": "Automated tests that continuously verify the system's compliance with architectural principles and non-functional requirements"
      },
      {
        "name": "Domain-Driven Design Application",
        "level": "A",
        "description": "The practice of modelling software systems around the business domain — using a shared language (Ubiquitous Language) between technical and…"
      },
      {
        "name": "Evolutionary Architecture Practice",
        "level": "A",
        "description": "A disciplined approach to making architectural changes incrementally and continuously — rather than in periodic big-bang redesign efforts"
      }
    ]
  },
  {
    "name": "Monitoring & Observability",
    "domain": "Product & Delivery",
    "source": "Nexus Codex · Product & Delivery",
    "description": "Seeing system and delivery health in production to act before customers feel it.",
    "practices": [
      {
        "name": "Structured Logging Standard",
        "level": "F",
        "description": "A team-wide standard for how all application logs are formatted — using structured (JSON) format with mandatory fields: timestamp, service name, log…"
      },
      {
        "name": "Metric Instrumentation Standards",
        "level": "F",
        "description": "A standard for how all services instrument and expose metrics — using a consistent format (Prometheus metrics), naming convention, and mandatory…"
      },
      {
        "name": "Distributed Tracing Implementation",
        "level": "D",
        "description": "End-to-end tracing of requests as they flow through multiple services — using a distributed tracing system (Jaeger, Zipkin, AWS X-Ray, Datadog APM)"
      },
      {
        "name": "SLO Dashboard",
        "level": "D",
        "description": "A real-time dashboard displaying Service Level Objectives (SLOs) and Error Budgets for all production services — the primary operational health view…"
      },
      {
        "name": "Observability-Driven Development",
        "level": "A",
        "description": "A development practice where instrumentation is added before or alongside feature code — not as an afterthought after deployment"
      },
      {
        "name": "Runbook Automation",
        "level": "A",
        "description": "The progressive automation of operational runbooks — converting manual, step-by-step response procedures into automated scripts or workflows that…"
      }
    ]
  }
];

async function ensureCapabilities(list, label) {
  try {
    const { rows: existing } = await db.query('SELECT name FROM capabilities');
    const have = new Set(existing.map(r => r.name));
    const toAdd = list.filter(c => !have.has(c.name));
    if (!toAdd.length) return;
    const { rows: mx } = await db.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM capabilities');
    let order = parseInt(mx[0].m) || 0;
    await db.query('BEGIN');
    for (const cap of toAdd) {
      order++;
      const { rows: cr } = await db.query(
        `INSERT INTO capabilities (name, description, domain, source, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [cap.name, cap.description, cap.domain, cap.source, order]
      );
      const capId = cr[0].id;
      const pN = [], pD = [], pL = [], pO = [];
      cap.practices.forEach((p, j) => { pN.push(p.name); pD.push(p.description); pL.push(p.level || null); pO.push(j + 1); });
      await db.query(
        `INSERT INTO practices (capability_id, name, description, level, sort_order)
         SELECT $1::uuid, n, d, l, o FROM unnest($2::text[],$3::text[],$4::text[],$5::int[]) AS t(n,d,l,o)`,
        [capId, pN, pD, pL, pO]
      );
    }
    await db.query('COMMIT');
    console.log(`${label} ensured: +${toAdd.length} added`);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    console.error(`${label} seed error:`, err.message);
  }
}
async function ensureAICapabilities() { return ensureCapabilities(AI_CAPABILITIES, 'AI capabilities'); }
async function ensureOpsCapabilities() { return ensureCapabilities(OPS_CAPABILITIES, 'Ops capabilities'); }
async function ensureTACapabilities() { return ensureCapabilities(TA_CAPABILITIES, 'TA capabilities'); }
// Product & Delivery: the deck mostly matches existing seeded capabilities
// (spelling aside). Match capabilities by normalized name so we don't
// duplicate them, create only genuinely-new ones, and add only practices that
// don't already exist anywhere in the domain. Non-destructive (no deletes).
function normCapName(x){ return String(x||'').toLowerCase().replace(/optimization/g,'optimisation').replace(/management/g,'mgmt').replace(/[^a-z0-9]/g,''); }
async function ensurePDCapabilities(){
  try{
    const ex = await db.query("SELECT id,name FROM capabilities WHERE domain='Product & Delivery'");
    const byNorm={}; ex.rows.forEach(r=>{ byNorm[normCapName(r.name)]=r.id; });
    const dp = await db.query("SELECT name FROM practices p JOIN capabilities c ON c.id=p.capability_id WHERE c.domain='Product & Delivery'");
    const domainHave=new Set(dp.rows.map(r=>r.name));
    let added=0, newcaps=0;
    for(const cap of PD_CAPABILITIES){
      let capId = byNorm[normCapName(cap.name)];
      if(!capId){
        const mx = await db.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM capabilities');
        const cr = await db.query('INSERT INTO capabilities (name,description,domain,source,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [cap.name, cap.description, 'Product & Delivery', cap.source, (parseInt(mx.rows[0].m)||0)+1]);
        capId = cr.rows[0].id; byNorm[normCapName(cap.name)]=capId; newcaps++;
      }
      const toAdd = cap.practices.filter(p=>!domainHave.has(p.name));
      if(toAdd.length){
        const om = await db.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM practices WHERE capability_id=$1',[capId]);
        let po = parseInt(om.rows[0].m)||0;
        const N=[],D=[],L=[],O=[];
        toAdd.forEach(p=>{ po++; N.push(p.name); D.push(p.description); L.push(p.level||null); O.push(po); domainHave.add(p.name); });
        await db.query(`INSERT INTO practices (capability_id,name,description,level,sort_order)
          SELECT $1::uuid,n,d,l,o FROM unnest($2::text[],$3::text[],$4::text[],$5::int[]) AS t(n,d,l,o)`,[capId,N,D,L,O]);
        added += toAdd.length;
      }
    }
    if(added||newcaps) console.log(`PD reconcile: +${newcaps} capabilities, +${added} practices`);
  }catch(err){ console.error('PD reconcile error:', err.message); }
}

// Merge the older short-named Operations capabilities into the new card
// capabilities: move each old capability's distinct practices onto the new one,
// then delete the (now-empty-of-distinct-practices) old capability. Idempotent —
// once merged, the old capability no longer exists so the step is skipped.
const OPS_MERGE = [
  ['Incident Mgmt', 'Incident Management'],
  ['Knowledge Mgmt', 'Knowledge Management'],
  ['Process Improvement', 'Continuous Improvement'],
  ['Infra & App Monitoring', 'Continuous Monitoring'],
  ['Proactive Sys. Health', 'Reliability Engineering'],
  ['Lightweight Change Approval', 'Change Management'],
];
async function reconcileOpsCapabilities() {
  try {
    let moved = 0, dropped = 0;
    for (const [oldName, newName] of OPS_MERGE) {
      const o = await db.query("SELECT id FROM capabilities WHERE name=$1 AND domain='Operations'", [oldName]);
      const n = await db.query("SELECT id FROM capabilities WHERE name=$1 AND domain='Operations'", [newName]);
      if (!o.rows.length || !n.rows.length) continue;
      const oldId = o.rows[0].id, newId = n.rows[0].id;
      // Move practices whose name isn't already present under the new capability
      const up = await db.query(
        `UPDATE practices SET capability_id=$1
          WHERE capability_id=$2
            AND name NOT IN (SELECT name FROM practices WHERE capability_id=$1)`,
        [newId, oldId]
      );
      moved += up.rowCount || 0;
      // Delete the old capability (cascades any remaining duplicate practices)
      await db.query('DELETE FROM capabilities WHERE id=$1', [oldId]);
      dropped += 1;
    }
    if (moved || dropped) console.log(`OPS reconcile: moved ${moved} practices, merged ${dropped} old capabilities`);
  } catch (err) {
    console.error('OPS reconcile error:', err.message);
  }
}

// Technology & Architecture: the TA deck fully supersedes the older seeded TA
// capabilities. Retire any TA capability that isn't one of the 9 deck ones.
const TA_DECK_NAMES = TA_CAPABILITIES.map(c => c.name);
async function retireSupersededTACapabilities() {
  try {
    const r = await db.query(
      `DELETE FROM capabilities
        WHERE domain='Technology & Architecture' AND name <> ALL($1::text[])`,
      [TA_DECK_NAMES]
    );
    if (r.rowCount) console.log(`TA reconcile: retired ${r.rowCount} superseded capabilities`);
  } catch (err) {
    console.error('TA reconcile error:', err.message);
  }
}

// Manually trigger the AI capabilities insert (idempotent, non-destructive)
app.post('/api/admin/seed-ai', async (req, res) => {
  try {
    await ensureAICapabilities();
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM capabilities WHERE domain = 'Artificial Intelligence'`);
    res.json({ ok: true, aiCapabilities: rows[0].n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually trigger the TA capabilities insert + retire superseded (idempotent)
app.post('/api/admin/seed-pd', async (req, res) => {
  try {
    await ensurePDCapabilities();
    const { rows } = await db.query(
      `SELECT c.name, COUNT(p.*)::int AS practices FROM capabilities c
         LEFT JOIN practices p ON p.capability_id=c.id
        WHERE c.domain='Product & Delivery' GROUP BY c.name ORDER BY c.name`);
    res.json({ ok:true, pdCapabilities: rows.length, capabilities: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/seed-ta', async (req, res) => {
  try {
    await ensureTACapabilities();
    await retireSupersededTACapabilities();
    const { rows } = await db.query(
      `SELECT c.name, COUNT(p.*)::int AS practices FROM capabilities c
         LEFT JOIN practices p ON p.capability_id=c.id
        WHERE c.domain='Technology & Architecture' GROUP BY c.name ORDER BY c.name`);
    res.json({ ok:true, taCapabilities: rows.length, capabilities: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Manually trigger the Ops capabilities insert + merge (idempotent, non-destructive)
app.post('/api/admin/seed-ops', async (req, res) => {
  try {
    await ensureOpsCapabilities();
    await reconcileOpsCapabilities();
    const { rows } = await db.query(
      `SELECT c.name, COUNT(p.*)::int AS practices FROM capabilities c
         LEFT JOIN practices p ON p.capability_id = c.id
        WHERE c.domain='Operations' GROUP BY c.name ORDER BY c.name`);
    res.json({ ok: true, operationsCapabilities: rows.length, capabilities: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually trigger the non-destructive domain realignment
app.post('/api/admin/remap-domains', async (req, res) => {
  try {
    await remapCapabilityDomains();
    const { rows } = await db.query(
      `SELECT domain, COUNT(*)::int AS n FROM capabilities GROUP BY domain ORDER BY domain`);
    res.json({ ok: true, domains: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Force-reseed the capabilities library (call when DB is out of sync).
// Awaits the full chain — base seed plus every domain reconcile — so this one
// synchronous call brings the DB fully in line with the source catalogs, which
// the fire-and-forget module-init chain can't guarantee on serverless cold starts.
app.post('/api/admin/seed-capabilities', async (req, res) => {
  try {
    await seedCapabilitiesIfEmpty(true);
    await remapCapabilityDomains();
    await ensureAICapabilities();
    await ensureOpsCapabilities();
    await reconcileOpsCapabilities();
    await ensureTACapabilities();
    await retireSupersededTACapabilities();
    await ensurePDCapabilities();
    const { rows } = await db.query('SELECT COUNT(*) FROM capabilities');
    const { rows: pr } = await db.query('SELECT COUNT(*) FROM practices');
    res.json({ ok: true, capabilities: parseInt(rows[0].count), practices: parseInt(pr[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/capabilities', async (req, res) => {
  try {
    const caps = await db.query('SELECT * FROM capabilities ORDER BY sort_order, name');
    const pracs = await db.query('SELECT * FROM practices ORDER BY capability_id, sort_order, name');
    const result = caps.rows.map(c => ({
      ...c,
      practices: pracs.rows.filter(p => p.capability_id === c.id)
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/capabilities', async (req, res) => {
  const { name, description, domain } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await db.query('ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS domain TEXT');
    const { rows } = await db.query(
      'INSERT INTO capabilities (name, description, domain) VALUES ($1, $2, $3) RETURNING *',
      [name, description || null, domain || null]
    );
    res.status(201).json({ ...rows[0], practices: [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/capabilities/:id', async (req, res) => {
  const { name, description, domain } = req.body;
  try {
    await db.query('ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS domain TEXT');
    // domain is only overwritten when the key is present in the body (undefined = leave as-is)
    const setDomain = Object.prototype.hasOwnProperty.call(req.body, 'domain');
    const { rows } = setDomain
      ? await db.query('UPDATE capabilities SET name=$1, description=$2, domain=$3 WHERE id=$4 RETURNING *',
          [name, description || null, domain || null, req.params.id])
      : await db.query('UPDATE capabilities SET name=$1, description=$2 WHERE id=$3 RETURNING *',
          [name, description || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/capabilities/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM capabilities WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/capabilities/:capId/practices', async (req, res) => {
  const { name, description, level } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await db.query('ALTER TABLE practices ADD COLUMN IF NOT EXISTS level TEXT');
    const { rows } = await db.query(
      'INSERT INTO practices (capability_id, name, description, level) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.params.capId, name, description || null, level || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/practices/:id', async (req, res) => {
  const { name, description, level } = req.body;
  try {
    await db.query('ALTER TABLE practices ADD COLUMN IF NOT EXISTS level TEXT');
    const setLevel = Object.prototype.hasOwnProperty.call(req.body, 'level');
    const { rows } = setLevel
      ? await db.query('UPDATE practices SET name=$1, description=$2, level=$3 WHERE id=$4 RETURNING *',
          [name, description || null, level || null, req.params.id])
      : await db.query('UPDATE practices SET name=$1, description=$2 WHERE id=$3 RETURNING *',
          [name, description || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/practices/:id', async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM practices WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start (local dev) or export for Vercel ──
if (process.env.VERCEL) {
  seedCapabilitiesIfEmpty().then(remapCapabilityDomains).then(ensureAICapabilities).then(ensureOpsCapabilities).then(reconcileOpsCapabilities).then(ensureTACapabilities).then(retireSupersededTACapabilities).then(ensurePDCapabilities);
  module.exports = app;
} else {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`Nexus server running on http://localhost:${PORT}`);
    await seedCapabilitiesIfEmpty();
    await remapCapabilityDomains();
    await ensureAICapabilities();
    await ensureOpsCapabilities();
    await reconcileOpsCapabilities();
    await ensureTACapabilities();
    await retireSupersededTACapabilities();
    await ensurePDCapabilities();
  });
}
