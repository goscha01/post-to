// Transactional email — SendGrid.
//
// Post To's first outbound email use case is team invitations. Missing
// SENDGRID_API_KEY is treated as a soft failure: sendInviteEmail returns
// false, the caller logs a warning, and the invite record still exists so
// the owner can copy the invite link from the UI as a fallback. This lets
// local dev / a fresh Railway deploy work without breaking the /api/team
// endpoints hard.
//
// One SendGrid client is initialized lazily on first send.

const logger = require('../utils/logger');

let sg = null;
function getClient() {
  if (sg) return sg;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return null;
  try {
    // Lazy require: @sendgrid/mail is an optional-in-practice dep. If the
    // package isn't installed (e.g. someone building the FE only), don't
    // crash the whole backend at import time.
    // eslint-disable-next-line global-require
    const mail = require('@sendgrid/mail');
    mail.setApiKey(key);
    sg = mail;
    return sg;
  } catch (err) {
    logger.warn('email.sendgrid_require_failed', { error: err.message });
    return null;
  }
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Send a team-invite email. Returns true on delivery, false if skipped
// (missing config) or if SendGrid rejected the request.
async function sendInviteEmail({ to, inviterName, ownerName, roleLabel, inviteLink }) {
  const client = getClient();
  const from = process.env.SENDGRID_FROM_EMAIL;
  const fromName = process.env.SENDGRID_FROM_NAME || 'Post To';
  if (!client || !from) {
    logger.warn('email.invite_skipped_no_config', {
      to,
      has_client: !!client,
      has_from: !!from,
      invite_link: inviteLink,
    });
    return false;
  }

  const subject = `${inviterName} invited you to ${ownerName}'s workspace on Post To`;
  const text =
    `${inviterName} invited you to join ${ownerName}'s Post To workspace as ${roleLabel}.\n\n` +
    `Accept the invitation: ${inviteLink}\n\n` +
    `This link expires in 7 days. If you weren't expecting this, you can safely ignore it.`;
  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:520px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;font-size:20px;">You've been invited to Post To</h2>
  <p style="margin:0 0 16px;line-height:1.55;">
    <strong>${escapeHtml(inviterName)}</strong> invited you to join
    <strong>${escapeHtml(ownerName)}'s</strong> workspace on Post To as <strong>${escapeHtml(roleLabel)}</strong>.
  </p>
  <p style="margin:0 0 24px;">
    <a href="${inviteLink}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Accept invitation</a>
  </p>
  <p style="margin:0 0 8px;font-size:12px;color:#64748b;">Or paste this link into your browser:</p>
  <p style="margin:0 0 24px;font-size:12px;color:#334155;word-break:break-all;">${escapeHtml(inviteLink)}</p>
  <p style="margin:0;font-size:12px;color:#64748b;">This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.</p>
</div>`.trim();

  try {
    await client.send({
      to,
      from: { email: from, name: fromName },
      subject,
      text,
      html,
      categories: ['team-invite'],
    });
    logger.info('email.invite_sent', { to, inviter: inviterName, owner: ownerName });
    return true;
  } catch (err) {
    // SendGrid puts the useful bit in response.body
    const body = err?.response?.body;
    logger.error('email.invite_send_failed', {
      to,
      error: err.message,
      status: err?.code,
      sg_body: body ? JSON.stringify(body).slice(0, 800) : undefined,
    });
    return false;
  }
}

module.exports = { sendInviteEmail };
