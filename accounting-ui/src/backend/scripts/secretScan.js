// Scans the repository for committed secrets (SEC-3). No dependencies - only
// node and git. Findings show a masked value, never the secret itself. Exits 1
// when anything is found.
//
// Usage (or: npm run secrets:scan -- [--staged|--history]):
//   node scripts/secretScan.js             tracked + untracked, non-ignored files
//   node scripts/secretScan.js --staged    what is about to be committed
//   node scripts/secretScan.js --history   every commit on every branch
//
// To run it before each commit, put this in a pre-commit hook:
//   node accounting-ui/src/backend/scripts/secretScan.js --staged

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const VALUE_RULES = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["webhook-secret", /\bwhsec_[A-Za-z0-9]{20,}/],
  ["supabase-secret", /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // A browser-exposed (VITE_) variable must never carry a secret.
  ["frontend-secret-variable", /\bVITE_[A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE|TOKEN|API_KEY)[A-Z0-9_]*\b/],
];

const CONNECTION_URL = /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp|smtp):\/\/[^:/\s"'`]+:([^@\s"'`]+)@/;
const HARDCODED_LITERAL = /(?:password|passwd|pwd|secret|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?token)["']?\s*[:=]\s*["'`]([^"'`\s]{6,})["'`]/i;
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PASSWORD|PASS|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?([^"'\s#]+)/;
const PLACEHOLDER = /^(?:x+|\*+|\.+|<.*>|\[.*\]|\$\{.*|password|passwd|new-password|current-password|changeme|example.*|your[-_].*|placeholder.*|secret|redacted)$|test-only|not-for-production/i;

const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|ppk)|id_(?:rsa|dsa|ecdsa|ed25519)|\.git-credentials|\.netrc|\.my\.cnf|\.mylogin\.cnf|[^/]*credentials[^/]*\.json|[^/]*service[-_]?account[^/]*\.json|client_secret[^/]*\.json)$/i;
// Tracked on purpose: templates, plus the frontend's build-time config. Their
// content is still scanned.
const ALLOWED_ENV_FILE = /(?:^|\/)\.env(?:\.[^/]*)?\.example$|^accounting-ui\/\.env\.(?:development|production)$/;
const TEST_OR_DOC = /__tests__\/|\.test\.[cm]?js$|\.md$|\.example$/;

// Clearly fake value kept on purpose: the audit-log redaction test needs a
// JWT-shaped string to prove it gets redacted.
const ALLOWED_FINDINGS = [{ rule: "jwt", file: "accounting-ui/src/backend/__tests__/auditLogs.http.test.js" }];

// Already public in history; rewriting it is a separate decision (SEC-1).
// --history still lists these, but they don't fail the scan.
const KNOWN_HISTORY_COMMITS = ["170f8b5", "21d372e"];

function mask(value) {
  return `${value.slice(0, 2)}****(len ${value.length})`;
}

function isSensitiveFile(file) {
  return SENSITIVE_FILE.test(file) && !ALLOWED_ENV_FILE.test(file);
}

function scanLine(file, line) {
  const found = [];
  for (const [rule, pattern] of VALUE_RULES) {
    const m = line.match(pattern);
    if (m) found.push({ rule, value: mask(m[0]) });
  }
  const url = line.match(CONNECTION_URL);
  if (url && !PLACEHOLDER.test(url[1])) found.push({ rule: "connection-url-password", value: mask(url[1]) });
  if (!TEST_OR_DOC.test(file)) {
    const literal = line.match(HARDCODED_LITERAL);
    if (literal && !PLACEHOLDER.test(literal[1])) found.push({ rule: "hardcoded-credential", value: mask(literal[1]) });
  }
  if (/(?:^|\/)\.env(?:\.[^/]*)?$/.test(file) || /\.env\.[^/]*example$/.test(file)) {
    const env = line.match(ENV_ASSIGNMENT);
    if (env && !PLACEHOLDER.test(env[1])) found.push({ rule: "env-secret-value", value: mask(env[1]) });
  }
  return found.filter((f) => !ALLOWED_FINDINGS.some((a) => a.rule === f.rule && a.file === file));
}

function scanText(file, text) {
  return text.split(/\r?\n/).flatMap((line, i) => scanLine(file, line).map((f) => ({ ...f, file, line: i + 1 })));
}

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: __dirname, encoding: "utf8" }).trim();
}

function scanTree(root = repoRoot()) {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter(Boolean);
  const findings = [];
  for (const file of files) {
    if (isSensitiveFile(file)) findings.push({ rule: "sensitive-file", value: "-", file, line: 0 });
    let buf;
    try {
      buf = fs.readFileSync(path.join(root, file));
    } catch {
      continue; // listed but deleted from the working tree
    }
    if (buf.length > 5 * 1024 * 1024 || buf.includes(0)) continue;
    findings.push(...scanText(file, buf.toString("utf8")));
  }
  return findings;
}

// Reads `git log -p` / `git diff` output, checking added lines and added paths.
function scanDiff(args, root = repoRoot()) {
  return new Promise((resolve, reject) => {
    const git = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    const findings = [];
    let commit = null;
    let file = "";
    readline.createInterface({ input: git.stdout }).on("line", (line) => {
      if (line.startsWith("COMMIT ")) commit = line.slice(7);
      else if (line.startsWith("+++ ")) {
        file = line.startsWith("+++ b/") ? line.slice(6) : "";
        if (isSensitiveFile(file)) findings.push({ rule: "sensitive-file", value: "-", file, commit });
      } else if (line.startsWith("+") && file) {
        for (const f of scanLine(file, line.slice(1))) findings.push({ ...f, file, commit });
      }
    });
    git.on("error", reject);
    git.on("close", (code) => (code ? reject(new Error(`git exited with ${code}`)) : resolve(findings)));
  });
}

function scanHistory(root) {
  return scanDiff(["log", "--all", "-p", "--no-color", "--no-textconv", "-U0", "--format=COMMIT %h", "--", ".", ":!*package-lock.json", ":!*node_modules/*"], root);
}

function scanStaged(root) {
  return scanDiff(["diff", "--cached", "--no-color", "--no-textconv", "-U0"], root);
}

function report(findings) {
  for (const f of findings) {
    const where = f.commit ? `${f.commit} ${f.file}` : `${f.file}${f.line ? `:${f.line}` : ""}`;
    console.log(`${f.rule}  ${where}  ${f.value}`);
  }
}

async function main(mode) {
  const findings = mode === "--history" ? await scanHistory() : mode === "--staged" ? await scanStaged() : scanTree();
  const isKnown = (f) => f.commit && KNOWN_HISTORY_COMMITS.includes(f.commit);
  const known = findings.filter(isKnown);
  const fresh = findings.filter((f) => !isKnown(f));
  if (known.length) {
    console.log(`Known, already-public findings (${known.length}):`);
    report(known);
  }
  if (fresh.length) {
    console.log(`Possible secrets (${fresh.length}):`);
    report(fresh);
    process.exitCode = 1;
  } else {
    console.log("Secret scan: no new findings.");
  }
}

if (require.main === module) {
  main(process.argv[2]).catch((err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}

module.exports = { mask, isSensitiveFile, scanLine, scanText, scanTree, scanHistory, KNOWN_HISTORY_COMMITS };
