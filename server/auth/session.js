// Server-side sessions + trusted devices for Nexus auth (step 3).
// Sessions are opaque random tokens; only their SHA-256 hash is stored, so a DB
// dump can't be replayed. Identity is ALWAYS derived here from the cookie →
// sessions table → users, never trusted from the client.
const crypto = require('crypto');
const db = require('../db');

const SESSION_COOKIE = 'nexus_session';
const DEVICE_COOKIE  = 'nexus_device';
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // hard cap: 30 days
const SESSION_IDLE_MS     = 8 * 60 * 60 * 1000;       // idle timeout: 8 hours
const DEVICE_MS           = 30 * 24 * 60 * 60 * 1000; // trusted device: 30 days
const isProd = !!process.env.VERCEL;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const randToken = () => crypto.randomBytes(32).toString('hex');

function parseCookies(req) {
  const out = {}; const h = req.headers && req.headers.cookie;
  if (h) h.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const cookieOpts = maxAge => ({ httpOnly: true, secure: isProd, sameSite: 'lax', maxAge, path: '/' });

async function createSession(res, userId, req) {
  const token = randToken();
  await db.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
    [userId, sha256(token), new Date(Date.now() + SESSION_ABSOLUTE_MS).toISOString(),
     (req && req.ip) || null, ((req && req.headers['user-agent']) || '').slice(0, 300)]);
  res.cookie(SESSION_COOKIE, token, cookieOpts(SESSION_ABSOLUTE_MS));
}

// Returns the authenticated user (derived server-side) or null. Enforces idle +
// absolute expiry and account status; refreshes last_seen_at on use.
async function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT s.id sid, s.expires_at, s.last_seen_at,
            u.id, u.email, u.full_name, u.org_id, u.is_super_admin, u.status, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`, [sha256(token)]);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() < now || (now - new Date(row.last_seen_at).getTime()) > SESSION_IDLE_MS) {
    await db.query('DELETE FROM sessions WHERE id = $1', [row.sid]);
    return null;
  }
  if (row.status !== 'active') return null;
  await db.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [row.sid]);
  return { id: row.id, email: row.email, full_name: row.full_name, org_id: row.org_id,
           is_super_admin: row.is_super_admin, must_change_password: row.must_change_password };
}

async function requireAuth(req, res, next) {
  try {
    const u = await getSessionUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    req.user = u; next();
  } catch (e) { return res.status(500).json({ error: 'Auth check failed' }); }
}

async function revokeSession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
const revokeAllUserSessions = userId => db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
const revokeAllUserDevices  = userId => db.query('DELETE FROM trusted_devices WHERE user_id = $1', [userId]);

async function isTrustedDevice(req, userId) {
  const token = parseCookies(req)[DEVICE_COOKIE];
  if (!token) return false;
  const { rows } = await db.query(
    'SELECT id, expires_at FROM trusted_devices WHERE user_id = $1 AND token_hash = $2', [userId, sha256(token)]);
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return false;
  await db.query('UPDATE trusted_devices SET last_seen_at = NOW() WHERE id = $1', [row.id]);
  return true;
}
async function trustDevice(res, userId, req) {
  const token = randToken();
  const label = ((req && req.headers['user-agent']) || 'device').slice(0, 80);
  await db.query('INSERT INTO trusted_devices (user_id, token_hash, label, expires_at) VALUES ($1,$2,$3,$4)',
    [userId, sha256(token), label, new Date(Date.now() + DEVICE_MS).toISOString()]);
  res.cookie(DEVICE_COOKIE, token, cookieOpts(DEVICE_MS));
}

module.exports = {
  SESSION_COOKIE, DEVICE_COOKIE, sha256, parseCookies,
  createSession, getSessionUser, requireAuth, revokeSession,
  revokeAllUserSessions, revokeAllUserDevices, isTrustedDevice, trustDevice,
};
