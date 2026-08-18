// Nexus auth — STEP 2 routes: signup -> emailed 6-digit code -> password creation.
// Mounted at /api/auth. Never logs passwords, codes, or tokens.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { hashPassword, verifyPassword, validatePasswordPolicy } = require('./password');
const { sendEmail, verificationCodeEmail } = require('./email');
const session = require('./session');

const router = express.Router();

const CODE_TTL_MIN = 10;         // code lifetime
const MAX_ATTEMPTS = 5;          // wrong-code attempts before the code is burned
const MAX_SENDS = 3;             // codes per window per user
const SEND_WINDOW_MIN = 15;
const SETPW_TTL_MIN = 15;        // signup / reset token lifetime
const MAX_FAILED = 10;           // failed logins before lockout
const LOCK_MIN = 15;             // lockout duration

const normEmail = e => String(e || '').trim().toLowerCase();
const domainOf = e => normEmail(e).split('@')[1] || '';
const gen6 = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const randToken = () => crypto.randomBytes(32).toString('hex');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

async function resolveOrgByDomain(domain) {
  if (!domain) return null;
  const { rows } = await db.query('SELECT org_id FROM org_email_domains WHERE domain = $1', [domain]);
  return rows.length ? rows[0].org_id : null;
}

async function audit(action, targetId, metadata, ip) {
  try {
    await db.query(
      'INSERT INTO audit_log (action, target_type, target_id, metadata, ip) VALUES ($1,$2,$3,$4,$5)',
      [action, 'user', targetId || null, metadata ? JSON.stringify(metadata) : null, ip || null]);
  } catch { /* audit must never break the request */ }
}

// Fail-open breach check via HaveIBeenPwned k-anonymity range API (password never leaves in full).
async function isPwned(password) {
  try {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5), suffix = sha1.slice(5);
    const r = await fetch('https://api.pwnedpasswords.com/range/' + prefix, { headers: { 'Add-Padding': 'true' } });
    if (!r.ok) return false;
    const body = await r.text();
    return body.split('\n').some(line => line.split(':')[0].trim().toUpperCase() === suffix);
  } catch { return false; }
}

// ── POST /api/auth/signup  { full_name, email } ──
router.post('/signup', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const fullName = String((req.body && req.body.full_name) || '').trim().slice(0, 120);
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid work email is required.' });
  try {
    const orgId = await resolveOrgByDomain(domainOf(email));
    if (!orgId) {
      return res.status(403).json({ error: "Nexus is invite-only for partner organizations. Ask your project lead to register your organization's email domain." });
    }
    const { rows } = await db.query('SELECT id, status, password_hash FROM users WHERE email = $1', [email]);
    let user = rows[0];
    if (user && user.status === 'active' && user.password_hash) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in instead.' });
    }
    if (!user) {
      const ins = await db.query(
        "INSERT INTO users (email, full_name, org_id, status) VALUES ($1,$2,$3,'pending_verification') RETURNING id",
        [email, fullName || null, orgId]);
      user = { id: ins.rows[0].id };
    } else {
      await db.query("UPDATE users SET org_id=$1, full_name=COALESCE(NULLIF($2,''), full_name) WHERE id=$3",
        [orgId, fullName, user.id]);
    }
    // send-rate limit
    const since = new Date(Date.now() - SEND_WINDOW_MIN * 60000).toISOString();
    const cnt = await db.query(
      "SELECT COUNT(*)::int n FROM verification_codes WHERE user_id=$1 AND purpose='signup' AND created_at > $2",
      [user.id, since]);
    if (cnt.rows[0].n >= MAX_SENDS) {
      return res.status(429).json({ error: 'Too many codes requested. Please wait a few minutes and try again.' });
    }
    const code = gen6();
    const expires = new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString();
    await db.query(
      "INSERT INTO verification_codes (user_id, code_hash, purpose, expires_at) VALUES ($1,$2,'signup',$3)",
      [user.id, hashPassword(code), expires]);
    const mail = verificationCodeEmail(code, 'signup');
    try {
      await sendEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (mailErr) {
      console.error('signup email error:', mailErr.message);
      return res.status(502).json({ error: 'We could not send your verification email. ' + mailErr.message });
    }
    await audit('auth.signup_code_sent', user.id, { email }, req.ip);
    return res.json({ ok: true, message: "We've emailed you a 6-digit code. It expires in 10 minutes." });
  } catch (err) {
    console.error('signup error:', err.message);
    return res.status(500).json({ error: 'Could not start signup. Please try again.' });
  }
});

// ── POST /api/auth/verify-code  { email, code } -> { token } ──
router.post('/verify-code', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const code = String((req.body && req.body.code) || '').trim();
  if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
  try {
    const u = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!u.rows.length) return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
    const userId = u.rows[0].id;
    const vc = await db.query(
      "SELECT id, code_hash, attempts, expires_at, consumed_at FROM verification_codes WHERE user_id=$1 AND purpose='signup' ORDER BY created_at DESC LIMIT 1",
      [userId]);
    const row = vc.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
    if (row.attempts >= MAX_ATTEMPTS) {
      await db.query('UPDATE verification_codes SET consumed_at=NOW() WHERE id=$1', [row.id]);
      return res.status(400).json({ error: 'Too many attempts. Request a new code.' });
    }
    if (!verifyPassword(code, row.code_hash)) {
      await db.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id=$1', [row.id]);
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }
    await db.query('UPDATE verification_codes SET consumed_at=NOW() WHERE id=$1', [row.id]);
    await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id=$1', [userId]);
    const token = randToken();
    await db.query(
      "INSERT INTO verification_codes (user_id, code_hash, purpose, expires_at) VALUES ($1,$2,'setpw',$3)",
      [userId, sha256(token), new Date(Date.now() + SETPW_TTL_MIN * 60000).toISOString()]);
    await audit('auth.email_verified', userId, null, req.ip);
    return res.json({ ok: true, token });
  } catch (err) {
    console.error('verify-code error:', err.message);
    return res.status(500).json({ error: 'Could not verify the code. Please try again.' });
  }
});

// ── POST /api/auth/set-password  { email, token, password } ──
router.post('/set-password', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const token = String((req.body && req.body.token) || '');
  const password = String((req.body && req.body.password) || '');
  if (!email || !token) return res.status(400).json({ error: 'Your session expired. Please restart signup.' });
  const policyErr = validatePasswordPolicy(password);
  if (policyErr) return res.status(400).json({ error: policyErr });
  try {
    const u = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!u.rows.length) return res.status(400).json({ error: 'Your session expired. Please restart signup.' });
    const userId = u.rows[0].id;
    const t = await db.query(
      "SELECT id, expires_at, consumed_at FROM verification_codes WHERE user_id=$1 AND purpose='setpw' AND code_hash=$2 ORDER BY created_at DESC LIMIT 1",
      [userId, sha256(token)]);
    const row = t.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'Your session expired. Please restart signup.' });
    if (await isPwned(password))
      return res.status(400).json({ error: 'That password has appeared in a known data breach. Please choose a different one.' });
    await db.query(
      "UPDATE users SET password_hash=$1, status='active', must_change_password=FALSE, email_verified_at=COALESCE(email_verified_at, NOW()) WHERE id=$2",
      [hashPassword(password), userId]);
    await db.query('UPDATE verification_codes SET consumed_at=NOW() WHERE id=$1', [row.id]);
    await audit('auth.account_activated', userId, null, req.ip);
    // No session yet — login/sessions arrive in step 3. Account is active and ready.
    return res.json({ ok: true, message: 'Your account is ready.' });
  } catch (err) {
    console.error('set-password error:', err.message);
    return res.status(500).json({ error: 'Could not set your password. Please try again.' });
  }
});

// ── POST /api/auth/login  { email, password } ──
router.post('/login', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');
  const generic = 'Incorrect email or password.';
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const { rows } = await db.query(
      'SELECT id, password_hash, status, locked_until, failed_logins, must_change_password FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: generic });
    if (user.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended.' });
    if (user.locked_until && new Date(user.locked_until) > new Date())
      return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
    if (!verifyPassword(password, user.password_hash)) {
      const fails = (user.failed_logins || 0) + 1;
      const lock = fails >= MAX_FAILED ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null;
      await db.query('UPDATE users SET failed_logins = $1, locked_until = $2 WHERE id = $3', [fails, lock, user.id]);
      return res.status(401).json({ error: generic });
    }
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1', [user.id]);
    // Trusted device? → sign in straight away, no code.
    if (await session.isTrustedDevice(req, user.id)) {
      await session.createSession(res, user.id, req);
      await audit('auth.login', user.id, { trusted: true }, req.ip);
      return res.json({ ok: true, authenticated: true, mustChangePassword: user.must_change_password });
    }
    // New device → email a code.
    const since = new Date(Date.now() - SEND_WINDOW_MIN * 60000).toISOString();
    const cnt = await db.query(
      "SELECT COUNT(*)::int n FROM verification_codes WHERE user_id=$1 AND purpose='new_device' AND created_at > $2", [user.id, since]);
    if (cnt.rows[0].n >= MAX_SENDS) return res.status(429).json({ error: 'Too many codes requested. Please wait a few minutes.' });
    const code = gen6();
    await db.query("INSERT INTO verification_codes (user_id, code_hash, purpose, expires_at) VALUES ($1,$2,'new_device',$3)",
      [user.id, hashPassword(code), new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString()]);
    const mail = verificationCodeEmail(code, 'new_device');
    try { await sendEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text }); }
    catch (mailErr) { console.error('login email error:', mailErr.message); return res.status(502).json({ error: 'We could not send your verification email. ' + mailErr.message }); }
    await audit('auth.login_code_sent', user.id, null, req.ip);
    return res.json({ ok: true, needsCode: true });
  } catch (err) {
    console.error('login error:', err.message);
    return res.status(500).json({ error: 'Could not sign you in. Please try again.' });
  }
});

// ── POST /api/auth/login-verify  { email, code, trustDevice } ──
router.post('/login-verify', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const code = String((req.body && req.body.code) || '').trim();
  const trust = !!(req.body && req.body.trustDevice);
  if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
  try {
    const u = await db.query('SELECT id, status, must_change_password FROM users WHERE email = $1', [email]);
    const user = u.rows[0];
    if (!user || user.status !== 'active') return res.status(400).json({ error: 'Invalid or expired code.' });
    const vc = await db.query(
      "SELECT id, code_hash, attempts, expires_at, consumed_at FROM verification_codes WHERE user_id=$1 AND purpose='new_device' ORDER BY created_at DESC LIMIT 1", [user.id]);
    const row = vc.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'Invalid or expired code. Please sign in again.' });
    if (row.attempts >= MAX_ATTEMPTS) {
      await db.query('UPDATE verification_codes SET consumed_at=NOW() WHERE id=$1', [row.id]);
      return res.status(400).json({ error: 'Too many attempts. Please sign in again.' });
    }
    if (!verifyPassword(code, row.code_hash)) {
      await db.query('UPDATE verification_codes SET attempts=attempts+1 WHERE id=$1', [row.id]);
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }
    await db.query('UPDATE verification_codes SET consumed_at=NOW() WHERE id=$1', [row.id]);
    await session.createSession(res, user.id, req);
    if (trust) await session.trustDevice(res, user.id, req);
    await audit('auth.login', user.id, { trusted: false, trustedNow: trust }, req.ip);
    return res.json({ ok: true, authenticated: true, mustChangePassword: user.must_change_password });
  } catch (err) {
    console.error('login-verify error:', err.message);
    return res.status(500).json({ error: 'Could not verify the code. Please try again.' });
  }
});

// ── POST /api/auth/logout ──
router.post('/logout', async (req, res) => {
  try { await session.revokeSession(req, res); } catch { /* ignore */ }
  res.json({ ok: true });
});

// ── GET /api/auth/me ──  who am I (identity derived from the session, server-side)
router.get('/me', async (req, res) => {
  const u = await session.getSessionUser(req);
  if (!u) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: { email: u.email, full_name: u.full_name, is_super_admin: u.is_super_admin, must_change_password: u.must_change_password } });
});

// ── POST /api/auth/change-password  { currentPassword, newPassword }  (session required) ──
router.post('/change-password', session.requireAuth, async (req, res) => {
  const current = String((req.body && req.body.currentPassword) || '');
  const next = String((req.body && req.body.newPassword) || '');
  const policyErr = validatePasswordPolicy(next);
  if (policyErr) return res.status(400).json({ error: policyErr });
  try {
    const r = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows.length || !verifyPassword(current, r.rows[0].password_hash))
      return res.status(401).json({ error: 'Your current password is incorrect.' });
    if (current === next) return res.status(400).json({ error: 'Choose a password different from your current one.' });
    if (await isPwned(next)) return res.status(400).json({ error: 'That password has appeared in a known data breach. Please choose a different one.' });
    await db.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [hashPassword(next), req.user.id]);
    // revoke every OTHER session for this user; keep the current one alive
    const curHash = session.sha256(session.parseCookies(req)[session.SESSION_COOKIE] || '');
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, curHash]);
    await audit('auth.password_changed', req.user.id, null, req.ip);
    return res.json({ ok: true });
  } catch (err) {
    console.error('change-password error:', err.message);
    return res.status(500).json({ error: 'Could not change your password.' });
  }
});

// ── Password reset (forgot password) ──
// request → generic response (no account enumeration)
router.post('/reset-request', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const okResp = { ok: true, message: "If an account exists for that email, we've sent a reset code." };
  if (!email) return res.json(okResp);
  try {
    const u = await db.query("SELECT id FROM users WHERE email=$1 AND status='active'", [email]);
    if (u.rows.length) {
      const userId = u.rows[0].id;
      const since = new Date(Date.now() - SEND_WINDOW_MIN * 60000).toISOString();
      const cnt = await db.query("SELECT COUNT(*)::int n FROM verification_codes WHERE user_id=$1 AND purpose='password_reset' AND created_at > $2", [userId, since]);
      if (cnt.rows[0].n < MAX_SENDS) {
        const code = gen6();
        await db.query("INSERT INTO verification_codes (user_id, code_hash, purpose, expires_at) VALUES ($1,$2,'password_reset',$3)",
          [userId, hashPassword(code), new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString()]);
        const mail = verificationCodeEmail(code, 'password_reset');
        try { await sendEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text }); await audit('auth.reset_code_sent', userId, null, req.ip); }
        catch (e) { console.error('reset email error:', e.message); }
      }
    }
    return res.json(okResp);
  } catch (err) { console.error('reset-request error:', err.message); return res.json(okResp); }
});

router.post('/reset-verify', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const code = String((req.body && req.body.code) || '').trim();
  if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
  try {
    const u = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!u.rows.length) return res.status(400).json({ error: 'Invalid or expired code.' });
    const userId = u.rows[0].id;
    const vc = await db.query(
      "SELECT id, code_hash, attempts, expires_at, consumed_at FROM verification_codes WHERE user_id=$1 AND purpose='password_reset' ORDER BY created_at DESC LIMIT 1", [userId]);
    const row = vc.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' });
    if (row.attempts >= MAX_ATTEMPTS) {
      await db.query('UPDATE verification_codes SET consumed_at=NOW() WHERE id=$1', [row.id]);
      return res.status(400).json({ error: 'Too many attempts. Request a new code.' });
    }
    if (!verifyPassword(code, row.code_hash)) {
      await db.query('UPDATE verification_codes SET attempts=attempts+1 WHERE id=$1', [row.id]);
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }
    await db.query('UPDATE verification_codes SET consumed_at=NOW() WHERE id=$1', [row.id]);
    const token = randToken();
    await db.query("INSERT INTO verification_codes (user_id, code_hash, purpose, expires_at) VALUES ($1,$2,'reset_setpw',$3)",
      [userId, sha256(token), new Date(Date.now() + SETPW_TTL_MIN * 60000).toISOString()]);
    return res.json({ ok: true, token });
  } catch (err) { console.error('reset-verify error:', err.message); return res.status(500).json({ error: 'Could not verify the code.' }); }
});

router.post('/reset-complete', async (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const token = String((req.body && req.body.token) || '');
  const password = String((req.body && req.body.password) || '');
  if (!email || !token) return res.status(400).json({ error: 'Your reset session expired. Please start over.' });
  const policyErr = validatePasswordPolicy(password);
  if (policyErr) return res.status(400).json({ error: policyErr });
  try {
    const u = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!u.rows.length) return res.status(400).json({ error: 'Your reset session expired. Please start over.' });
    const userId = u.rows[0].id;
    const t = await db.query(
      "SELECT id, expires_at, consumed_at FROM verification_codes WHERE user_id=$1 AND purpose='reset_setpw' AND code_hash=$2 ORDER BY created_at DESC LIMIT 1", [userId, sha256(token)]);
    const row = t.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date())
      return res.status(400).json({ error: 'Your reset session expired. Please start over.' });
    if (await isPwned(password)) return res.status(400).json({ error: 'That password has appeared in a known data breach. Please choose a different one.' });
    await db.query("UPDATE users SET password_hash=$1, must_change_password=FALSE, status='active' WHERE id=$2", [hashPassword(password), userId]);
    await db.query('UPDATE verification_codes SET consumed_at=NOW() WHERE id=$1', [row.id]);
    // a reset assumes compromise → kill every session and trusted device
    await session.revokeAllUserSessions(userId);
    await session.revokeAllUserDevices(userId);
    await audit('auth.password_reset', userId, null, req.ip);
    return res.json({ ok: true, message: 'Your password has been reset. You can now sign in.' });
  } catch (err) { console.error('reset-complete error:', err.message); return res.status(500).json({ error: 'Could not reset your password.' }); }
});

module.exports = router;
