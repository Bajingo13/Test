const pool = require("../db");
const PermissionService = require("./permissionService");
const CurrencyService = require("./currencyService");
const FinancialStatementStructureService = require("./financialStatementStructureService");
const LedgerReportService = require("./LedgerReportService");
const AgingReportService = require("./agingReportService");
const AuditLogService = require("./auditLogService"); // sanitize() only
const { HttpError } = require("../lib/httpError");

// Dashboard summary: a read-only VIEW over the accounting engine. It holds
// no accounting rules of its own - every figure comes from the service the
// matching report already uses, called with the same arguments:
//
//   revenue / net income ... financialStatementStructureService.buildIncomeStatement
//                            (Income Statement screen, structured view)
//   account overview ....... financialStatementStructureService.buildBalanceSheet
//                            (Balance Sheet screen, structured view)
//   cash and bank .......... LedgerReportService.getBeginningBalances/getLedgerRows
//                            over active bank_codes accounts (Daily Cash Position)
//   receivables / payables . agingReportService.getAgingRows + getBucketTotals
//                            + getSummaryByParty (AR / AP Aging, AR / AP Aging Summary)
//   activity ............... auditLogService.listAuditLogs (Audit Logs, same scope)
//
// All amounts are in the company's base currency - the ledger and the aging
// base columns already are; nothing is converted here.
//
// Each section is gated on the permission of the report it mirrors (checked
// here, server-side) and computed independently: a section the user may not
// see comes back { status: "forbidden" }, a section that fails comes back
// { status: "error" } - never as zero.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 5 * 366;
const RECENT_LIMIT = 8;
const TOP_PARTIES = 5;
const EPS = 0.005;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function parseDate(value, label) {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new HttpError(400, `${label} must be a date (YYYY-MM-DD).`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new HttpError(400, `${label} is not a valid date.`);
  return value;
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

function parsePeriod(query) {
  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");
  if (from > to) throw new HttpError(400, "from must be on or before to.");
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new HttpError(400, "The dashboard period is limited to five years.");
  return { from, to };
}

// Contiguous, non-overlapping chart buckets that exactly cover [from, to].
function buildBuckets(from, to) {
  const span = daysBetween(from, to) + 1;
  const granularity = span <= 14 ? "day" : span <= 98 ? "week" : span <= 397 ? "month" : span <= 1100 ? "quarter" : "year";
  const buckets = [];
  let start = from;
  while (start <= to) {
    const d = new Date(`${start}T00:00:00Z`);
    let end;
    if (granularity === "day") end = start;
    else if (granularity === "week") end = addDays(start, (7 - ((d.getUTCDay() + 6) % 7)) - 1); // through Sunday
    else if (granularity === "month") end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    else if (granularity === "quarter") end = new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + 3, 0)).toISOString().slice(0, 10);
    else end = `${d.getUTCFullYear()}-12-31`;
    if (end > to) end = to;
    buckets.push({ key: `b${buckets.length}`, from: start, to: end });
    start = addDays(end, 1);
  }
  return { granularity, buckets };
}

async function resolveCompany(user, query) {
  const requested = query.companyId;
  if (requested !== undefined && requested !== "") {
    const id = Number(requested);
    if (!Number.isInteger(id) || id <= 0 || String(requested).trim() !== String(id)) throw new HttpError(400, "companyId must be a positive whole number.");
  } else if (user.roleCode === "SUPER_ADMIN") {
    // No first/lowest-company default: the Super Admin chooses.
    throw new HttpError(400, "companyId is required.");
  }
  // Validates access for non-Super-Admin users; a user with exactly one
  // company gets it, a user with several must choose (400).
  return CurrencyService.resolveCompanyIdForWrite(user, requested || undefined);
}

async function loadCompany(companyId) {
  const [[company]] = await pool.query("SELECT id, name FROM companies WHERE id = ?", [companyId]);
  if (!company) throw new HttpError(404, "Company not found.");
  const [[currency]] = await pool.query(
    "SELECT currency_code AS code, currency_symbol AS symbol FROM currencies WHERE company_id = ? AND is_base_currency = 1 LIMIT 1",
    [companyId]
  );
  return { id: company.id, name: company.name, currency: currency ? { code: currency.code, symbol: currency.symbol } : null };
}

// Runs one section: forbidden without the permission, error on failure.
// Section payloads never carry their own top-level `status` key.
async function section(allowed, fn, label) {
  if (!allowed) return { status: "forbidden" };
  try {
    return { status: "ok", ...(await fn()) };
  } catch (err) {
    console.error(`DASHBOARD ${label} ERROR:`, err.message);
    return { status: "error", message: "Unable to load this data." };
  }
}

// ---------------------------------------------------------------------------
// Sections

// The builder fetches its columns one after another, so the chart buckets
// are split across a few concurrent calls of the SAME builder (identical
// classification and amounts per column - only the wall time changes).
const IS_BUCKETS_PER_CALL = 4;

async function incomeSection(companyId, period, buckets) {
  const build = (periods) => FinancialStatementStructureService.buildIncomeStatement({ companyId, mode: "condensed", periods });
  const groups = [];
  for (let i = 0; i < buckets.buckets.length; i += IS_BUCKETS_PER_CALL) groups.push(buckets.buckets.slice(i, i + IS_BUCKETS_PER_CALL));
  const [model, ...parts] = await Promise.all([build([{ key: "total", from: period.from, to: period.to }]), ...groups.map(build)]);
  const merged = (pick) => Object.assign({}, pick(model), ...parts.map(pick));
  const revenueBy = merged((m) => m.sectionSubtotals.REVENUE);
  const netBy = merged((m) => m.computed.NET_INCOME);
  const value = (obj, key) => round2(obj?.[key] || 0);
  const revenue = value(model.sectionSubtotals.REVENUE, "total");
  const netIncome = value(model.computed.NET_INCOME, "total");
  return {
    revenue,
    grossProfit: value(model.computed.GROSS_PROFIT, "total"),
    netIncome,
    netMargin: Math.abs(revenue) > EPS ? round2((netIncome / revenue) * 100) : null,
    unclassified: Boolean(model.unclassified?.present),
    crossCheckOk: [model, ...parts].every((m) => (m.crossCheck ? Boolean(m.crossCheck.ok) : true)),
    granularity: buckets.granularity,
    series: buckets.buckets.map((b) => ({
      from: b.from,
      to: b.to,
      revenue: value(revenueBy, b.key),
      netIncome: value(netBy, b.key),
    })),
  };
}

async function balanceSection(companyId, period) {
  const model = await FinancialStatementStructureService.buildBalanceSheet({
    companyId,
    mode: "condensed",
    columns: [{ key: "asof", label: "As of", date: period.to }],
  });
  const v = (obj) => round2(obj?.asof || 0);
  return {
    asOf: period.to,
    totalAssets: v(model.computed.TOTAL_ASSETS),
    totalLiabilities: v(model.computed.TOTAL_LIABILITIES),
    totalEquity: v(model.computed.TOTAL_SHAREHOLDERS_EQUITY),
    balanced: Boolean(model.balanceCheck?.balanced),
    unclassified: Boolean(model.unclassified?.present),
  };
}

async function cashSection(companyId, period, buckets, { reconAllowed }) {
  // Same account set as the Daily Cash Position report: active bank_codes
  // rows linked to a COA code (bank_codes is shared master data; every
  // balance below is this company's own ledger on that account).
  const [banks] = await pool.query(
    `SELECT id, bank_code AS bankCode, bank_name AS bankName, account_name AS accountName, account_no AS accountNo,
            coa_code AS coaCode, status
       FROM bank_codes
      WHERE status = 'ACTIVE' AND coa_code IS NOT NULL AND coa_code != ''
      ORDER BY bank_code`
  );
  if (!banks.length) {
    return { accounts: [], openingBalance: 0, inflows: 0, outflows: 0, endingBalance: 0, granularity: buckets.granularity, series: [] };
  }
  const codes = [...new Set(banks.map((b) => b.coaCode))];
  // Movements per account and day from the same Posted-only union the
  // ledger reports use (LedgerReportService.buildTransactionUnionSql), summed
  // in SQL - the same debit/credit amounts as Daily Cash Position.
  const unionSql = LedgerReportService.buildTransactionUnionSql("BETWEEN ? AND ?");
  const movements = pool
    .query(
      `SELECT tx.account_code, tx.transaction_date, SUM(tx.debit) AS debit, SUM(tx.credit) AS credit
         FROM (${unionSql}) tx
        WHERE tx.account_code IN (?)
        GROUP BY tx.account_code, tx.transaction_date`,
      [...Array(9).fill([period.from, period.to, companyId]).flat(), codes]
    )
    .then(([r]) => r);
  const [opening, rows, titles] = await Promise.all([
    LedgerReportService.getBeginningBalances({ before: period.from, accountCodes: codes, companyId }),
    movements,
    pool.query("SELECT code, title, account_class FROM chart_of_accounts WHERE code IN (?)", [codes]).then(([r]) => r),
  ]);

  const byCode = new Map(codes.map((c) => [c, { inflows: 0, outflows: 0 }]));
  const series = buckets.buckets.map((b) => ({ from: b.from, to: b.to, inflows: 0, outflows: 0 }));
  for (const row of rows) {
    const acc = byCode.get(row.account_code);
    if (!acc) continue;
    const debit = Number(row.debit) || 0;
    const credit = Number(row.credit) || 0;
    acc.inflows += debit;
    acc.outflows += credit;
    const bucket = series.find((s) => row.transaction_date >= s.from && row.transaction_date <= s.to);
    if (bucket) {
      bucket.inflows += debit;
      bucket.outflows += credit;
    }
  }

  let reconByBank = new Map();
  if (reconAllowed) {
    const [sessions] = await pool.query(
      `SELECT bank_account_id AS bankAccountId, status, DATE_FORMAT(period_end, '%Y-%m-%d') AS periodEnd
         FROM bank_recon_sessions WHERE company_id = ? ORDER BY period_end DESC, id DESC`,
      [companyId]
    );
    for (const s of sessions) {
      const r = reconByBank.get(s.bankAccountId) || { lastFinalizedThrough: null, inProgress: 0 };
      if (String(s.status).toUpperCase() === "FINALIZED" && !r.lastFinalizedThrough) r.lastFinalizedThrough = s.periodEnd;
      if (String(s.status).toUpperCase() === "IN_PROGRESS") r.inProgress += 1;
      reconByBank.set(s.bankAccountId, r);
    }
  }

  const titleOf = new Map(titles.map((t) => [String(t.code), t]));
  // A COA account linked to several bank codes is counted once in totals.
  const accounts = banks.map((b) => {
    const m = byCode.get(b.coaCode);
    const open = Number(opening[b.coaCode]) || 0;
    return {
      id: b.id,
      name: b.accountName || b.bankName || b.bankCode,
      bankName: b.bankName,
      bankCode: b.bankCode,
      accountNoLast4: b.accountNo ? String(b.accountNo).slice(-4) : null,
      coaCode: b.coaCode,
      coaTitle: titleOf.get(String(b.coaCode))?.title || null,
      accountType: titleOf.get(String(b.coaCode))?.account_class || null,
      status: b.status,
      balance: round2(open + m.inflows - m.outflows),
      recon: reconAllowed ? reconByBank.get(b.id) || { lastFinalizedThrough: null, inProgress: 0 } : null,
    };
  });
  const openingBalance = round2(codes.reduce((s, c) => s + (Number(opening[c]) || 0), 0));
  const inflows = round2([...byCode.values()].reduce((s, a) => s + a.inflows, 0));
  const outflows = round2([...byCode.values()].reduce((s, a) => s + a.outflows, 0));
  return {
    accounts,
    openingBalance,
    inflows,
    outflows,
    endingBalance: round2(openingBalance + inflows - outflows),
    granularity: buckets.granularity,
    series: series.map((s) => ({ ...s, inflows: round2(s.inflows), outflows: round2(s.outflows) })),
  };
}

// AR / AP: the aging report rows as of the period end (open documents only,
// exactly what AR / AP Aging shows for that date).
async function agingSection(type, companyId, period) {
  const rows = await AgingReportService.getAgingRows(type, { companyId, asOfDate: period.to });
  const { base } = AgingReportService.getBucketTotals(rows);
  const overdueRows = rows.filter((r) => r.bucket !== "current");
  const dueBy = (days) => {
    const limit = addDays(period.to, days);
    return round2(rows.filter((r) => (r.dueDate || r.transactionDate) <= limit).reduce((s, r) => s + r.baseBalance, 0));
  };
  const soonLimit = addDays(period.to, 7);
  const dueSoonRows = rows.filter((r) => r.bucket === "current" && (r.dueDate || r.transactionDate) <= soonLimit);
  const parties = AgingReportService.getSummaryByParty(rows)
    .sort((a, b) => b.baseBalance - a.baseBalance)
    .slice(0, TOP_PARTIES)
    .map((p) => ({ partyId: p.partyId, partyName: p.partyName, balance: p.baseBalance, overdue: round2(p.baseBalance - p.buckets.current), documents: p.documentCount }));
  const largestOverdue = overdueRows.slice().sort((a, b) => b.baseBalance - a.baseBalance)[0] || null;
  return {
    asOf: period.to,
    total: base.total,
    buckets: base,
    documentCount: rows.length,
    overdue: round2(base.total - base.current),
    overdueCount: overdueRows.length,
    dueSoon: round2(dueSoonRows.reduce((s, r) => s + r.baseBalance, 0)),
    dueSoonCount: dueSoonRows.length,
    dueWithin7: dueBy(7),
    dueWithin30: dueBy(30),
    topParties: parties,
    largestOverdue: largestOverdue
      ? { partyName: largestOverdue.partyName, referenceNo: largestOverdue.referenceNo, balance: largestOverdue.baseBalance, daysOverdue: largestOverdue.daysOutstanding }
      : null,
  };
}

// Documents waiting on someone, per module the user can view.
async function workflowSection(companyId, perms) {
  const out = {};
  if (perms.apv) {
    const [[r]] = await pool.query("SELECT COUNT(*) AS n, COALESCE(SUM(total_credit), 0) AS amount FROM apv_headers WHERE company_id = ? AND UPPER(status) = 'DRAFT'", [companyId]);
    out.draftApv = { count: Number(r.n), amount: round2(r.amount) };
  }
  if (perms.invoice) {
    const [[r]] = await pool.query("SELECT COUNT(*) AS n FROM invoice_headers WHERE company_id = ? AND UPPER(status) = 'DRAFT'", [companyId]);
    out.draftInvoices = { count: Number(r.n) };
  }
  if (perms.rfp) {
    const [[r]] = await pool.query("SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS amount FROM rfp_headers WHERE company_id = ? AND status = 'SUBMITTED'", [companyId]);
    out.rfpAwaitingApproval = { count: Number(r.n), amount: round2(r.amount) };
  }
  return out;
}

// Recent Transactions: the latest records of every transaction module the
// user can view, newest first. Deliberately NOT limited to the dashboard
// period - it is a "what happened lately" list, labelled as such on screen.
// Table / column names and the extra WHERE are server-chosen constants only.
const TRANSACTION_SOURCES = [
  { perm: "TRANSACTIONS.INVOICE", type: "INV", label: "Invoice", path: "/transactions/invoice", table: "invoice_headers", no: "voucher_no", party: "customer_name", amount: "total_debit", date: "transaction_date", touched: "COALESCE(updated_at, created_at)" },
  { perm: "TRANSACTIONS.OR", type: "OR", label: "Official Receipt", path: "/transactions/or", table: "or_headers", no: "voucher_no", party: "customer_name", amount: "total_debit", date: "transaction_date", touched: "COALESCE(updated_at, created_at)" },
  { perm: "TRANSACTIONS.APV", type: "APV", label: "APV", path: "/transactions/apv", table: "apv_headers", no: "voucher_no", party: "supplier_name", amount: "total_credit", date: "transaction_date", touched: "COALESCE(updated_at, created_at)" },
  { perm: "TRANSACTIONS.CV", type: "CV", label: "Check Voucher", path: "/transactions/cv", table: "cv_headers", no: "voucher_no", party: "payee_name", amount: "total_credit", date: "transaction_date", touched: "COALESCE(updated_at, created_at)" },
  { perm: "TRANSACTIONS.JV", type: "JV", label: "Journal Voucher", path: "/transactions/jv", table: "jv_headers", no: "voucher_no", party: "prepared_for", amount: "total_debit", date: "transaction_date", touched: "COALESCE(posted_at, created_at)" },
  { perm: "TRANSACTIONS.PETTY_CASH", type: "PCV", label: "Petty Cash Voucher", path: "/transactions/petty-cash-voucher", table: "petty_cash_headers", no: "voucher_no", party: "payee_name", amount: "GREATEST(COALESCE(total_debit, 0), COALESCE(total_credit, 0))", date: "transaction_date", touched: "COALESCE(updated_at, created_at)" },
  { perm: "TRANSACTIONS.DEBIT_CREDIT_MEMO", type: "DM", label: "Debit Memo", path: "/transactions/debit-memo", table: "memo_headers", where: "memo_type = 'DEBIT'", no: "voucher_no", party: "party_name", amount: "GREATEST(COALESCE(total_debit, 0), COALESCE(total_credit, 0))", date: "transaction_date", touched: "COALESCE(updated_at, created_at)" },
  { perm: "TRANSACTIONS.DEBIT_CREDIT_MEMO", type: "CM", label: "Credit Memo", path: "/transactions/credit-memo", table: "memo_headers", where: "memo_type = 'CREDIT'", no: "voucher_no", party: "party_name", amount: "GREATEST(COALESCE(total_debit, 0), COALESCE(total_credit, 0))", date: "transaction_date", touched: "COALESCE(updated_at, created_at)" },
  { perm: "TRANSACTIONS.PURCHASE_ORDER", type: "PO", label: "Purchase Order", path: "/transactions/purchase-order", table: "purchase_order_headers", no: "voucher_no", party: "supplier_name", amount: "GREATEST(COALESCE(total_debit, 0), COALESCE(total_credit, 0))", date: "transaction_date", touched: "COALESCE(updated_at, created_at)" },
  { perm: "TRANSACTIONS.RFP", type: "RFP", label: "Request for Payment", path: "/transactions/rfp", table: "rfp_headers", no: "rfp_no", party: "supplier_name", amount: "total_amount", date: "rfp_date", touched: "COALESCE(updated_at, created_at)" },
  // The Quotation page has no open-by-id link, so its rows open the list.
  { perm: "TRANSACTIONS.QUOTATION", type: "QUO", label: "Quotation", path: "/transactions/quotation", noDeepLink: true, table: "quotation_headers", no: "quotation_no", party: "customer_name", amount: "total_amount", date: "quotation_date", touched: "COALESCE(updated_at, created_at)" },
];

async function transactionsSection(companyId, viewable) {
  const sources = TRANSACTION_SOURCES.filter((s) => viewable.has(s.perm));
  const lists = await Promise.all(
    sources.map(async (s) => {
      const [rows] = await pool.query(
        `SELECT id, ${s.no} AS voucherNo, ${s.party} AS party, ${s.amount} AS amount, status,
                DATE_FORMAT(${s.date}, '%Y-%m-%d') AS transactionDate, ${s.touched} AS touchedAt
           FROM ${s.table} WHERE company_id = ?${s.where ? ` AND ${s.where}` : ""}
          ORDER BY ${s.touched} DESC, id DESC LIMIT ?`,
        [companyId, RECENT_LIMIT]
      );
      return rows.map((r) => ({
        type: s.type,
        typeLabel: s.label,
        id: r.id,
        voucherNo: r.voucherNo,
        party: r.party || null,
        amount: round2(r.amount),
        status: r.status,
        transactionDate: r.transactionDate,
        touchedAt: r.touchedAt ? new Date(r.touchedAt).toISOString() : null,
        link: s.noDeepLink ? s.path : `${s.path}?id=${r.id}`,
      }));
    })
  );
  const items = lists.flat().sort((a, b) => String(b.touchedAt).localeCompare(String(a.touchedAt))).slice(0, RECENT_LIMIT);
  return { scope: "latest", items, modules: [...new Set(sources.map((s) => s.type))] };
}

// Activity Timeline: the company's own audit events about records the user
// can already open - never the whole audit log. Visible with the new
// DASHBOARD.ACTIVITY/VIEW (granted to ADMIN and ACCOUNTANT by
// dashboard_activity_permission_migration.sql) or ADMIN.AUDIT_LOGS/VIEW;
// ADMIN.AUDIT_LOGS itself is unchanged. An event is included only when its
// module maps to a VIEW permission the user holds, so sign-ins, user, role,
// permission, invitation and settings events never appear here, and
// before/after data is never sent (description only, sanitized like the
// Audit Logs page).
const ACTIVITY_MODULES = {
  "TRANSACTIONS.INVOICE": "TRANSACTIONS.INVOICE",
  "TRANSACTIONS.OR": "TRANSACTIONS.OR",
  "TRANSACTIONS.APV": "TRANSACTIONS.APV",
  "TRANSACTIONS.CV": "TRANSACTIONS.CV",
  "TRANSACTIONS.JV": "TRANSACTIONS.JV",
  "TRANSACTIONS.RFP": "TRANSACTIONS.RFP",
  "TRANSACTIONS.PETTY_CASH": "TRANSACTIONS.PETTY_CASH",
  "TRANSACTIONS.DEBIT_CREDIT_MEMO": "TRANSACTIONS.DEBIT_CREDIT_MEMO",
  "TRANSACTIONS.PURCHASE_ORDER": "TRANSACTIONS.PURCHASE_ORDER",
  "TRANSACTIONS.QUOTATION": "TRANSACTIONS.QUOTATION",
  BANK_RECON: "REPORTS.BANK_RECONCILIATION",
};
// Events logged under the generic "TRANSACTIONS" module carry the document
// type in entity_type.
const ACTIVITY_ENTITY_TYPES = {
  INV: "TRANSACTIONS.INVOICE",
  INVOICE: "TRANSACTIONS.INVOICE",
  OR: "TRANSACTIONS.OR",
  APV: "TRANSACTIONS.APV",
  CV: "TRANSACTIONS.CV",
  JV: "TRANSACTIONS.JV",
  PETTY_CASH: "TRANSACTIONS.PETTY_CASH",
  MEMO_DEBIT: "TRANSACTIONS.DEBIT_CREDIT_MEMO",
  MEMO_CREDIT: "TRANSACTIONS.DEBIT_CREDIT_MEMO",
  PO: "TRANSACTIONS.PURCHASE_ORDER",
  QUOTATION: "TRANSACTIONS.QUOTATION",
  RFP: "TRANSACTIONS.RFP",
};

async function activitySection(companyId, viewable) {
  const modules = Object.entries(ACTIVITY_MODULES).filter(([, perm]) => viewable.has(perm)).map(([m]) => m);
  const entityTypes = Object.entries(ACTIVITY_ENTITY_TYPES).filter(([, perm]) => viewable.has(perm)).map(([t]) => t);
  const clauses = [];
  const params = [companyId];
  if (modules.length) {
    clauses.push("a.module IN (?)");
    params.push(modules);
  }
  if (entityTypes.length) {
    clauses.push("(a.module = 'TRANSACTIONS' AND a.entity_type IN (?))");
    params.push(entityTypes);
  }
  if (!clauses.length) return { scope: "latest", items: [], modules: [] };
  const [rows] = await pool.query(
    `SELECT a.id, a.module, a.entity_type AS entityType, a.entity_id AS entityId, a.action, a.description,
            a.created_at AS createdAt, u.username
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.company_id = ? AND (${clauses.join(" OR ")})
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [...params, RECENT_LIMIT]
  );
  return {
    scope: "latest",
    modules,
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      module: r.module,
      entityType: r.entityType,
      entityId: r.entityId,
      description: AuditLogService.sanitize(r.description),
      username: r.username || null,
      createdAt: r.createdAt,
    })),
  };
}

// Accounting period of the period end date. Read with a plain SELECT (the
// period service's lookup locks the row for writers). A company with no
// period rows at all has period management off - see accountingPeriodService.
async function periodSection(companyId, period) {
  const [year, month] = period.to.split("-").map(Number);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM accounting_periods WHERE company_id = ?", [companyId]);
  if (!Number(n)) return { managed: false, periodStatus: null, year, month };
  const [[p]] = await pool.query(
    "SELECT status FROM accounting_periods WHERE company_id = ? AND year = ? AND period_month = ?",
    [companyId, year, month]
  );
  return { managed: true, periodStatus: p ? p.status : "MISSING", year, month };
}

// ---------------------------------------------------------------------------
// Alerts: rules over the sections above (never new numbers).

function buildAlerts(s, period) {
  const alerts = [];
  const push = (level, text, link) => alerts.push({ level, text, link });
  if (s.balance.status === "ok" && !s.balance.balanced) {
    push("danger", `The Balance Sheet as of ${period.to} does not balance. Review the Trial Balance.`, "/reports/trial-balance");
  }
  if ((s.income.status === "ok" && s.income.unclassified) || (s.balance.status === "ok" && s.balance.unclassified)) {
    push("warning", "Some accounts are not assigned to a financial statement section.", "/report-sections");
  }
  if (s.receivables.status === "ok" && s.receivables.overdueCount > 0) {
    push("warning", `${s.receivables.overdueCount} receivable document(s) overdue as of ${period.to}.`, "/reports/ar-aging");
  }
  if (s.payables.status === "ok" && s.payables.overdueCount > 0) {
    push("warning", `${s.payables.overdueCount} payable document(s) past due as of ${period.to}.`, "/reports/ap-aging");
  }
  if (s.payables.status === "ok" && s.payables.dueSoonCount > 0) {
    push("info", `${s.payables.dueSoonCount} payable document(s) fall due within 7 days.`, "/reports/ap-aging");
  }
  if (s.workflow.status === "ok") {
    const w = s.workflow;
    if (w.draftApv?.count) push("info", `${w.draftApv.count} APV draft(s) not yet posted.`, "/transactions/apv");
    if (w.draftInvoices?.count) push("info", `${w.draftInvoices.count} invoice draft(s) not yet posted.`, "/transactions/invoice");
    if (w.rfpAwaitingApproval?.count) push("info", `${w.rfpAwaitingApproval.count} Request(s) for Payment awaiting approval.`, "/transactions/rfp");
  }
  if (s.cash.status === "ok") {
    const inProgress = s.cash.accounts.reduce((n, a) => n + (a.recon?.inProgress || 0), 0);
    if (inProgress) push("info", `${inProgress} bank reconciliation(s) in progress.`, "/reports/bank-reconciliation");
  }
  return alerts;
}

// ---------------------------------------------------------------------------

async function getDashboardSummary(user, query = {}) {
  const period = parsePeriod(query);
  const companyId = await resolveCompany(user, query);
  const company = await loadCompany(companyId);
  const buckets = buildBuckets(period.from, period.to);

  // Every VIEW permission a section depends on, checked server-side once.
  const VIEW_KEYS = [
    "REPORTS.FINANCIAL", "REPORTS.AR", "REPORTS.AP", "REPORTS.BANK_RECONCILIATION",
    "ADMIN.AUDIT_LOGS", "DASHBOARD.ACTIVITY",
    ...new Set(TRANSACTION_SOURCES.map((t) => t.perm)),
  ];
  const granted = await Promise.all(VIEW_KEYS.map((k) => PermissionService.can(user.id, k, "VIEW")));
  const viewable = new Set(VIEW_KEYS.filter((k, i) => granted[i]));
  const has = (k) => viewable.has(k);
  const txPerms = { apv: has("TRANSACTIONS.APV"), invoice: has("TRANSACTIONS.INVOICE"), rfp: has("TRANSACTIONS.RFP") };
  const anyTx = TRANSACTION_SOURCES.some((t) => has(t.perm));

  const [income, balance, cash, receivables, payables, workflow, transactions, activity, periodStatus] = await Promise.all([
    section(has("REPORTS.FINANCIAL"), () => incomeSection(companyId, period, buckets), "INCOME"),
    section(has("REPORTS.FINANCIAL"), () => balanceSection(companyId, period), "BALANCE"),
    section(has("REPORTS.FINANCIAL"), () => cashSection(companyId, period, buckets, { reconAllowed: has("REPORTS.BANK_RECONCILIATION") }), "CASH"),
    section(has("REPORTS.AR"), () => agingSection("AR", companyId, period), "RECEIVABLES"),
    section(has("REPORTS.AP"), () => agingSection("AP", companyId, period), "PAYABLES"),
    section(txPerms.apv || txPerms.invoice || txPerms.rfp, () => workflowSection(companyId, txPerms), "WORKFLOW"),
    section(anyTx, () => transactionsSection(companyId, viewable), "TRANSACTIONS"),
    section(has("DASHBOARD.ACTIVITY") || has("ADMIN.AUDIT_LOGS"), () => activitySection(companyId, viewable), "ACTIVITY"),
    section(true, () => periodSection(companyId, period), "PERIOD"),
  ]);
  const sections = { income, balance, cash, receivables, payables, workflow, transactions, activity, period: periodStatus };

  return {
    meta: {
      companyId: company.id,
      companyName: company.name,
      currency: company.currency,
      from: period.from,
      to: period.to,
      granularity: buckets.granularity,
      generatedAt: new Date().toISOString(),
    },
    sections,
    alerts: buildAlerts(sections, period),
  };
}

module.exports = { getDashboardSummary, buildBuckets, parsePeriod };
