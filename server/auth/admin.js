// Admin console API (step 5) — Super-Admin only. Mounted at /api/console.
// Manages orgs, allowlisted domains, users, and board assignments — replacing
// the register-domain / assign-board CLIs.
const express = require('express');
const db = require('../db');
const session = require('./session');
const access = require('./access');

const router = express.Router();

// Wrap async handlers so a DB/query error returns 500 instead of crashing the
// whole server process (an unhandled rejection would take the app down).
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error('console error:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

// Gate: every route requires a Super Admin session.
router.use(async (req, res, next) => {
  try {
    const user = await session.getSessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (!user.is_super_admin) return res.status(403).json({ error: 'Admins only' });
    req.user = user; next();
  } catch (e) { res.status(500).json({ error: 'Auth check failed' }); }
});

const norm = e => String(e || '').trim().toLowerCase();
const slugify = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
async function audit(actorId, action, targetType, targetId, meta) {
  try {
    await db.query('INSERT INTO audit_log (actor_user_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5)',
      [actorId, action, targetType || null, targetId || null, meta ? JSON.stringify(meta) : null]);
  } catch { /* audit must not break the request */ }
}

// ── Overview counts ──
router.get('/overview', h(async (req, res) => {
  const q = async sql => (await db.query(sql)).rows[0].n;
  res.json({
    orgs: await q('SELECT COUNT(*)::int n FROM companies'),
    boards: await q('SELECT COUNT(*)::int n FROM games'),
    users: await q('SELECT COUNT(*)::int n FROM users'),
    active_users: await q("SELECT COUNT(*)::int n FROM users WHERE status='active'"),
    pending_users: await q("SELECT COUNT(*)::int n FROM users WHERE status='pending_verification'"),
  });
}));

// ── All boards, grouped by org (requirement 6) ──
router.get('/boards', h(async (req, res) => {
  const { rows } = await db.query(`
    SELECT g.id, g.name, c.name AS org, c.id AS org_id, g.updated_at,
           COUNT(gm.user_id)::int AS members
    FROM games g JOIN companies c ON c.id = g.company_id
    LEFT JOIN game_members gm ON gm.game_id = g.id
    GROUP BY g.id, c.name, c.id ORDER BY c.name, g.updated_at DESC`);
  res.json(rows);
}));

// ── Members of a board ──
router.get('/boards/:gameId/members', h(async (req, res) => {
  const { rows } = await db.query(`
    SELECT u.id AS user_id, u.email, u.full_name, u.status, gm.role, gm.added_at
    FROM game_members gm JOIN users u ON u.id = gm.user_id
    WHERE gm.game_id = $1 ORDER BY u.email`, [req.params.gameId]);
  res.json(rows);
}));

// ── All users ──
router.get('/users', h(async (req, res) => {
  const { rows } = await db.query(`
    SELECT u.id, u.email, u.full_name, u.status, u.is_super_admin,
           c.name AS org, u.last_login_at, COUNT(gm.game_id)::int AS boards
    FROM users u LEFT JOIN companies c ON c.id = u.org_id
    LEFT JOIN game_members gm ON gm.user_id = u.id
    GROUP BY u.id, c.name ORDER BY u.status, u.email`);
  res.json(rows);
}));

// ── Orgs + their allowlisted domains ──
router.get('/orgs', h(async (req, res) => {
  const orgs = (await db.query(`SELECT c.id, c.name, c.slug, COUNT(g.id)::int AS boards
    FROM companies c LEFT JOIN games g ON g.company_id = c.id GROUP BY c.id ORDER BY c.name`)).rows;
  const doms = (await db.query('SELECT org_id, domain FROM org_email_domains ORDER BY domain')).rows;
  res.json(orgs.map(o => ({ ...o, domains: doms.filter(d => d.org_id === o.id).map(d => d.domain) })));
}));

router.post('/orgs', h(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Organization name is required.' });
  try {
    const { rows } = await db.query('INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id,name,slug',
      [name, slugify(name) || Math.random().toString(36).slice(2, 8)]);
    await audit(req.user.id, 'org.created', 'company', rows[0].id, { name });
    res.status(201).json(rows[0]);
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'An organization with that name/slug already exists.' }); throw e; }
}));

// ── Allowlisted domains ──
router.post('/domains', h(async (req, res) => {
  const orgId = req.body && req.body.orgId;
  const domain = norm(req.body && req.body.domain).replace(/^@/, '');
  if (!orgId || !domain || !domain.includes('.')) return res.status(400).json({ error: 'A valid organization and domain are required.' });
  try {
    await db.query('INSERT INTO org_email_domains (org_id, domain) VALUES ($1,$2) ON CONFLICT (org_id, domain) DO NOTHING', [orgId, domain]);
    await audit(req.user.id, 'domain.added', 'company', orgId, { domain });
    res.json({ ok: true });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'That domain is already allowlisted for another organization.' }); throw e; }
}));
router.delete('/domains', h(async (req, res) => {
  const orgId = req.body && req.body.orgId, domain = norm(req.body && req.body.domain);
  await db.query('DELETE FROM org_email_domains WHERE org_id=$1 AND domain=$2', [orgId, domain]);
  await audit(req.user.id, 'domain.removed', 'company', orgId, { domain });
  res.json({ ok: true });
}));

// ── Assign a person (by email) to a board — creates a pending account if new ──
router.post('/assign', h(async (req, res) => {
  const email = norm(req.body && req.body.email);
  const gameId = req.body && req.body.gameId;
  const role = (req.body && req.body.role) || 'facilitator';
  if (!email || !email.includes('@') || !gameId) return res.status(400).json({ error: 'A valid email and board are required.' });
  const g = (await db.query('SELECT id, company_id FROM games WHERE id=$1', [gameId])).rows[0];
  if (!g) return res.status(404).json({ error: 'Board not found.' });
  let user = (await db.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
  if (!user) {
    const dom = email.split('@')[1] || '';
    const od = (await db.query('SELECT org_id FROM org_email_domains WHERE domain=$1', [dom])).rows[0];
    user = (await db.query("INSERT INTO users (email, org_id, status) VALUES ($1,$2,'pending_verification') RETURNING id",
      [email, od ? od.org_id : g.company_id])).rows[0];
  }
  await access.assignMember(gameId, user.id, role, req.user.id);
  res.json({ ok: true });
}));
router.delete('/assign', h(async (req, res) => {
  const userId = req.body && req.body.userId, gameId = req.body && req.body.gameId;
  if (!userId || !gameId) return res.status(400).json({ error: 'user and board are required.' });
  await access.removeMember(gameId, userId, req.user.id);
  res.json({ ok: true });
}));

// ── Suspend / reactivate a user ──
router.post('/users/:id/suspend', h(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't suspend your own account." });
  await db.query("UPDATE users SET status='suspended' WHERE id=$1", [req.params.id]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]); // sign them out everywhere
  await audit(req.user.id, 'user.suspended', 'user', req.params.id, null);
  res.json({ ok: true });
}));
router.post('/users/:id/activate', h(async (req, res) => {
  await db.query("UPDATE users SET status='active' WHERE id=$1 AND password_hash IS NOT NULL", [req.params.id]);
  await audit(req.user.id, 'user.reactivated', 'user', req.params.id, null);
  res.json({ ok: true });
}));

// ── Recent audit log ──
router.get('/audit', h(async (req, res) => {
  const { rows } = await db.query(`
    SELECT a.action, a.target_type, a.created_at, u.email AS actor
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
    ORDER BY a.created_at DESC LIMIT 100`);
  res.json(rows);
}));

module.exports = router;
