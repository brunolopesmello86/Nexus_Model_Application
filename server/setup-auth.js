// ════════════════════════════════════════════════════════════════════════════
//  Nexus auth — STEP 1 setup.  Run:  npm run setup:auth
//
//  1. Applies server/auth-schema.sql (creates the new auth tables; additive,
//     idempotent — does not touch existing board data).
//  2. Seeds the Super Admin account with a TEMPORARY password, shown once here,
//     with must_change_password = true (you'll be forced to change it on first
//     login once step 3 ships).
//
//  Safe to re-run: it will NOT overwrite an existing Super Admin that already
//  has a password.
// ════════════════════════════════════════════════════════════════════════════
if (!process.env.VERCEL) require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { hashPassword } = require('./auth/password');

const SUPER_ADMIN_EMAIL = 'brunolopesmello86@gmail.com';
const SUPER_ADMIN_NAME  = 'Bruno Lopes Mello';

// Strong, readable temporary password. Always contains letters ("Nexus") and a
// trailing number, so it satisfies the password policy.
function makeTempPassword() {
  const body = crypto.randomBytes(6).toString('hex');       // 12 hex chars
  const num  = 10 + (crypto.randomBytes(1)[0] % 90);        // 2 digits
  return `Nexus-${body}-${num}`;
}

async function main() {
  // 1) schema
  const sql = fs.readFileSync(path.join(__dirname, 'auth-schema.sql'), 'utf8');
  await db.query(sql);
  console.log('✓ Auth schema applied (org_email_domains, users, game_members,');
  console.log('  verification_codes, trusted_devices, sessions, audit_log).');

  // 2) super admin
  const email = SUPER_ADMIN_EMAIL.toLowerCase().trim();
  const existing = await db.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  if (existing.rows.length && existing.rows[0].password_hash) {
    console.log(`\n✓ Super Admin ${email} already exists with a password — leaving it unchanged.`);
    console.log('  (To issue a fresh temp password, use the reset flow in step 3.)');
    process.exit(0);
  }

  const temp = makeTempPassword();
  await db.query(
    `INSERT INTO users (email, full_name, is_super_admin, status, email_verified_at, password_hash, must_change_password)
     VALUES ($1, $2, TRUE, 'active', NOW(), $3, TRUE)
     ON CONFLICT (email) DO UPDATE SET
       is_super_admin = TRUE, status = 'active', email_verified_at = NOW(),
       password_hash = EXCLUDED.password_hash, must_change_password = TRUE`,
    [email, SUPER_ADMIN_NAME, hashPassword(temp)]
  );

  console.log('\n╔════════════════════════════════════');
  console.log('  SUPER ADMIN SEEDED');
  console.log('  Email:               ' + email);
  console.log('  Temporary password:  ' + temp);
  console.log('  You will be forced to change it on first login.');
  console.log('╚════════════════════════════════════');
  console.log('\n→ Save this password now (password manager). It is shown only once and is');
  console.log('  stored only as a scrypt hash — there is no plaintext copy anywhere.\n');
  process.exit(0);
}

main().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
