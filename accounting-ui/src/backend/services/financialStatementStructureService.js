const pool = require("../db");
const LedgerReportService = require("./LedgerReportService");
const GCC = require("./groupCodeClassification");

// ===========================================================================
// Canonical Income Statement / Balance Sheet STRUCTURE model (Reports Phase A).
//
// This is the single calculation source that will eventually drive the
// on-screen report, the Print/PDF, and the CSV export for both statements,
// in both CONDENSED and DETAILED presentation. Phase A builds ONLY the
// backend model - nothing here is wired into a public route or the UI yet,
// and the existing flat /api/reports/income-statement + /api/reports/
// balance-sheet responses (financialStatementService.js) are left exactly
// as they are.
//
// Design rules implemented (from the approved IS/BS Template-to-System
// Design Specification):
//
//  * NO account-name string matching anywhere. Sections come only from
//    account_group_codes.report_section (+ display_order), consumed via the
//    existing groupCodeClassification.js authority.
//  * DETAILED is the canonical calculation. CONDENSED is a pure roll-up of
//    the exact same per-account numbers - the two share one internal
//    section/group/account structure, so every section subtotal and every
//    computed statement total is identical between the modes by
//    construction.
//  * The statement skeleton (section order, LESS:/ADD: semantics, which
//    computed subtotals exist and where) lives in code here - it is never
//    stored in the database.
//  * No balance may silently disappear. The account-level balance query is
//    driven FROM chart_of_accounts and LEFT JOINs classification metadata,
//    so an account with no coa_groups row is NOT dropped - it lands in an
//    explicit UNCLASSIFIED pseudo-section that still participates in the
//    final totals.
//  * One COA account may (schema-wise) belong to several group codes. It is
//    counted exactly ONCE: the chosen group is the one with the lowest
//    non-null display_order, then the lowest group_code; the rest are
//    reported as multiGroupMappings diagnostics. coa_groups data is never
//    modified.
//  * Balance Sheet "Current Year Earnings" is computed by this service on
//    the SAME canonical account-recognition path as the structured Income
//    Statement (canonicalYtdNetIncome -> gatherAccounts), so BS Current
//    Year Earnings == structured IS Net Income for the calendar-year-start
//    -> as-of window, INCLUDING unclassified and ungrouped income/expense
//    accounts. It is injected as a single synthetic Equity line, never
//    persisted, no JV, no ledger write, one line in both Condensed and
//    Detailed. (Phase A.1: the legacy
//    financialStatementService.getCurrentYearEarnings is NOT reused here -
//    its INNER-JOIN recognition can drop an income/expense account that has
//    no coa_groups row, which would make BS Assets != Liabilities + Equity
//    against the LEFT-JOIN-safe structured sections. Legacy stays untouched
//    for the legacy flat report.)
//  * All financial math is done on SIGNED accounting values
//    (credit - debit, or debit - credit for assets). LESS:/ADD: is a
//    presentation label only; values in the model keep their true sign.
// ===========================================================================

const IS_CLASSES = ["INCOME", "EXPENSE"];
const BS_CLASSES = ["ASSET", "LIABILITY", "EQUITY"];

const CYE_ACCOUNT_CODE = "CURRENT-EARNINGS";
const CYE_LINE_LABEL = "NET INCOME/(LOSS)";

// Ordered statement skeletons. `section` entries roll up a report_section;
// `computed` entries are derived totals (never stored); `unclassified`
// entries are the safety buckets, only emitted when non-empty.
const IS_SKELETON = [
  { kind: "section", section: "REVENUE", heading: "REVENUE", subtotalLabel: "TOTAL REVENUE", prefix: null },
  { kind: "section", section: "DIRECT_COST", heading: "DIRECT COSTS", subtotalLabel: "TOTAL DIRECT COSTS", prefix: "LESS" },
  { kind: "computed", id: "GROSS_PROFIT", label: "GROSS PROFIT" },
  { kind: "section", section: "OPERATING_EXPENSE", heading: "OPERATING EXPENSES", subtotalLabel: "TOTAL OPERATING EXPENSES", prefix: "LESS" },
  { kind: "computed", id: "NET_OPERATING_INCOME", label: "NET OPERATING INCOME/(LOSS)" },
  { kind: "section", section: "OTHER_INCOME", heading: "OTHER INCOME", subtotalLabel: "TOTAL OTHER INCOME", prefix: "ADD" },
  { kind: "section", section: "OTHER_EXPENSE", heading: "OTHER EXPENSES", subtotalLabel: "TOTAL OTHER EXPENSES", prefix: "LESS" },
  { kind: "computed", id: "INCOME_BEFORE_TAX", label: "INCOME/(LOSS) BEFORE TAX" },
  { kind: "unclassified", side: "INCOME", heading: "UNCLASSIFIED — INCOME", subtotalLabel: "TOTAL UNCLASSIFIED — INCOME" },
  { kind: "unclassified", side: "EXPENSE", heading: "UNCLASSIFIED — EXPENSE", subtotalLabel: "TOTAL UNCLASSIFIED — EXPENSE" },
  { kind: "section", section: "TAX_EXPENSE", heading: "PROVISION FOR INCOME TAX", subtotalLabel: "TOTAL PROVISION FOR INCOME TAX", prefix: "LESS" },
  { kind: "computed", id: "NET_INCOME", label: "NET INCOME/(LOSS)" },
];

const BS_SKELETON = [
  { kind: "statement-heading", label: "ASSETS" },
  { kind: "section", section: "CURRENT_ASSET", heading: "CURRENT ASSETS", subtotalLabel: "TOTAL CURRENT ASSETS" },
  { kind: "section", section: "NON_CURRENT_ASSET", heading: "NON-CURRENT ASSETS", subtotalLabel: "TOTAL NON-CURRENT ASSETS" },
  { kind: "unclassified", side: "ASSET", heading: "UNCLASSIFIED ASSETS", subtotalLabel: "TOTAL UNCLASSIFIED ASSETS" },
  { kind: "computed", id: "TOTAL_ASSETS", label: "TOTAL ASSETS" },
  { kind: "statement-heading", label: "LIABILITIES & SHAREHOLDERS' EQUITY" },
  { kind: "section", section: "CURRENT_LIABILITY", heading: "CURRENT LIABILITIES", subtotalLabel: "TOTAL CURRENT LIABILITIES" },
  { kind: "section", section: "NON_CURRENT_LIABILITY", heading: "NON-CURRENT LIABILITIES", subtotalLabel: "TOTAL NON-CURRENT LIABILITIES" },
  { kind: "unclassified", side: "LIABILITY", heading: "UNCLASSIFIED LIABILITIES", subtotalLabel: "TOTAL UNCLASSIFIED LIABILITIES" },
  { kind: "computed", id: "TOTAL_LIABILITIES", label: "TOTAL LIABILITIES" },
  { kind: "section", section: "EQUITY", heading: "SHAREHOLDERS' EQUITY", subtotalLabel: "TOTAL SHAREHOLDERS' EQUITY", withCurrentYearEarnings: true },
  { kind: "unclassified", side: "EQUITY", heading: "UNCLASSIFIED EQUITY", subtotalLabel: "TOTAL UNCLASSIFIED EQUITY" },
  { kind: "computed", id: "TOTAL_LIABILITIES_AND_EQUITY", label: "TOTAL LIABILITIES & SHAREHOLDERS' EQUITY" },
];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Sum any number of {colKey: number} objects into one, over the given base
// column keys. Full float precision - callers round only when emitting.
function addRaw(baseKeys, ...objs) {
  const out = {};
  for (const k of baseKeys) {
    out[k] = 0;
    for (const o of objs) out[k] += Number((o && o[k]) || 0);
  }
  return out;
}

// buildTransactionUnionSql has 9 UNION branches, each taking its date
// param(s) then its company_id - identical shape to LedgerReportService's
// own callers.
function unionParams(filterKind, args) {
  if (filterKind === "between") return Array(9).fill([args.from, args.to, args.companyId]).flat();
  return Array(9).fill([args.date, args.companyId]).flat();
}

// Per-account debit/credit totals for one period / as-of date, driven FROM
// chart_of_accounts (LEFT JOIN the transaction union) so nothing with a COA
// row is ever dropped. No group join here - amounts must not be multiplied
// by a duplicate/multi coa_groups row; classification is resolved
// separately in JS.
async function fetchAmounts({ companyId, classes, filterKind, filterArgs }) {
  const dateFilterSql = filterKind === "between" ? "BETWEEN ? AND ?" : "<= ?";
  const unionSql = LedgerReportService.buildTransactionUnionSql(dateFilterSql);
  const params = unionParams(filterKind, { ...filterArgs, companyId });
  const ph = classes.map(() => "?").join(",");
  const [rows] = await pool.execute(
    `
    SELECT
      ca.code AS account_code,
      ca.title AS account_title,
      UPPER(ca.account_class) AS account_class,
      COALESCE(SUM(tx.debit), 0) AS total_debit,
      COALESCE(SUM(tx.credit), 0) AS total_credit
    FROM chart_of_accounts ca
    LEFT JOIN (${unionSql}) tx
      ON TRIM(CAST(tx.account_code AS CHAR)) = TRIM(CAST(ca.code AS CHAR))
    WHERE UPPER(ca.account_class) IN (${ph})
    GROUP BY ca.code, ca.title, UPPER(ca.account_class)
    `,
    [...params, ...classes]
  );
  return rows;
}

// Transaction-line account codes with a non-zero net that have NO
// chart_of_accounts row at all - genuinely unclassifiable to a statement
// side. Surfaced as a diagnostic; never silently swallowed, never invented
// into a section.
async function fetchUnmappedCodes({ companyId, filterKind, filterArgs }) {
  const dateFilterSql = filterKind === "between" ? "BETWEEN ? AND ?" : "<= ?";
  const unionSql = LedgerReportService.buildTransactionUnionSql(dateFilterSql);
  const params = unionParams(filterKind, { ...filterArgs, companyId });
  const [rows] = await pool.execute(
    `
    SELECT
      tx.account_code,
      COALESCE(SUM(tx.debit), 0) AS total_debit,
      COALESCE(SUM(tx.credit), 0) AS total_credit
    FROM (${unionSql}) tx
    LEFT JOIN chart_of_accounts ca
      ON TRIM(CAST(ca.code AS CHAR)) = TRIM(CAST(tx.account_code AS CHAR))
    WHERE ca.id IS NULL
      AND tx.account_code IS NOT NULL
      AND TRIM(CAST(tx.account_code AS CHAR)) <> ''
    GROUP BY tx.account_code
    `,
    params
  );
  return rows
    .map((r) => ({ accountCode: r.account_code, net: round2(Number(r.total_debit) - Number(r.total_credit)) }))
    .filter((r) => Math.abs(r.net) > 0.005);
}

// Every (account -> group -> group classification) candidate row. DISTINCT
// collapses exact-duplicate coa_groups rows. Multi-group accounts come back
// as several rows and are de-duplicated deterministically in chooseGroup().
async function fetchClassificationCandidates(classes) {
  const ph = classes.map(() => "?").join(",");
  const [rows] = await pool.execute(
    `
    SELECT DISTINCT
      ca.code AS account_code,
      UPPER(ca.account_class) AS account_class,
      cg.group_code AS group_code,
      cg.group_description AS cg_desc,
      agc.group_description AS agc_desc,
      agc.report_section AS report_section,
      agc.display_order AS display_order,
      UPPER(COALESCE(agc.status, '')) AS group_status
    FROM chart_of_accounts ca
    LEFT JOIN coa_groups cg ON cg.coa_id = ca.id
    LEFT JOIN account_group_codes agc ON agc.group_code = cg.group_code
    WHERE UPPER(ca.account_class) IN (${ph})
    `,
    classes
  );
  return rows;
}

// Deterministic one-group-per-account rule: lowest non-null display_order,
// then lowest group_code. An INACTIVE group contributes no section (its
// report_section is treated as null) but still "owns" the account for
// grouping so its description shows in the Unclassified block.
function chooseGroup(candidateRows) {
  const withGroup = (candidateRows || []).filter(
    (c) => c.group_code != null && String(c.group_code).trim() !== ""
  );
  if (!withGroup.length) return { chosen: null, shadowed: [] };

  const byCode = new Map();
  for (const c of withGroup) {
    if (byCode.has(c.group_code)) continue;
    byCode.set(c.group_code, {
      groupCode: c.group_code,
      groupDescription: c.agc_desc || c.cg_desc || String(c.group_code),
      reportSection: c.group_status === "ACTIVE" ? c.report_section : null,
      displayOrder: c.display_order == null ? null : Number(c.display_order),
      groupStatus: c.group_status || null,
    });
  }
  const list = [...byCode.values()].sort((a, b) => {
    const ao = a.displayOrder == null ? Infinity : a.displayOrder;
    const bo = b.displayOrder == null ? Infinity : b.displayOrder;
    if (ao !== bo) return ao - bo;
    return String(a.groupCode).localeCompare(String(b.groupCode));
  });
  return { chosen: list[0], shadowed: list.slice(1) };
}

// Resolve an account's report section from its chosen group, validated
// against the account's own canonical chart_of_accounts.account_class.
// Anything that does not cleanly resolve -> section null + a reason.
function resolveSection(accountClass, chosen) {
  if (!chosen) return { section: null, reason: "UNGROUPED" };
  const sec = GCC.normalizeSection(chosen.reportSection);
  if (sec === null) return { section: null, reason: "GROUP_UNCLASSIFIED" };
  if (!GCC.SECTION_CODES.includes(sec)) return { section: null, reason: "UNKNOWN_SECTION" };
  if (!GCC.isValidSectionForClass(accountClass, sec)) return { section: null, reason: "INVALID_SECTION_FOR_CLASS" };
  return { section: sec, reason: null };
}

// Roll a flat account list into ordered groups, each with its own per-column
// subtotal, plus the section-level per-column subtotal. Group order:
// display_order (NULLs last), then group_code; the "(no group code)" bucket
// always sorts last. Account order within a group: account code ascending.
function groupAndSubtotal(list, baseKeys) {
  const groups = new Map();
  for (const a of list) {
    const key = a.group ? a.group.groupCode : "__NONE__";
    if (!groups.has(key)) {
      groups.set(key, {
        groupCode: a.group ? a.group.groupCode : null,
        groupDescription: a.group ? a.group.groupDescription : "(no group code)",
        displayOrder: a.group && a.group.displayOrder != null ? a.group.displayOrder : null,
        synthetic: false,
        accounts: [],
      });
    }
    groups.get(key).accounts.push(a);
  }
  const arr = [...groups.values()];
  for (const g of arr) {
    g.accounts.sort((x, y) => String(x.code).localeCompare(String(y.code)));
    g.subtotalRaw = addRaw(baseKeys, ...g.accounts.map((a) => a.amounts));
  }
  arr.sort((a, b) => {
    const ao = a.displayOrder == null ? Infinity : a.displayOrder;
    const bo = b.displayOrder == null ? Infinity : b.displayOrder;
    if (ao !== bo) return ao - bo;
    if ((a.groupCode == null) !== (b.groupCode == null)) return a.groupCode == null ? 1 : -1;
    return String(a.groupCode || "").localeCompare(String(b.groupCode || ""));
  });
  return { groups: arr, subtotalRaw: addRaw(baseKeys, ...arr.map((g) => g.subtotalRaw)) };
}

// Shared account gathering for either statement, across all requested
// columns at once.
async function gatherAccounts({ companyId, statement, columns }) {
  const classes = statement === "INCOME_STATEMENT" ? IS_CLASSES : BS_CLASSES;
  const baseKeys = columns.map((c) => c.key);

  const perColumn = {};
  for (const col of columns) {
    const filterKind = statement === "INCOME_STATEMENT" ? "between" : "asof";
    const filterArgs =
      statement === "INCOME_STATEMENT" ? { from: col.from, to: col.to } : { date: col.date };
    const rows = await fetchAmounts({ companyId, classes, filterKind, filterArgs });
    const m = new Map();
    for (const r of rows) {
      const debit = Number(r.total_debit) || 0;
      const credit = Number(r.total_credit) || 0;
      const amount =
        statement === "INCOME_STATEMENT"
          ? credit - debit
          : r.account_class === "ASSET"
          ? debit - credit
          : credit - debit;
      m.set(r.account_code, { title: r.account_title || r.account_code, accountClass: r.account_class, amount });
    }
    perColumn[col.key] = m;
  }

  const candidates = await fetchClassificationCandidates(classes);
  const candByAccount = new Map();
  for (const c of candidates) {
    if (!candByAccount.has(c.account_code)) candByAccount.set(c.account_code, []);
    candByAccount.get(c.account_code).push(c);
  }

  const allCodes = new Set();
  for (const col of columns) for (const code of perColumn[col.key].keys()) allCodes.add(code);

  const accounts = [];
  const multiGroupMappings = [];
  for (const code of allCodes) {
    let title = code;
    let accountClass = null;
    const amounts = {};
    let nonZero = false;
    for (const col of columns) {
      const hit = perColumn[col.key].get(code);
      const v = hit ? hit.amount : 0;
      amounts[col.key] = v;
      if (hit) {
        title = hit.title || code;
        accountClass = hit.accountClass;
      }
      if (Math.abs(v) > 0.005) nonZero = true;
    }
    if (!nonZero) continue; // zero-balance account: omitted from the model

    const { chosen, shadowed } = chooseGroup(candByAccount.get(code) || []);
    if (shadowed.length) {
      multiGroupMappings.push({
        accountCode: code,
        chosenGroupCode: chosen ? chosen.groupCode : null,
        shadowedGroupCodes: shadowed.map((s) => s.groupCode),
      });
    }
    const { section, reason } = resolveSection(accountClass, chosen);
    accounts.push({ code, title, accountClass, section, reason, group: chosen, amounts });
  }

  return { accounts, multiGroupMappings, baseKeys };
}

// Canonical calendar-year-to-date Net Income for one as-of date, computed
// on the EXACT same recognition path as buildIncomeStatement: every
// INCOME/EXPENSE account with activity in [<year>-01-01 .. asOfDate] is
// gathered (LEFT JOIN from chart_of_accounts, so ungrouped accounts are
// NOT dropped; multi-group accounts counted once) and its signed
// credit-minus-debit amount summed. Because every gathered account lands in
// exactly one IS section OR an UNCLASSIFIED income/expense bucket, this sum
// is identical to that period's structured NET_INCOME. This is what the
// Balance Sheet uses for its "NET INCOME/(LOSS)" equity line - reporting
// only, nothing persisted.
async function canonicalYtdNetIncome({ companyId, asOfDate }) {
  const yearStart = `${String(asOfDate).slice(0, 4)}-01-01`;
  const { accounts } = await gatherAccounts({
    companyId,
    statement: "INCOME_STATEMENT",
    columns: [{ key: "ytd", from: yearStart, to: asOfDate }],
  });
  return accounts.reduce((sum, a) => sum + (a.amounts.ytd || 0), 0);
}

// Build the {colKey:number} value object for a node, rounding to cents and
// deriving the DIFFERENCE column (base0 - base1) from the UNROUNDED bases.
function makeValues(raw, baseKeys, diff) {
  const out = {};
  for (const k of baseKeys) out[k] = round2(raw[k] || 0);
  if (diff) out[diff.key] = round2((raw[baseKeys[0]] || 0) - (raw[baseKeys[1]] || 0));
  return out;
}

// Emit the ordered node list for one section/unclassified block from its
// rolled-up data. CONDENSED = one group-line per group (carrying the group
// subtotal). DETAILED = a group-line header (no value) + one account-line
// per account + a group-subtotal. Synthetic groups (Current Year Earnings)
// are always a single line in both modes.
function emitBlock(data, opts) {
  const { mode, baseKeys, diff, section, prefix } = opts;
  const nodes = [];
  for (const g of data.groups) {
    if (g.synthetic) {
      nodes.push({
        kind: "group-line",
        level: 1,
        section: section || null,
        groupCode: g.groupCode,
        label: g.accounts[0] ? g.accounts[0].title : g.groupDescription,
        synthetic: true,
        values: makeValues(g.subtotalRaw, baseKeys, diff),
      });
      continue;
    }
    if (mode === "detailed") {
      nodes.push({
        kind: "group-line",
        level: 1,
        section: section || null,
        groupCode: g.groupCode,
        label: g.groupDescription,
      });
      for (const a of g.accounts) {
        nodes.push({
          kind: "account-line",
          level: 2,
          section: section || null,
          groupCode: g.groupCode,
          accountCode: a.code,
          label: `${a.code} — ${a.title}`,
          values: makeValues(a.amounts, baseKeys, diff),
        });
      }
      nodes.push({
        kind: "group-subtotal",
        level: 1,
        section: section || null,
        groupCode: g.groupCode,
        label: `Total ${g.groupDescription}`,
        values: makeValues(g.subtotalRaw, baseKeys, diff),
      });
    } else {
      nodes.push({
        kind: "group-line",
        level: 1,
        section: section || null,
        groupCode: g.groupCode,
        label: g.groupDescription,
        values: makeValues(g.subtotalRaw, baseKeys, diff),
      });
    }
  }
  if (prefix) nodes.forEach((n) => (n.prefix = prefix));
  return nodes;
}

// --------------------------------------------------------------------------
// Public: Income Statement
//   opts.periods : [{ key, label, from, to }]  (>= 1; each a date range)
//   opts.mode    : "condensed" (default) | "detailed"
// --------------------------------------------------------------------------
async function buildIncomeStatement(opts = {}) {
  const { companyId, mode = "condensed", periods } = opts;
  if (!companyId) throw new Error("buildIncomeStatement: companyId is required");
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error("buildIncomeStatement: periods[] (>=1) is required");
  }
  const columns = periods.map((p) => ({ key: p.key, label: p.label || p.key, from: p.from, to: p.to }));
  const baseKeys = columns.map((c) => c.key);

  const { accounts, multiGroupMappings } = await gatherAccounts({
    companyId,
    statement: "INCOME_STATEMENT",
    columns,
  });

  const sectionData = {};
  for (const code of GCC.SECTION_CODES) {
    sectionData[code] = groupAndSubtotal(
      accounts.filter((a) => a.section === code),
      baseKeys
    );
  }
  const unclassified = {
    INCOME: groupAndSubtotal(
      accounts.filter((a) => a.section === null && a.accountClass === "INCOME"),
      baseKeys
    ),
    EXPENSE: groupAndSubtotal(
      accounts.filter((a) => a.section === null && a.accountClass === "EXPENSE"),
      baseKeys
    ),
  };

  const S = (code) => sectionData[code].subtotalRaw;
  const computedRaw = {};
  computedRaw.GROSS_PROFIT = addRaw(baseKeys, S("REVENUE"), S("DIRECT_COST"));
  computedRaw.NET_OPERATING_INCOME = addRaw(baseKeys, computedRaw.GROSS_PROFIT, S("OPERATING_EXPENSE"));
  computedRaw.INCOME_BEFORE_TAX = addRaw(
    baseKeys,
    computedRaw.NET_OPERATING_INCOME,
    S("OTHER_INCOME"),
    S("OTHER_EXPENSE")
  );
  computedRaw.NET_INCOME = addRaw(
    baseKeys,
    computedRaw.INCOME_BEFORE_TAX,
    unclassified.INCOME.subtotalRaw,
    unclassified.EXPENSE.subtotalRaw,
    S("TAX_EXPENSE")
  );

  // Cross-check: stepwise Net Income must equal the flat signed sum of all
  // six IS report sections plus the two unclassified buckets.
  const sectionSumRaw = addRaw(
    baseKeys,
    S("REVENUE"),
    S("DIRECT_COST"),
    S("OPERATING_EXPENSE"),
    S("OTHER_INCOME"),
    S("OTHER_EXPENSE"),
    S("TAX_EXPENSE"),
    unclassified.INCOME.subtotalRaw,
    unclassified.EXPENSE.subtotalRaw
  );
  const crossCheck = {
    ok: baseKeys.every((k) => Math.abs(round2(computedRaw.NET_INCOME[k]) - round2(sectionSumRaw[k])) < 0.005),
    stepwiseNetIncome: makeValues(computedRaw.NET_INCOME, baseKeys),
    sectionSumNetIncome: makeValues(sectionSumRaw, baseKeys),
  };

  const nodes = [];
  for (const step of IS_SKELETON) {
    if (step.kind === "section") {
      const data = sectionData[step.section];
      nodes.push({ kind: "section-heading", level: 1, section: step.section, label: step.heading, prefix: step.prefix || null });
      nodes.push(...emitBlock(data, { mode, baseKeys, section: step.section, prefix: step.prefix || null }));
      nodes.push({
        kind: "section-subtotal",
        level: 1,
        section: step.section,
        label: step.subtotalLabel,
        prefix: step.prefix || null,
        values: makeValues(data.subtotalRaw, baseKeys),
      });
      nodes.push({ kind: "rule" });
    } else if (step.kind === "unclassified") {
      const data = unclassified[step.side];
      if (!data.groups.length) continue;
      nodes.push({ kind: "section-heading", level: 1, section: null, label: step.heading, unclassified: true });
      nodes.push(...emitBlock(data, { mode, baseKeys, section: null }));
      nodes.push({
        kind: "section-subtotal",
        level: 1,
        section: null,
        label: step.subtotalLabel,
        unclassified: true,
        values: makeValues(data.subtotalRaw, baseKeys),
      });
      nodes.push({ kind: "rule" });
    } else if (step.kind === "computed") {
      nodes.push({
        kind: "computed-total",
        id: step.id,
        label: step.label,
        values: makeValues(computedRaw[step.id], baseKeys),
      });
      nodes.push({ kind: "rule" });
    }
  }

  const readiness = await buildReadiness({ accounts, multiGroupMappings, companyId, statement: "INCOME_STATEMENT", primaryPeriod: columns[0] });
  const companyName = await fetchCompanyName(companyId);

  return {
    statement: "INCOME_STATEMENT",
    mode,
    meta: {
      companyId,
      companyName,
      title: `INCOME STATEMENT - ${mode === "detailed" ? "DETAILED" : "CONDENSED"}`,
      generatedAt: new Date().toISOString(),
      periods: columns.map((c) => ({ key: c.key, label: c.label, from: c.from, to: c.to })),
    },
    columns: columns.map((c) => ({ key: c.key, label: c.label })),
    nodes,
    computed: {
      GROSS_PROFIT: makeValues(computedRaw.GROSS_PROFIT, baseKeys),
      NET_OPERATING_INCOME: makeValues(computedRaw.NET_OPERATING_INCOME, baseKeys),
      INCOME_BEFORE_TAX: makeValues(computedRaw.INCOME_BEFORE_TAX, baseKeys),
      NET_INCOME: makeValues(computedRaw.NET_INCOME, baseKeys),
    },
    sectionSubtotals: Object.fromEntries(
      GCC.SECTION_CODES.filter((c) => IS_SKELETON.some((s) => s.section === c)).map((c) => [
        c,
        makeValues(sectionData[c].subtotalRaw, baseKeys),
      ])
    ),
    unclassified: {
      present: unclassified.INCOME.groups.length > 0 || unclassified.EXPENSE.groups.length > 0,
      INCOME: makeValues(unclassified.INCOME.subtotalRaw, baseKeys),
      EXPENSE: makeValues(unclassified.EXPENSE.subtotalRaw, baseKeys),
    },
    crossCheck,
    balanceCheck: null,
    readiness,
  };
}

// --------------------------------------------------------------------------
// Public: Balance Sheet
//   opts.columns        : [{ key, label, date }]  (1 or 2 as-of dates)
//   opts.withDifference : boolean (only meaningful with exactly 2 columns)
//   opts.mode           : "condensed" (default) | "detailed"
// --------------------------------------------------------------------------
async function buildBalanceSheet(opts = {}) {
  const { companyId, mode = "condensed", columns: asOf, withDifference = false } = opts;
  if (!companyId) throw new Error("buildBalanceSheet: companyId is required");
  if (!Array.isArray(asOf) || asOf.length === 0) {
    throw new Error("buildBalanceSheet: columns[] (1 or 2 as-of dates) is required");
  }
  const columns = asOf.map((c) => ({ key: c.key, label: c.label || c.key, date: c.date }));
  const baseKeys = columns.map((c) => c.key);
  const diff = withDifference && columns.length === 2 ? { key: "difference", label: "DIFFERENCE" } : null;

  const { accounts, multiGroupMappings } = await gatherAccounts({
    companyId,
    statement: "BALANCE_SHEET",
    columns,
  });

  const sectionData = {};
  for (const code of GCC.SECTION_CODES) {
    sectionData[code] = groupAndSubtotal(
      accounts.filter((a) => a.section === code),
      baseKeys
    );
  }
  const unclassified = {
    ASSET: groupAndSubtotal(accounts.filter((a) => a.section === null && a.accountClass === "ASSET"), baseKeys),
    LIABILITY: groupAndSubtotal(accounts.filter((a) => a.section === null && a.accountClass === "LIABILITY"), baseKeys),
    EQUITY: groupAndSubtotal(accounts.filter((a) => a.section === null && a.accountClass === "EQUITY"), baseKeys),
  };

  // Current Year Earnings: reporting-only, per as-of column, computed on the
  // SAME canonical recognition path as the structured Income Statement (see
  // canonicalYtdNetIncome). Injected as a single synthetic line at the END
  // of the EQUITY section so the section subtotal already includes it
  // (matches the template's "NET INCOME/(LOSS)" line inside Total
  // Shareholders' Equity). Never persisted, no JV, no ledger write.
  const cyeRaw = {};
  for (const col of columns) {
    cyeRaw[col.key] = Number((await canonicalYtdNetIncome({ companyId, asOfDate: col.date })) || 0);
  }
  sectionData.EQUITY.groups.push({
    groupCode: null,
    groupDescription: CYE_LINE_LABEL,
    displayOrder: null,
    synthetic: true,
    accounts: [
      {
        code: CYE_ACCOUNT_CODE,
        title: CYE_LINE_LABEL,
        accountClass: "EQUITY",
        section: "EQUITY",
        synthetic: true,
        amounts: { ...cyeRaw },
      },
    ],
    subtotalRaw: { ...cyeRaw },
  });
  sectionData.EQUITY.subtotalRaw = addRaw(baseKeys, sectionData.EQUITY.subtotalRaw, cyeRaw);

  const S = (code) => sectionData[code].subtotalRaw;
  const computedRaw = {};
  computedRaw.TOTAL_ASSETS = addRaw(baseKeys, S("CURRENT_ASSET"), S("NON_CURRENT_ASSET"), unclassified.ASSET.subtotalRaw);
  computedRaw.TOTAL_LIABILITIES = addRaw(
    baseKeys,
    S("CURRENT_LIABILITY"),
    S("NON_CURRENT_LIABILITY"),
    unclassified.LIABILITY.subtotalRaw
  );
  const totalEquityRaw = addRaw(baseKeys, S("EQUITY"), unclassified.EQUITY.subtotalRaw);
  computedRaw.TOTAL_LIABILITIES_AND_EQUITY = addRaw(baseKeys, computedRaw.TOTAL_LIABILITIES, totalEquityRaw);

  const balanceCheck = {
    balanced: baseKeys.every(
      (k) => Math.abs(round2(computedRaw.TOTAL_ASSETS[k]) - round2(computedRaw.TOTAL_LIABILITIES_AND_EQUITY[k])) < 0.005
    ),
    byColumn: Object.fromEntries(
      baseKeys.map((k) => [
        k,
        {
          totalAssets: round2(computedRaw.TOTAL_ASSETS[k]),
          totalLiabilitiesAndEquity: round2(computedRaw.TOTAL_LIABILITIES_AND_EQUITY[k]),
          delta: round2((computedRaw.TOTAL_ASSETS[k] || 0) - (computedRaw.TOTAL_LIABILITIES_AND_EQUITY[k] || 0)),
        },
      ])
    ),
  };

  const nodes = [];
  for (const step of BS_SKELETON) {
    if (step.kind === "statement-heading") {
      nodes.push({ kind: "section-heading", level: 0, section: null, label: step.label });
      continue;
    }
    if (step.kind === "section") {
      const data = sectionData[step.section];
      nodes.push({ kind: "section-heading", level: 1, section: step.section, label: step.heading });
      nodes.push(...emitBlock(data, { mode, baseKeys, diff, section: step.section }));
      nodes.push({
        kind: "section-subtotal",
        level: 1,
        section: step.section,
        label: step.subtotalLabel,
        values: makeValues(data.subtotalRaw, baseKeys, diff),
      });
      nodes.push({ kind: "rule" });
    } else if (step.kind === "unclassified") {
      const data = unclassified[step.side];
      if (!data.groups.length) continue;
      nodes.push({ kind: "section-heading", level: 1, section: null, label: step.heading, unclassified: true });
      nodes.push(...emitBlock(data, { mode, baseKeys, diff, section: null }));
      nodes.push({
        kind: "section-subtotal",
        level: 1,
        section: null,
        label: step.subtotalLabel,
        unclassified: true,
        values: makeValues(data.subtotalRaw, baseKeys, diff),
      });
      nodes.push({ kind: "rule" });
    } else if (step.kind === "computed") {
      nodes.push({
        kind: "computed-total",
        id: step.id,
        label: step.label,
        values: makeValues(computedRaw[step.id], baseKeys, diff),
      });
      nodes.push({ kind: "rule" });
    }
  }

  const readiness = await buildReadiness({
    accounts,
    multiGroupMappings,
    companyId,
    statement: "BALANCE_SHEET",
    primaryPeriod: { date: columns[0].date },
  });
  const companyName = await fetchCompanyName(companyId);

  return {
    statement: "BALANCE_SHEET",
    mode,
    meta: {
      companyId,
      companyName,
      title: `BALANCE SHEET - ${mode === "detailed" ? "DETAILED" : "CONDENSED"}`,
      generatedAt: new Date().toISOString(),
      asOf: columns.map((c) => ({ key: c.key, label: c.label, date: c.date })),
      withDifference: !!diff,
    },
    columns: diff ? [...columns.map((c) => ({ key: c.key, label: c.label })), diff] : columns.map((c) => ({ key: c.key, label: c.label })),
    nodes,
    computed: {
      TOTAL_ASSETS: makeValues(computedRaw.TOTAL_ASSETS, baseKeys, diff),
      TOTAL_LIABILITIES: makeValues(computedRaw.TOTAL_LIABILITIES, baseKeys, diff),
      TOTAL_SHAREHOLDERS_EQUITY: makeValues(totalEquityRaw, baseKeys, diff),
      TOTAL_LIABILITIES_AND_EQUITY: makeValues(computedRaw.TOTAL_LIABILITIES_AND_EQUITY, baseKeys, diff),
    },
    sectionSubtotals: Object.fromEntries(
      GCC.SECTION_CODES.filter((c) => BS_SKELETON.some((s) => s.section === c)).map((c) => [
        c,
        makeValues(sectionData[c].subtotalRaw, baseKeys, diff),
      ])
    ),
    currentYearEarnings: makeValues(cyeRaw, baseKeys, diff),
    unclassified: {
      present:
        unclassified.ASSET.groups.length > 0 ||
        unclassified.LIABILITY.groups.length > 0 ||
        unclassified.EQUITY.groups.length > 0,
      ASSET: makeValues(unclassified.ASSET.subtotalRaw, baseKeys, diff),
      LIABILITY: makeValues(unclassified.LIABILITY.subtotalRaw, baseKeys, diff),
      EQUITY: makeValues(unclassified.EQUITY.subtotalRaw, baseKeys, diff),
    },
    crossCheck: null,
    balanceCheck,
    readiness,
  };
}

async function fetchCompanyName(companyId) {
  try {
    const [[row]] = await pool.query("SELECT name FROM companies WHERE id = ?", [companyId]);
    return row ? row.name : null;
  } catch (_e) {
    return null;
  }
}

// Statement-model readiness: the shared group-code readiness (extended with
// unrecognizedGroupClass) plus the account-level diagnostics only this
// builder can see. NOTE: this object is part of the (not-yet-routed)
// statement model - it is deliberately NOT the payload of
// GET /api/group-codes/classification-readiness, which is unchanged.
async function buildReadiness({ accounts, multiGroupMappings, companyId, statement, primaryPeriod }) {
  const [groupRows] = await pool.execute(
    `SELECT group_code, group_description, account_class, report_section
     FROM account_group_codes
     WHERE UPPER(status) = 'ACTIVE'`
  );
  const base = GCC.getClassificationReadiness(groupRows);

  const ungrouped = accounts.filter((a) => a.reason === "UNGROUPED");
  const groupUnclassified = accounts.filter((a) => a.reason === "GROUP_UNCLASSIFIED");
  const invalidMappings = accounts.filter(
    (a) => a.reason === "UNKNOWN_SECTION" || a.reason === "INVALID_SECTION_FOR_CLASS"
  );

  let unmapped = [];
  try {
    const filterKind = statement === "INCOME_STATEMENT" ? "between" : "asof";
    const filterArgs =
      statement === "INCOME_STATEMENT"
        ? { from: primaryPeriod.from, to: primaryPeriod.to }
        : { date: primaryPeriod.date };
    unmapped = await fetchUnmappedCodes({ companyId, filterKind, filterArgs });
  } catch (_e) {
    unmapped = [];
  }

  return {
    ...base,
    ungroupedAccountsWithBalance: ungrouped.map((a) => ({
      accountCode: a.code,
      accountTitle: a.title,
      accountClass: a.accountClass,
    })),
    groupUnclassifiedAccounts: groupUnclassified.map((a) => ({
      accountCode: a.code,
      groupCode: a.group ? a.group.groupCode : null,
    })),
    invalidSectionMappings: invalidMappings.map((a) => ({
      accountCode: a.code,
      accountClass: a.accountClass,
      groupCode: a.group ? a.group.groupCode : null,
      reportSection: a.group ? a.group.reportSection : null,
      reason: a.reason,
    })),
    multiGroupMappings,
    unmappedAccountCodesWithBalance: unmapped,
  };
}

module.exports = {
  buildIncomeStatement,
  buildBalanceSheet,
  // exported for tests / future callers
  IS_SKELETON,
  BS_SKELETON,
  round2,
  chooseGroup,
  resolveSection,
  canonicalYtdNetIncome,
};
