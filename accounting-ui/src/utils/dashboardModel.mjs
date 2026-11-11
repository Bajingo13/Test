// Dashboard helpers - pure, no React, unit-tested in
// utils/__tests__/dashboardModel.test.js. Every number the dashboard shows
// comes from GET /api/dashboard/summary (backend/services/dashboardService.js);
// the helpers here only pick periods, format, and describe that data.

export const PRESETS = [
  { id: "today", label: "Today" },
  { id: "week", label: "This Week" },
  { id: "month", label: "This Month" },
  { id: "quarter", label: "This Quarter" },
  { id: "year", label: "This Year" },
  { id: "custom", label: "Custom Range" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, "0");

// Today in the browser's own calendar (not UTC - toISOString() would give
// yesterday's date before 8 AM in Manila).
export function todayLocal(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parts(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

export function isValidDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const { y, m, d } = parts(value);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Period-to-date ranges ending today; weeks start on Monday.
export function presetRange(preset, today) {
  const { y, m, d } = parts(today);
  if (preset === "today") return { from: today, to: today };
  if (preset === "week") {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    return { from: dt.toISOString().slice(0, 10), to: today };
  }
  if (preset === "month") return { from: `${y}-${pad(m)}-01`, to: today };
  if (preset === "quarter") return { from: `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`, to: today };
  if (preset === "year") return { from: `${y}-01-01`, to: today };
  return null;
}

export function validateRange({ from, to }) {
  if (!isValidDate(from) || !isValidDate(to)) return "Enter both dates.";
  if (from > to) return "The start date must be on or before the end date.";
  const days = (Date.UTC(...toUtcArgs(to)) - Date.UTC(...toUtcArgs(from))) / 86400000;
  if (days > 5 * 366) return "The dashboard period is limited to five years.";
  return "";
}

function toUtcArgs(ymd) {
  const { y, m, d } = parts(ymd);
  return [y, m - 1, d];
}

// ---------------------------------------------------------------------------
// Formatting

export function formatMoney(amount, currency) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return "-";
  const n = Number(amount);
  const text = Math.abs(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = currency?.symbol ? `${currency.symbol}` : currency?.code ? `${currency.code} ` : "";
  return `${n < 0 ? "-" : ""}${prefix}${text}`;
}

export function formatCompact(amount) {
  const n = Number(amount) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function formatDate(ymd) {
  if (!isValidDate(ymd)) return ymd || "";
  const { y, m, d } = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatDateTime(value) {
  if (!value) return "";
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? "" : dt.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function bucketLabel(bucket, granularity) {
  const { y, m, d } = parts(bucket.from);
  if (granularity === "day") return `${MONTHS[m - 1]} ${d}`;
  if (granularity === "week") return `${MONTHS[m - 1]} ${d}`;
  if (granularity === "month") return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
  if (granularity === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return String(y);
}

export function periodText(from, to) {
  return from === to ? formatDate(from) : `${formatDate(from)} - ${formatDate(to)}`;
}

// ---------------------------------------------------------------------------
// Section state: what a widget should render for one summary section.
//   loading   - request in flight and nothing to show yet
//   error     - the whole request failed, or this section failed
//   forbidden - the server withheld it (no permission for that report)
//   ok        - data
export function sectionState(request, key) {
  if (request.status === "error") return { kind: "error", message: request.message || "Unable to load data." };
  if (!request.data) return { kind: request.status === "idle" ? "idle" : "loading" };
  const s = request.data.sections?.[key];
  if (!s) return { kind: "error", message: "Unable to load data." };
  if (s.status === "forbidden") return { kind: "forbidden" };
  if (s.status !== "ok") return { kind: "error", message: s.message || "Unable to load data." };
  return { kind: "ok", data: s, stale: request.status === "loading" };
}

// ---------------------------------------------------------------------------
// Layout (saved in this browser only; the data is always fetched fresh)

export function sanitizeLayout(saved, libraryIds, defaults) {
  if (!Array.isArray(saved)) return [...defaults];
  const seen = new Set();
  const out = [];
  for (const id of saved) {
    if (typeof id === "string" && libraryIds.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function moveItem(list, id, direction) {
  const index = list.indexOf(id);
  const next = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || next < 0 || next >= list.length) return list;
  const copy = [...list];
  [copy[index], copy[next]] = [copy[next], copy[index]];
  return copy;
}

// ---------------------------------------------------------------------------
// Derived views over the summary. Arithmetic on server figures only - no
// new accounting rules, no estimates.

// Cash position if the open receivables and payables due by each horizon
// (counted from the period end, overdue items included) were settled.
export function cashOutlook(sections) {
  const cash = sections?.cash;
  const ar = sections?.receivables;
  const ap = sections?.payables;
  if (cash?.status !== "ok" || ar?.status !== "ok" || ap?.status !== "ok") return null;
  const at = (days) => {
    const inflow = days === 7 ? ar.dueWithin7 : ar.dueWithin30;
    const outflow = days === 7 ? ap.dueWithin7 : ap.dueWithin30;
    return { days, inflow, outflow, position: round2(cash.endingBalance + inflow - outflow) };
  };
  return { current: cash.endingBalance, horizons: [at(7), at(30)] };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (num, den) => (Math.abs(Number(den)) > 0.005 ? round2((Number(num) / Number(den)) * 100) : null);

// Ratios over validated figures; null when the denominator is zero.
export function financialIndicators(sections) {
  const out = [];
  const inc = sections?.income;
  const bal = sections?.balance;
  const cash = sections?.cash;
  const ar = sections?.receivables;
  const ap = sections?.payables;
  if (inc?.status === "ok") out.push({ id: "netMargin", label: "Net profit margin", value: inc.netMargin, unit: "%", hint: "Net income / revenue for the period" });
  if (bal?.status === "ok") out.push({ id: "debtToEquity", label: "Liabilities to equity", value: pct(bal.totalLiabilities, bal.totalEquity), unit: "%", hint: "Total liabilities / total equity" });
  if (ar?.status === "ok") out.push({ id: "arOverdue", label: "Receivables overdue", value: pct(ar.overdue, ar.total), unit: "%", hint: "Overdue / total open receivables" });
  if (ap?.status === "ok") out.push({ id: "apOverdue", label: "Payables past due", value: pct(ap.overdue, ap.total), unit: "%", hint: "Past due / total open payables" });
  if (cash?.status === "ok" && ap?.status === "ok") {
    out.push({ id: "cashCover", label: "Cash to payables due in 30 days", value: pct(cash.endingBalance, ap.dueWithin30), unit: "%", hint: "Bank balance / payables due within 30 days" });
  }
  return out;
}

// Plain-language summary lines built only from the figures in the summary.
export function summaryLines(summary) {
  if (!summary) return [];
  const s = summary.sections || {};
  const cur = summary.meta?.currency;
  const lines = [];
  if (s.income?.status === "ok") {
    lines.push({ title: "Profit", text: `Revenue ${formatMoney(s.income.revenue, cur)}, net income ${formatMoney(s.income.netIncome, cur)} for the period.` });
  }
  if (s.cash?.status === "ok") {
    lines.push({
      title: "Cash",
      text: s.cash.accounts.length
        ? `${formatMoney(s.cash.endingBalance, cur)} across ${s.cash.accounts.length} bank account(s) as of ${formatDate(summary.meta.to)}.`
        : "No bank accounts are set up.",
    });
  }
  if (s.receivables?.status === "ok") {
    lines.push({
      title: "Collections",
      text: s.receivables.total > 0
        ? `${formatMoney(s.receivables.total, cur)} open, ${formatMoney(s.receivables.overdue, cur)} overdue (${s.receivables.overdueCount} document(s)).`
        : "No open receivables.",
    });
  }
  if (s.payables?.status === "ok") {
    lines.push({
      title: "Payables",
      text: s.payables.total > 0
        ? `${formatMoney(s.payables.total, cur)} open, ${formatMoney(s.payables.dueSoon, cur)} due within 7 days.`
        : "No open payables.",
    });
  }
  return lines;
}

export function seriesMax(series, keys) {
  let max = 0;
  for (const p of series || []) for (const k of keys) max = Math.max(max, Math.abs(Number(p[k]) || 0));
  return max;
}

export function hasSeriesData(series, keys) {
  return seriesMax(series, keys) > 0.005;
}

// Audit actions shown as readable verbs.
export function activityVerb(action) {
  const map = {
    CREATE: "created",
    UPDATE: "updated",
    EDIT: "edited",
    DELETE: "deleted",
    POST: "posted",
    APPROVE: "approved",
    REJECT: "rejected",
    SUBMIT: "submitted",
    VOID: "voided",
    CANCEL: "cancelled",
    REVERSE: "reversed",
    CONVERT_TO_APV: "converted to APV",
    LOGIN: "signed in",
  };
  return map[String(action || "").toUpperCase()] || String(action || "").toLowerCase().replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Per-user browser storage. Layout and period are kept per authenticated
// user so two people on one browser never share them; with no known user
// nothing is stored. (The old unscoped keys are never read.)

export const LAYOUT_KEY_PREFIX = "astrea_ai_dashboard_widgets";
export const PERIOD_KEY_PREFIX = "astrea_dashboard_period";

export function storageKeys(userId) {
  const id = String(userId ?? "").trim();
  if (!/^[1-9]\d*$/.test(id)) return null;
  return { layout: `${LAYOUT_KEY_PREFIX}:user:${id}`, period: `${PERIOD_KEY_PREFIX}:user:${id}` };
}

function readJson(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readUserLayout(storage, userId, libraryIds, defaults) {
  const keys = storageKeys(userId);
  const saved = keys ? readJson(storage, keys.layout) : null;
  return sanitizeLayout(saved ?? defaults, libraryIds, defaults);
}

export function writeUserLayout(storage, userId, ids) {
  const keys = storageKeys(userId);
  return keys ? writeJson(storage, keys.layout, ids) : false;
}

export function readUserPeriod(storage, userId, today, fallback = "month") {
  const keys = storageKeys(userId);
  const saved = keys ? readJson(storage, keys.period) : null;
  if (saved?.preset === "custom" && !validateRange(saved)) return { preset: "custom", from: saved.from, to: saved.to };
  const preset = PRESETS.some((p) => p.id === saved?.preset && p.id !== "custom") ? saved.preset : fallback;
  return { preset, ...presetRange(preset, today) };
}

export function writeUserPeriod(storage, userId, period) {
  const keys = storageKeys(userId);
  if (!keys) return false;
  return writeJson(storage, keys.period, period.preset === "custom" ? { preset: "custom", from: period.from, to: period.to } : { preset: period.preset });
}

// ---------------------------------------------------------------------------
// Navigation permissions. The page a link opens enforces its own access on
// the server; the dashboard only hides links the user could not use. Until
// permissions are known every link is hidden (fail closed).

export const PATH_PERMISSIONS = {
  "/transactions/invoice": ["TRANSACTIONS.INVOICE", "CREATE"],
  "/transactions/apv": ["TRANSACTIONS.APV", "VIEW"],
  "/transactions/rfp": ["TRANSACTIONS.RFP", "VIEW"],
  "/coa": ["FILESETUP.COA", "VIEW"],
  "/general-libraries": ["FILESETUP.GENLIB", "VIEW"],
  "/report-sections": ["FILESETUP.REPORT_SECTIONS", "VIEW"],
  "/reports/trial-balance": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/income-statement": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/balance-sheet": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/account-analysis": ["REPORTS.FINANCIAL", "VIEW"],
  "/reports/ar-aging": ["REPORTS.AR", "VIEW"],
  "/reports/ap-aging": ["REPORTS.AP", "VIEW"],
  "/reports/bank-reconciliation": ["REPORTS.BANK_RECONCILIATION", "VIEW"],
};

// From the GET /api/me/permissions body: { user: { roleCode }, permissions: [{ moduleKey, action, granted }] }.
export function accessFromMe(me) {
  const granted = new Set();
  for (const p of me?.permissions || []) if (p?.granted) granted.add(`${p.moduleKey}.${p.action}`);
  return { ready: true, superAdmin: me?.user?.roleCode === "SUPER_ADMIN", granted };
}

export function canOpen(access, path) {
  if (!access?.ready) return false;
  if (access.superAdmin) return true;
  const base = String(path || "").split("?")[0];
  const rule = PATH_PERMISSIONS[base];
  if (!rule) return false;
  return access.granted.has(`${rule[0]}.${rule[1]}`);
}
