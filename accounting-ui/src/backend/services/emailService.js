const nodemailer = require("nodemailer");

// SMTP config comes from env vars the user fills in later (SMTP_HOST,
// SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM). If they're not set, or the
// send fails for any reason, we never crash the invitation workflow - the
// invitation record is already created regardless of email delivery, and
// the caller hands the accept-invite link to the inviting admin in the API
// response so it can be shared manually.
//
// The accept-invite link carries the raw invitation token, which is enough
// to accept the invitation. It is therefore NEVER written to the server log
// (stdout ends up in hosting/platform logs) - only the recipient and the
// delivery outcome are. The same holds for e-mail verification links.
//
// Transport security and reliability:
//   - port 465: TLS from the first byte (secure: true);
//   - any other port (587 in particular): STARTTLS is REQUIRED (requireTLS) -
//     the message is never sent in plaintext if the server does not offer it.
//     The single exception is a loopback host (127.0.0.1 / localhost / ::1),
//     i.e. a local test mail sink on the developer's own machine;
//   - TLS 1.2 minimum, certificate verification left ON (nodemailer default);
//   - connection / greeting / socket timeouts plus an overall per-message
//     deadline, so an unreachable or stalled SMTP server can never hold a
//     request for long. Optional overrides: SMTP_CONNECTION_TIMEOUT_MS,
//     SMTP_GREETING_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS, SMTP_SEND_TIMEOUT_MS.
// Credentials live only in the environment and are never logged or returned.
const DEFAULT_TIMEOUTS_MS = { connection: 10000, greeting: 10000, socket: 20000, send: 30000 };
const LOOPBACK_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function timeoutMs(envName, fallback) {
  const n = Number(process.env[envName]);
  return Number.isInteger(n) && n >= 100 && n <= 120000 ? n : fallback;
}

function smtpTimeouts() {
  return {
    connection: timeoutMs("SMTP_CONNECTION_TIMEOUT_MS", DEFAULT_TIMEOUTS_MS.connection),
    greeting: timeoutMs("SMTP_GREETING_TIMEOUT_MS", DEFAULT_TIMEOUTS_MS.greeting),
    socket: timeoutMs("SMTP_SOCKET_TIMEOUT_MS", DEFAULT_TIMEOUTS_MS.socket),
    send: timeoutMs("SMTP_SEND_TIMEOUT_MS", DEFAULT_TIMEOUTS_MS.send),
  };
}

// The nodemailer options for the current environment (exported for tests; it
// contains the SMTP password, so it must never be logged).
function transportOptions() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const implicitTls = port === 465;
  const t = smtpTimeouts();
  return {
    host,
    port,
    secure: implicitTls,
    requireTLS: !implicitTls && !LOOPBACK_HOST_RE.test(host),
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: t.connection,
    greetingTimeout: t.greeting,
    socketTimeout: t.socket,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  };
}

// One transporter per configuration (rebuilt if the SMTP_* environment changes).
let cachedTransporter = null;
let cachedKey = "";
function getTransporter() {
  if (!isConfigured()) return null;
  const options = transportOptions();
  const key = JSON.stringify([options.host, options.port, options.auth.user, options.auth.pass, options.connectionTimeout, options.greetingTimeout, options.socketTimeout]);
  if (cachedTransporter && cachedKey === key) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport(options);
  cachedKey = key;
  return cachedTransporter;
}

function fromAddress() {
  return process.env.SMTP_FROM || process.env.SMTP_USER;
}

// A delivery error as it may be logged: the error's code / SMTP response code
// and a shortened message, with the SMTP credentials scrubbed if a server or
// library ever echoed them back.
function safeErrorText(err) {
  let text = String(err?.message || err || "unknown error");
  for (const secret of [process.env.SMTP_PASS, process.env.SMTP_USER]) {
    if (secret && secret.length >= 3) text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/\s+/g, " ").slice(0, 200);
  const codes = [err?.code, err?.responseCode].filter(Boolean).join("/");
  return codes ? `${codes} ${text}` : text;
}

// sendMail with an overall deadline. Rejects on failure or timeout.
function sendWithDeadline(transporter, mail) {
  const { send } = smtpTimeouts();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`SMTP send timed out after ${send} ms`), { code: "ETIMEDOUT" })), send);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve().then(() => transporter.sendMail(mail)), deadline]).finally(() => clearTimeout(timer));
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
    console.log(`[emailService] SMTP not configured - invitation email for ${to} not sent; link returned to the inviter for manual sharing.`);
    return { delivered: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  try {
    await sendWithDeadline(transporter, { from: fromAddress(), to, subject, text, html });
    return { delivered: true };
  } catch (err) {
    console.error("SEND INVITATION EMAIL ERROR:", safeErrorText(err));
    console.log(`[emailService] Delivery failed - invitation email for ${to} not sent; link returned to the inviter for manual sharing.`);
    return { delivered: false, reason: "SEND_FAILED" };
  }
}

// Batch 8: generic best-effort document email (Official Receipt PDF, and
// any later document type). Same contract as sendInvitationEmail - never
// throws, returns { delivered: true } | { delivered: false, reason:
// "SMTP_NOT_CONFIGURED" | "SEND_FAILED" } - so the caller (POST
// /api/or/:id/email) always completes and always records an audit row.
// Reuses the cached transporter and the existing SMTP_* env vars; no new
// config, no secret ever returned or logged.
//
// attachments: [{ filename, content }] where `content` is a Buffer /
// Uint8Array (nodemailer accepts both natively) - typically one entry, the
// customer-facing "without entries" PDF from the existing print framework.
async function sendDocumentEmail({ to, subject, text, html, attachments = [] }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[emailService] SMTP not configured - document email for ${to} not sent (subject: ${subject}).`);
    return { delivered: false, reason: "SMTP_NOT_CONFIGURED" };
  }

  try {
    await sendWithDeadline(transporter, {
      from: fromAddress(),
      to,
      subject,
      text: text || "",
      ...(html ? { html } : {}),
      ...(attachments && attachments.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
              contentType: a.contentType || "application/pdf",
            })),
          }
        : {}),
    });
    return { delivered: true };
  } catch (err) {
    console.error("SEND DOCUMENT EMAIL ERROR:", safeErrorText(err));
    return { delivered: false, reason: "SEND_FAILED" };
  }
}

// Security alert after repeated failed logins (services/securityAlertService.js).
// Contains NO password, hash, token, IP address or internal detail - only that
// repeated unsuccessful attempts were detected and what the user should do.
// Same contract as above: never throws; { delivered } | { delivered: false, reason }.
function securityAlertContent({ fullName, attempts, occurredAt }) {
  const when = (occurredAt instanceof Date ? occurredAt : new Date()).toUTCString();
  const subject = "Security Alert: unsuccessful login attempts on your account";
  const text = [
    `Hello ${fullName || ""},`.trim(),
    "",
    `Security Alert: We detected ${attempts === 3 ? "three" : attempts} unsuccessful login attempts on your account (latest: ${when}).`,
    "",
    "If this was you, you can ignore this message - your password was not changed.",
    "If this was not you, please secure your account: change your password and contact your administrator.",
    "",
    "This is an automated message from the Astrea accounting system.",
  ].join("\n");
  return { subject, text };
}

// Plain-text security messages (alert, e-mail verification, e-mail changed).
async function sendSecurityMessage(kind, { to, subject, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[emailService] SMTP not configured - ${kind} email not sent.`);
    return { delivered: false, reason: "SMTP_NOT_CONFIGURED" };
  }
  try {
    await sendWithDeadline(transporter, { from: fromAddress(), to, subject, text });
    return { delivered: true };
  } catch (err) {
    console.error(`SEND ${kind.toUpperCase()} EMAIL ERROR:`, safeErrorText(err));
    return { delivered: false, reason: "SEND_FAILED" };
  }
}

async function sendSecurityAlertEmail({ to, fullName, attempts, occurredAt }) {
  return sendSecurityMessage("security alert", { to, ...securityAlertContent({ fullName, attempts, occurredAt }) });
}

// E-mail verification for a SUPER_ADMIN's new notification address
// (services/accountEmailService.js). The link carries the raw one-time token -
// it goes in the message only, never in a log line.
function emailVerificationContent({ fullName, verifyUrl, expiresAt }) {
  const subject = "Confirm your notification email address";
  const text = [
    `Hello ${fullName || ""},`.trim(),
    "",
    "A request was made to use this address for security notifications on your accounting system account.",
    "To confirm it, open this link and select \"Confirm email\":",
    verifyUrl,
    "",
    `The link can be used once and expires ${new Date(expiresAt).toUTCString()}.`,
    "If you did not request this, ignore this message - nothing will change.",
    "",
    "This is an automated message from the Astrea accounting system.",
  ].join("\n");
  return { subject, text };
}

async function sendEmailVerificationEmail({ to, fullName, verifyUrl, expiresAt }) {
  return sendSecurityMessage("email verification", { to, ...emailVerificationContent({ fullName, verifyUrl, expiresAt }) });
}

// Courtesy notice to the PREVIOUS address after a verified change.
function emailChangedContent({ fullName, occurredAt }) {
  const when = (occurredAt instanceof Date ? occurredAt : new Date()).toUTCString();
  const subject = "Your notification email address was changed";
  const text = [
    `Hello ${fullName || ""},`.trim(),
    "",
    `The notification email address on your accounting system account was changed on ${when}. Security notices now go to the new, verified address.`,
    "If you did not make this change, contact your administrator immediately.",
    "",
    "This is an automated message from the Astrea accounting system.",
  ].join("\n");
  return { subject, text };
}

async function sendEmailChangedNotice({ to, fullName, occurredAt }) {
  return sendSecurityMessage("email changed notice", { to, ...emailChangedContent({ fullName, occurredAt }) });
}

module.exports = {
  isConfigured,
  sendInvitationEmail,
  sendDocumentEmail,
  sendSecurityAlertEmail,
  sendEmailVerificationEmail,
  sendEmailChangedNotice,
  securityAlertContent,
  emailVerificationContent,
  // exported for tests
  transportOptions,
  safeErrorText,
};
