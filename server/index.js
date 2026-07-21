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
    const { rows } = await db.query(`
      SELECT id, company_id, name, description, fitness_score,
             cycle_number, cycle_phase, created_at, updated_at,
             (password_hash IS NOT NULL) AS has_password
      FROM games
      WHERE company_id = $1
      ORDER BY updated_at DESC
    `, [req.params.companyId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/companies/:companyId/games', async (req, res) => {
  const { name, description, password } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
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
    board_milestones, board_risks, loop_sessions, board_instances, anchors
  } = req.body;
  try {
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS board_milestones JSONB NOT NULL DEFAULT \'[]\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS board_risks JSONB NOT NULL DEFAULT \'[]\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS loop_sessions JSONB NOT NULL DEFAULT \'[]\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS board_instances JSONB NOT NULL DEFAULT \'{}\'');
    await db.query('ALTER TABLE games ADD COLUMN IF NOT EXISTS anchors JSONB NOT NULL DEFAULT \'[]\'');
    const { rows } = await db.query(`
      UPDATE games SET
        board_state = $1, agent_assignments = $2, active_drivers = $3,
        cycle_number = $4, cycle_phase = $5, completed_phases = $6,
        log_entries = $7, custom_items = $8, fitness_score = $9,
        connections = $10, board_markers = $11, domain_definitions = $12,
        experiment_results = $13, practice_repetitions = $14,
        transformation_horizons = $15, board_milestones = $16, board_risks = $17,
        loop_sessions = $18, board_instances = $19, anchors = $20, updated_at = NOW()
      WHERE id = $21
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
  { name: 'Agility at Scale', domain: 'Strategy & Portfolio', source: 'Scrum@Scale · Nexus · Agnostic Agility',
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
    if (!force && count >= SEED_CAPABILITIES.length) return;

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

// Force-reseed the capabilities library (call when DB is out of sync)
app.post('/api/admin/seed-capabilities', async (req, res) => {
  try {
    await seedCapabilitiesIfEmpty(true);
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
  seedCapabilitiesIfEmpty();
  module.exports = app;
} else {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`Nexus server running on http://localhost:${PORT}`);
    await seedCapabilitiesIfEmpty();
  });
}
