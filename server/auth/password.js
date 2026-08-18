// Password hashing & policy for Nexus auth.
//
// Uses Node's built-in crypto.scrypt (memory-hard, salted, slow) — a strong,
// modern KDF that needs NO native dependency, which matters on Vercel's
// serverless runtime (bcrypt/argon2 need compiled binaries). This REPLACES the
// old unsalted SHA-256 used by the legacy per-board password.
//
// Stored format:  scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
const crypto = require('crypto');

const N = 16384, R = 8, P = 1, KEYLEN = 64; // ~16MB work factor per hash

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    if (!stored || typeof stored !== 'string') return false;
    const [scheme, n, r, p, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = crypto.scryptSync(password, salt, expected.length,
      { N: +n, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    // constant-time comparison
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Requirement 3 (with the agreed change): minimum 8, must contain a letter AND a
// number, symbols allowed, capped at 128. Returns null if valid, else a message.
function validatePasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length === 0) return 'Password is required.';
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  if (!/[A-Za-z]/.test(pw)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one number.';
  return null;
}

module.exports = { hashPassword, verifyPassword, validatePasswordPolicy };
