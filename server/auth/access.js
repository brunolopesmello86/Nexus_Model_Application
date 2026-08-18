// Board access-control core (step 4).
// Membership is the ONLY boundary: a user sees a board iff there is a
// game_members row for them — except a Super Admin, who sees everything.
// This is enforced server-side; the client never decides access.
const db = require('../db');

async function canAccessGame(user, gameId) {
  if (!user) return false;
  if (user.is_super_admin) return true;
  const { rows } = await db.query('SELECT 1 FROM game_members WHERE game_id=$1 AND user_id=$2 LIMIT 1', [gameId, user.id]);
  return rows.length > 0;
}

// Returns null when the user may see ALL games (Super Admin), otherwise the
// explicit array of game ids they are a member of.
async function visibleGameIds(user) {
  if (!user) return [];
  if (user.is_super_admin) return null;
  const { rows } = await db.query('SELECT game_id FROM game_members WHERE user_id=$1', [user.id]);
  return rows.map(r => r.game_id);
}

async function assignMember(gameId, userId, role, addedBy) {
  await db.query(
    `INSERT INTO game_members (game_id, user_id, role, added_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (game_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [gameId, userId, role || 'facilitator', addedBy || null]);
  await db.query(
    'INSERT INTO audit_log (actor_user_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5)',
    [addedBy || null, 'board_member.added', 'game', gameId, JSON.stringify({ userId, role: role || 'facilitator' })]);
}

async function removeMember(gameId, userId, actorId) {
  await db.query('DELETE FROM game_members WHERE game_id=$1 AND user_id=$2', [gameId, userId]);
  await db.query(
    'INSERT INTO audit_log (actor_user_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5)',
    [actorId || null, 'board_member.removed', 'game', gameId, JSON.stringify({ userId })]);
}

module.exports = { canAccessGame, visibleGameIds, assignMember, removeMember };
