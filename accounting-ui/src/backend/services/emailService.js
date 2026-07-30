const nodemailer = require("nodemailer");

// SMTP config comes from env vars the user fills in later (SMTP_HOST,
// SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM). If they're not set, or the
// send fails for any reason, we never crash the invitation workflow - the
// invitation record is already created regardless of email delivery, and
// the raw accept-invite link is logged server-side (never the token hash,
// never any other secret) so the flow stays fully testable and an admin
// can always manually share the link.
function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let cachedTransporter = null;
function getTransporter() {
  if (!isConfigured()) return null;
  if (cachedTransporter) return cachedTransporter;

  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return cachedTransporter;
}

// Returns { delivered: boolean, reason?: string } - never throws, so
// callers can always continue the invitation flow.
async function sendInvitationEmail({ to, fullName, roleName, companyName, acceptUrl, expiresAt }) {
  const subject = `You're invited to AstreaBlue Accounting System`;
  const text = `Hi ${fullName},

You've been invited to join ${companyName || "AstreaBlue Accounting System"} as a ${roleName}.

Set up your account here (link expires ${new Date(expiresAt).toLocaleString()}):
${acceptUrl}

If you weren't expecting this invitation, you can ignore this email.`;

  const html = `
    <p>Hi ${fullName},</p>
    <p>You've been invited to join <strong>${companyName || "AstreaBlue Accounting System"}</strong> as a <strong>${roleName}</strong>.</p>
    <p><a href="${acceptUrl}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;">Set Up Your Account</a></p>
    <p style="color:#6b7280;font-size:13px;">This link expires ${new Date(expiresAt).toLocaleString()}. If you weren't expecting this invitation, you can ignore this email.</p>
  `;

  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[emailService] SMTP not configured - invitation link for ${to}: ${acceptUrl}`);
    return { delivered: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
    return { delivered: true };
  } catch (err) {
    console.error("SEND INVITATION EMAIL ERROR:", err.message);
    console.log(`[emailService] Delivery failed - invitation link for ${to}: ${acceptUrl}`);
    return { delivered: false, reason: "SEND_FAILED" };
  }
}

module.exports = { isConfigured, sendInvitationEmail };
