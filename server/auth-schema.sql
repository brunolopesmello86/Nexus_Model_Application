-- ════════════════════════════════════════════════════════════════════════════
--  Nexus — Authentication & Access-Control schema  (STEP 1)
--  ADDITIVE and idempotent. Creates only NEW tables. Does NOT touch existing
--  tables (companies, games, capabilities, practices) or any board data.
--  Organizations are the existing `companies` table. Boards are `games`.
--  Safe to run repeatedly.
-- ════════════════════════════════════════════════════════════════════════════

-- Which company an email domain maps to (the signup allowlist, requirement 1).
CREATE TABLE IF NOT EXISTS org_email_domains (
  org_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  domain     TEXT NOT NULL,                -- lowercase, no '@'  e.g. 'nttdata.com'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, domain)
);
-- A domain maps to exactly one organization.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_email_domains_domain ON org_email_domains(domain);

-- People. Email is stored lowercased by the app; UNIQUE = one account per email.
CREATE TABLE IF NOT EXISTS users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT UNIQUE NOT NULL,
  full_name            TEXT,
  org_id               UUID REFERENCES companies(id) ON DELETE SET NULL,
  password_hash        TEXT,                                          -- null until set
  status               TEXT NOT NULL DEFAULT 'pending_verification',  -- pending_verification | active | suspended
  email_verified_at    TIMESTAMPTZ,
  is_super_admin       BOOLEAN NOT NULL DEFAULT FALSE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  failed_logins        INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at        TIMESTAMPTZ
);

-- THE access-control table. A row here = this user may see this board.
-- No row = the board does not exist, as far as that user is concerned.
-- Writes happen ONLY through a server-side Super-Admin action, never the browser.
-- This is requirements 4, 5 and 7.
CREATE TABLE IF NOT EXISTS game_members (
  game_id  UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'player',   -- facilitator | player | observer
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (game_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_game_members_user ON game_members(user_id);

-- Emailed 6-digit codes. Stored HASHED — a DB dump reveals nothing usable.
CREATE TABLE IF NOT EXISTS verification_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL,          -- signup | new_device | password_reset
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verification_codes_lookup ON verification_codes(user_id, purpose, expires_at);

-- "Remember this device for 30 days" — token stored hashed.
CREATE TABLE IF NOT EXISTS trusted_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  label        TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);

-- Server-side sessions, so we can revoke on logout / password reset.
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Every grant/removal of access and every auth-significant action lands here.
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,           -- 'board_member.added', 'user.promoted', ...
  target_type   TEXT,
  target_id     UUID,
  metadata      JSONB,
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
