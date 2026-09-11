// Reports Phase D: the ONE canonical serialization layer that turns a
// STRUCTURED Income Statement / Balance Sheet API response (from
// GET /api/reports/income-statement?view=structured and
// GET /api/reports/balance-sheet?view=structured) into ordered presentation
// rows, and those rows into a spreadsheet-safe CSV string.
//
// This is the single source for CSV now, and for on-screen + print/PDF
// rendering in Phase E - there is deliberately no second layout engine.
//
// PURE. No fetch, no React, no DOM, no database. And - critically - NO
// financial math: Gross Profit, Total Operating Expenses, Net Income, Total
// Assets, Current Year Earnings, the DIFFERENCE column, every subtotal and
// every computed total are read verbatim from the backend model's nodes.
// The serializer only controls ordering, labels, indentation, blank rows
// and the CSV row shape.
//
// The approved templates (INCOME STATEMENT - CONDENSED / BALANCE SHEET -
// CONDENSED) define the presentation structure. Nothing here hard-codes a
// company name, a date, an amount, a group code or an account name - all of
// that comes from the model.

import { csvCell, csvTextCell } from "./reportCsv.mjs";

const SIGNATURE_LINES = ["Prepared By:", "Checked By:", "Approved By:"];

// IS sections that flow straight into the next computed subtotal - per the
// approved template they show their section total on the heading row and
// have NO separate "TOTAL <section>" line. Only OPERATING EXPENSES carries
// an explicit "TOTAL OPERATING EXPENSES" row. Every Balance Sheet section
// carries its explicit total.
const IS_FLOW_SECTIONS = new Set([
  "REVENUE",
  "DIRECT_COST",
  "OTHER_INCOME",
  "OTHER_EXPENSE",
  "TAX_EXPENSE",
]);

// Exactly 2 decimals, negatives preserved, -0 / tiny -> "0.00". Never a
// currency symbol, never accounting parentheses, never a thousands
// separator - the cell stays a plain machine-readable number.
export function fmt2(n) {
  let x = Number(n);
  if (!Number.isFinite(x)) x = 0;
  if (Object.is(x, -0) || Math.abs(x) < 0.005) x = 0;
  return x.toFixed(2);
}

function columnMeta(model) {
  return (model.columns || []).map((c) => {
    let periodLabel = c.periodLabel || "";
    if (!periodLabel && c.key !== "difference") {
      periodLabel = c.date || (c.from && c.to ? `${c.from}..${c.to}` : c.key || "");
    }
    return { key: c.key, band: c.label || c.key || "", periodLabel };
  });
}

function subtitleLines(model, columns) {
  const byKey = Object.fromEntries(columns.map((c) => [c.key, c]));
  const lbl = (k) => (byKey[k] ? byKey[k].periodLabel || "" : "");

  if (model.statement === "BALANCE_SHEET") {
    const cur = lbl("current");
    const cmp = lbl("comparative");
    const lines = [];
    if (cur) lines.push(cmp ? `${cur} and ${cmp}` : cur);
    if (cmp) lines.push(`With comparative figures as of ${cmp}`);
    return lines;
  }

  const cur = lbl("current");
  const prev = lbl("previous");
  const lines = [];
  if (cur) lines.push(`For the period ended ${cur}`);
  if (prev) lines.push(`With comparative figures for the month of ${prev}`);
  return lines;
}

function prefixed(label, prefix) {
  if (prefix === "LESS") return `LESS: ${label}`;
  if (prefix === "ADD") return `ADD: ${label}`;
  return label;
}

// Walk the backend model's ordered `nodes` into semantic presentation rows.
// Row types: statement-heading | section-heading | group | account |
// subtotal | computed-total | rule | spacer.
function rowsFromNodes(model) {
  const nodes = Array.isArray(model.nodes) ? model.nodes : [];
  const isIncome = model.statement === "INCOME_STATEMENT";
  const rows = [];

  const subtotalBySection = {};
  for (const n of nodes) {
    if (n.kind === "section-subtotal" && n.section) subtotalBySection[n.section] = n;
  }
  const consumed = new Set();

  for (const n of nodes) {
    switch (n.kind) {
      case "section-heading": {
        if (n.level === 0) {
          rows.push({ type: "statement-heading", label: n.label, indent: 0 });
          break;
        }
        const flow = isIncome && !n.unclassified && IS_FLOW_SECTIONS.has(n.section);
        const row = {
          type: "section-heading",
          label: prefixed(n.label, n.prefix), // display-ready (e.g. "LESS: DIRECT COSTS")
          indent: 0,
          prefix: n.prefix || null,
          unclassified: !!n.unclassified,
          section: n.section || null,
        };
        if (flow && subtotalBySection[n.section]) {
          row.values = subtotalBySection[n.section].values || null;
          consumed.add(n.section);
        }
        rows.push(row);
        break;
      }
      case "group-line": {
        if (n.synthetic) {
          // Current Year Earnings / NET INCOME/(LOSS): one line, inside
          // Equity, never expanded, value straight from the backend.
          rows.push({ type: "computed-total", label: n.label, indent: 1, synthetic: true, values: n.values || null });
        } else {
          rows.push({ type: "group", label: n.label, indent: 1, groupCode: n.groupCode || null, values: n.values || null });
        }
        break;
      }
      case "account-line":
        rows.push({ type: "account", label: n.label, indent: 2, accountCode: n.accountCode || null, values: n.values || null });
        break;
      case "group-subtotal":
        rows.push({ type: "subtotal", label: n.label, indent: 1, values: n.values || null });
        break;
      case "section-subtotal": {
        if (n.section && consumed.has(n.section)) break; // hoisted onto the heading row
        rows.push({
          type: "subtotal",
          label: n.label,
          indent: 0,
          prefix: n.prefix || null,
          unclassified: !!n.unclassified,
          values: n.values || null,
        });
        break;
      }
      case "computed-total":
        rows.push({ type: "computed-total", id: n.id || null, label: n.label, indent: 0, values: n.values || null });
        break;
      case "rule":
        rows.push({ type: "rule", indent: 0 });
        break;
      case "spacer":
        rows.push({ type: "spacer", indent: 0 });
        break;
      default:
        break;
    }
  }
  return rows;
}

// Normalized presentation model. Consumed by statementToMatrix (CSV) now and
// by the screen / print renderer in Phase E.
export function serializeStatement(model) {
  if (!model || !model.statement) throw new Error("serializeStatement: a structured statement model is required");
  const columns = columnMeta(model);
  return {
    statement: model.statement,
    mode: model.mode || "condensed",
    title: (model.meta && model.meta.title) || "",
    companyName: (model.meta && model.meta.companyName) || "",
    subtitleLines: subtitleLines(model, columns),
    columns,
    rows: rowsFromNodes(model),
    signatures: SIGNATURE_LINES.slice(),
  };
}

// Presentation model -> 2-D array of typed cells ({ t:"text"|"num", v }).
// Row layout:
//   company name / title / subtitle line(s)
//   (blank)
//   band header row  ("", <band>, <band>, ...)
//   period header row ("Description", <periodLabel>, ...)
//   (blank)
//   ...statement body rows...
//   (blank) (blank)
//   Prepared By: / (blank) / Checked By: / (blank) / Approved By:
export function statementToMatrix(model) {
  const s = serializeStatement(model);
  const nCols = s.columns.length;
  const T = (v) => ({ t: "text", v: v == null ? "" : String(v) });
  const N = (v) => ({ t: "num", v: fmt2(v) });
  const pad = (cells) => {
    while (cells.length < 1 + nCols) cells.push(T(""));
    return cells;
  };

  const M = [];
  M.push([T(s.companyName)]);
  M.push([T(s.title)]);
  for (const line of s.subtitleLines) M.push([T(line)]);
  M.push([]);
  M.push(pad([T(""), ...s.columns.map((c) => T(c.band))]));
  M.push(pad([T("Description"), ...s.columns.map((c) => T(c.periodLabel))]));
  M.push([]);

  for (const row of s.rows) {
    if (row.type === "spacer" || row.type === "rule") {
      M.push([]);
      continue;
    }
    const label = "  ".repeat(row.indent || 0) + row.label; // row.label is already display-ready
    const valueCells = s.columns.map((c) =>
      row.values && row.values[c.key] != null ? N(row.values[c.key]) : T("")
    );
    M.push(pad([T(label), ...valueCells]));
  }

  M.push([]);
  M.push([]);
  for (let i = 0; i < s.signatures.length; i++) {
    M.push([T(s.signatures[i])]);
    if (i < s.signatures.length - 1) M.push([]);
  }
  return M;
}

// Spreadsheet-safe CSV string. Text cells go through csvTextCell (formula-
// injection guard); numeric cells go through csvCell (already a safe 2dp
// string). Blank rows render as empty lines.
export function statementToCsv(model) {
  return statementToMatrix(model)
    .map((cells) => cells.map((c) => (c.t === "num" ? csvCell(c.v) : csvTextCell(c.v))).join(","))
    .join("\n");
}

// Deterministic, filesystem-safe download name, e.g.
//   Income_Statement_2027-06-30.csv
//   Balance_Sheet_Detailed_2027-03-31.csv
export function statementFilename(model) {
  const base = model && model.statement === "BALANCE_SHEET" ? "Balance_Sheet" : "Income_Statement";
  const detailed = model && model.mode === "detailed" ? "_Detailed" : "";
  let date = "";
  const meta = (model && model.meta) || {};
  if (model && model.statement === "BALANCE_SHEET") {
    date = (meta.asOf && meta.asOf[0] && meta.asOf[0].date) || "";
  } else {
    const cur = (meta.periods || []).find((p) => p.key === "current");
    date = (cur && (cur.to || cur.from)) || "";
  }
  const safe = String(date).replace(/[^0-9A-Za-z_-]/g, "_");
  return `${base}${detailed}${safe ? `_${safe}` : ""}.csv`;
}

// ===========================================================================
// Phase E.1: pure helpers shared by the IS/BS screen components. These keep
// request-shaping and warning logic OUT of the JSX so they can be unit
// tested; the components only fetch + render.
// ===========================================================================

// True only for a first-of-month .. last-of-month range in the same month.
export function isWholeCalendarMonth(from, to) {
  const [fy, fm, fd] = String(from || "").split("-").map(Number);
  const [ty, tm, td] = String(to || "").split("-").map(Number);
  if (!fy || !ty || fd !== 1 || fy !== ty || fm !== tm) return false;
  return td === new Date(Date.UTC(fy, fm, 0)).getUTCDate();
}

const MODE = (m) => (String(m || "").toLowerCase() === "detailed" ? "detailed" : "condensed");

// Structured Income Statement request for the SCREEN (and, since the CSV
// serializes the shown model, for the CSV too). `comparePrevWanted` is the
// user's "Compare Previous Month" checkbox; it is only honoured for a whole
// calendar month - otherwise previous-month comparison is force-disabled so
// the endpoint never returns COMPARISON_REQUIRES_FULL_MONTH.
export function incomeStatementScreenParams({ from, to, mode, comparePrevWanted = true }) {
  const wholeMonth = isWholeCalendarMonth(from, to);
  const comparePrev = wholeMonth && comparePrevWanted !== false;
  return {
    wholeMonth,
    comparePrevActive: comparePrev,
    comparePrevDisabledReason: wholeMonth
      ? null
      : "Previous-month comparison requires a full calendar month.",
    params: {
      view: "structured",
      mode: MODE(mode),
      from: from || "",
      to: to || "",
      comparePrev: comparePrev ? "1" : "0",
      ytd: "1",
      strict: "0",
    },
  };
}

// Structured Balance Sheet request for the SCREEN. `compareTo` is optional
// and passed through verbatim - never reordered, never rejected for being
// later than `to`.
export function balanceSheetScreenParams({ to, compareTo, mode }) {
  const params = { view: "structured", mode: MODE(mode), to: to || "", strict: "0" };
  if (compareTo) params.compareTo = compareTo;
  return { params, hasComparative: !!compareTo };
}

export function toQueryString(params) {
  return new URLSearchParams(params).toString();
}

// Non-blocking diagnostics to surface ABOVE the statement (strict=0, so the
// statement itself always renders). Pure - derived from the model only.
export function statementWarnings(model) {
  const out = {
    unclassified: { show: false, message: "" },
    balance: { show: false, message: "", columns: [] },
  };
  if (!model) return out;

  if (model.unclassified && model.unclassified.present === true) {
    out.unclassified.show = true;
    out.unclassified.message =
      "Some balances appear under Unclassified because their Group Code report classification is incomplete. " +
      "Classify the affected group codes in File Setup to remove the Unclassified section.";
  }

  const bc = model.balanceCheck;
  if (bc && bc.balanced === false) {
    const colLabel = {};
    for (const c of model.columns || []) colLabel[c.key] = c.periodLabel || c.label || c.key;
    const cols = Object.entries(bc.byColumn || {})
      .filter(([, v]) => v && Math.abs(Number(v.delta) || 0) > 0.005)
      .map(([key, v]) => ({ key, label: colLabel[key] || key, delta: Number(v.delta) || 0 }));
    out.balance.show = true;
    out.balance.columns = cols;
    out.balance.message =
      "Balance Sheet is out of balance: total assets do not equal total liabilities + equity. " +
      "This can happen when prior-year profit has not yet been closed to retained earnings.";
  }
  return out;
}

// Screen number formatting: grouped thousands, 2 decimals, sign kept, no
// currency symbol. "" for a cell with no value. (CSV keeps the plain
// ungrouped fmt2 - this is screen-only.)
export function formatScreenAmount(n) {
  if (n === null || n === undefined || n === "") return "";
  let x = Number(n);
  if (!Number.isFinite(x)) return "";
  if (Object.is(x, -0) || Math.abs(x) < 0.005) x = 0;
  return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Phase E.2: restrained plain-text notes for the PRINTED statement (the
// interactive amber warning boxes are NOT printed). Same model diagnostics
// as statementWarnings, phrased for a formal document - never "corrupt",
// "database failure" or "system error".
export function statementPrintNotes(model) {
  const w = statementWarnings(model);
  const notes = [];
  if (w.unclassified.show) {
    notes.push(
      "Note: This statement contains balances presented under Unclassified because their Group Code report classification is incomplete."
    );
  }
  if (w.balance.show) {
    if (w.balance.columns.length) {
      for (const c of w.balance.columns) {
        notes.push(`Note: The Balance Sheet is out of balance by ${formatScreenAmount(c.delta)} as of ${c.label}.`);
      }
    } else {
      notes.push("Note: The Balance Sheet is currently out of balance.");
    }
  }
  return notes;
}
