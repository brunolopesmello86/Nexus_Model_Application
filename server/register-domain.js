// Allowlist an email domain to a company (organization) — needed so people from
// that domain can sign up. Until the admin console (step 5) exists, use this CLI.
//
//   node server/register-domain.js <domain> "<Company Name>"
//   e.g.  node server/register-domain.js creativita-co.com "Creativita"
//
// If a company with a matching slug exists it is reused; otherwise it is created.
if (!process.env.VERCEL) require('dotenv').config();
const db = require('./db');

const slugify = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

async function main() {
  const domain = String(process.argv[2] || '').trim().toLowerCase().replace(/^@/, '');
  const companyName = String(process.argv[3] || '').trim();
  if (!domain || !domain.includes('.') || !companyName) {
    console.error('Usage: node server/register-domain.js <domain> "<Company Name>"');
    process.exit(1);
  }
  const slug = slugify(companyName);
  let company = (await db.query('SELECT id, name FROM companies WHERE slug=$1', [slug])).rows[0];
  if (!company) {
    company = (await db.query('INSERT INTO companies (name, slug) VALUES ($1,$2) RETURNING id, name', [companyName, slug])).rows[0];
    console.log(`✓ Created company "${company.name}" (${slug}).`);
  } else {
    console.log(`✓ Using existing company "${company.name}" (${slug}).`);
  }
  await db.query(
    'INSERT INTO org_email_domains (org_id, domain) VALUES ($1,$2) ON CONFLICT (org_id, domain) DO NOTHING',
    [company.id, domain]);
  console.log(`✓ Domain "${domain}" is now allowlisted for "${company.name}".`);
  console.log(`  People with @${domain} emails can now sign up.`);
  process.exit(0);
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
