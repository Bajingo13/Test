// In-process SMTP sink for tests: listens on 127.0.0.1 (ephemeral port), keeps
// every message in memory and NEVER relays anything - no real e-mail can leave.
//
//   const sink = await startSmtpSink();
//   sink.mode = "accept" | "reject" | "hang";   // hang = never send the greeting
//   sink.useEnv();   // points SMTP_* at the sink (dummy credentials)
//   sink.messages   // [{ from, to: [...], data, text }]
//   await sink.close();
const net = require("net");

const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM",
  "SMTP_CONNECTION_TIMEOUT_MS", "SMTP_GREETING_TIMEOUT_MS", "SMTP_SOCKET_TIMEOUT_MS", "SMTP_SEND_TIMEOUT_MS"];

// Quoted-printable soft line breaks / =XX escapes, so tests can read links.
function decodeQuotedPrintable(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function startSmtpSink() {
  const sockets = new Set();
  const sink = {
    mode: "accept",
    messages: [],
    port: 0,
    saved: {},
    useEnv(extra = {}) {
      for (const k of SMTP_KEYS) delete process.env[k];
      Object.assign(process.env, {
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(sink.port),
        SMTP_USER: "sink-user",
        SMTP_PASS: "sink-pass-not-a-secret",
        SMTP_FROM: "Accounting Test <no-reply@example.test>",
        ...extra,
      });
    },
    clearEnv() {
      for (const k of SMTP_KEYS) delete process.env[k];
    },
    restoreEnv() {
      for (const k of SMTP_KEYS) {
        if (sink.saved[k] === undefined) delete process.env[k];
        else process.env[k] = sink.saved[k];
      }
    },
    to(address) {
      return sink.messages.filter((m) => m.to.some((t) => t.toLowerCase().includes(address.toLowerCase())));
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r()));
      sink.restoreEnv();
    },
  };
  for (const k of SMTP_KEYS) sink.saved[k] = process.env[k];

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    if (sink.mode === "hang") return; // accept the TCP connection, never greet
    let mode = "cmd";
    let buf = "";
    let msg = { from: "", to: [], data: "" };
    const say = (s) => sock.write(s + "\r\n");
    say("220 localhost test sink");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === "data") {
          if (line === ".") {
            const text = decodeQuotedPrintable(msg.data);
            sink.messages.push({ ...msg, text });
            msg = { from: "", to: [], data: "" };
            mode = "cmd";
            say("250 OK queued");
          } else msg.data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          continue;
        }
        if (mode === "authlogin1") { mode = "authlogin2"; say("334 UGFzc3dvcmQ6"); continue; }
        if (mode === "authlogin2") { mode = "cmd"; say("235 Authenticated"); continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (cmd === "HELO") say("250 localhost");
        else if (cmd === "AUTH") {
          if (/^AUTH LOGIN/i.test(line)) { mode = "authlogin1"; say("334 VXNlcm5hbWU6"); } else say("235 Authenticated");
        } else if (cmd === "MAIL") {
          if (sink.mode === "reject") say("550 5.7.1 Sender rejected by test sink");
          else { msg.from = line.replace(/^MAIL FROM:/i, "").trim(); say("250 OK"); }
        } else if (cmd === "RCPT") { msg.to.push(line.replace(/^RCPT TO:/i, "").trim()); say("250 OK"); }
        else if (cmd === "DATA") { mode = "data"; say("354 End with ."); }
        else if (cmd === "QUIT") { say("221 Bye"); sock.end(); }
        else if (cmd === "RSET") say("250 OK");
        else say("250 OK");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  sink.port = server.address().port;
  return sink;
}

module.exports = { startSmtpSink };
