// Transactional email via the Resend HTTP API (no SDK dependency; uses global fetch, Node 18+).
// Sender identity uses your verified subdomain, with a friendly display name.
const FROM = 'Nexus Board <login@nexus.creativita-co.com>';

async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Email send failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Build the verification-code email. NOTE: the code is passed in but never logged.
function verificationCodeEmail(code, purpose) {
  const reason =
    purpose === 'password_reset' ? 'reset your password' :
    purpose === 'new_device'     ? 'confirm sign-in from a new device' :
                                   'verify your email';
  const subject = `Your Nexus verification code: ${code}`;
  const text =
    `Your Nexus Board verification code is ${code}.\n` +
    `It expires in 10 minutes. Use it to ${reason}.\n` +
    `If you didn't request this, you can ignore this email.`;
  const html =
    `<!doctype html><html><body style="margin:0;font-family:Segoe UI,Arial,sans-serif;background:#F4F7FB;padding:32px">
     <div style="max-width:440px;margin:0 auto;background:#fff;border:1px solid #DDE5F0;border-radius:14px;padding:32px">
       <div style="font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#009AA4;font-weight:700">Nexus Board</div>
       <h1 style="font-size:20px;color:#0B1F3A;margin:12px 0 6px">Your verification code</h1>
       <p style="color:#33425A;font-size:14px;line-height:1.6;margin:0 0 20px">Use this code to ${reason}. It expires in 10 minutes.</p>
       <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#0B1F3A;background:#F4F7FB;border:1px solid #DDE5F0;border-radius:10px;padding:18px;text-align:center">${code}</div>
       <p style="color:#6B7686;font-size:12px;margin:22px 0 0">If you didn't request this, you can safely ignore this email.</p>
     </div></body></html>`;
  return { subject, text, html };
}

module.exports = { sendEmail, verificationCodeEmail, FROM };
