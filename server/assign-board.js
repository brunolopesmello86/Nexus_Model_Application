// Assign a person to a board (Super-Admin action; the point-and-click console is
// step 5). Creates the user as pending if they don't exist yet — their later
// self-signup activates the same account, so their boards are waiting for them.
//
//   node server/assign-board.js <email> "<board-name-substring>" [role]
//   e.g. node server/assign-board.js renato.x@emeal.nttdata.com "DevSecOps"
if (!process.env.VERCEL) require('dotenv').config();
const db = require('./db');
const { assignMember } = require('./auth/access');

const SUPER_ADMIN_EMAIL = 'brunolopesmello86@gmail.com';
const norm = e => String(e || '').trim().toLowerCase();
const domainOf = e => norm(e).split('@')[1] || '';

async function main() {
  const email = norm(process.argv[2]);
  const boardQuery = process.argv[3];
  const role = process.argv[4] || 'facilitator';
  if (!email || !boardQuery) { console.error('Usage: node server/assign-board.js <email> "<board-name-substring>" [role]'); process.exit(1); }

  const dom = domainOf(email);
  const orgRow = (await db.query('SELECT org_id FROM org_email_domains WHERE domain=$1', [dom])).rows[0];
  if (!orgRow) { console.error(`Domain @${dom} is not allowlisted. Run: node server/register-domain.js ${dom} "<Company>"`); process.exit(1); }

  let user = (await db.query('SELECT id, status FROM users WHERE email=$1', [email])).rows[0];
  if (!user) {
    user = (await db.query("INSERT INTO users (email, org_id, status) VALUES ($1,$2,'pending_verification') RETURNING id, status", [email, orgRow.org_id])).rows[0];
    console.log(`  + created pending account for ${email} (activates on first signup)`);
  }

  const boards = (await db.query(
    `SELECT g.id, g.name, c.name company FROM games g JOIN companies c ON c.id=g.company_id WHERE g.name ILIKE $1`, ['%' + boardQuery + '%'])).rows;
  if (boards.length === 0) { console.error(`No board matches "${boardQuery}".`); process.exit(1); }
  if (boards.length > 1) { console.error(`"${boardQuery}" matches ${boards.length} boards — be more specific:`); boards.forEach(b => console.error('   - ' + b.company + ' / ' + b.name)); process.exit(1); }
  const board = boards[0];

  const superId = (await db.query('SELECT id FROM users WHERE email=$1', [SUPER_ADMIN_EMAIL])).rows[0].id;
  await assignMember(board.id, user.id, role, superId);
  console.log(`✓ ${email}  →  ${board.company} / ${board.name}   (role: ${role})`);
  process.exit(0);
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
