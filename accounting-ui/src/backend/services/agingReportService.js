const pool = require("../db");

// Checkpoint 3E - Multi-Currency AR/AP Aging Reporting.
//
// Row-level source of truth shared by both the Detailed Aging endpoints
// and the (new) Aging Summary-by-party endpoints, so bucketing/currency/
// as-of logic exists in exactly one place. Currency fields are read
// STRAIGHT off transaction_currency_snapshots / the Checkpoint 3D foreign
// beginning-balance columns - resolveRate() is never called here (section
// 6 of the spec: report display must use STORED historical data only).
//
// As-Of Date is made genuinely historical (section 14) by reconstructing
// paid-as-of/balance-as-of from transaction_applications.application_date
// <= asOfDate, instead of reading the live balance_amount/paid_amount
// columns those apps continuously mutate. A single aggregated derived
// table (GROUP BY source_type, source_id) is joined in per branch rather
// than a per-row correlated subquery, avoiding N+1 (section 27).

const MONEY_EPSILON = 0.01;

function buildPaymentAggregateSql() {
  return `(
    SELECT source_type, source_id,
      SUM(amount) AS paid_base,
      SUM(foreign_amount_applied) AS paid_foreign
    FROM transaction_applications
    WHERE application_date <= ?
    GROUP BY source_type, source_id
  )`;
}

async function fetchRawRows(type, asOfDate, companyId) {
  const pmtSql = buildPaymentAggregateSql();

  if (type === "AR") {
    const [rows] = await pool.execute(
      `
      SELECT * FROM (
        SELECT
          'INV' AS source_type, h.id AS source_id,
          h.customer_id AS party_id, h.customer_name AS party_name,
          h.voucher_no AS reference_no,
          DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
          DATE_FORMAT(h.due_date, '%Y-%m-%d') AS due_date,
          h.total_debit AS base_original,
          h.currency_id, cur.currency_code, cur.currency_symbol,
          snap.exchange_rate AS historical_rate,
          snap.base_currency_id AS snap_base_currency_id,
          snap.foreign_total AS foreign_original,
          COALESCE(pmt.paid_base, 0) AS paid_base,
          COALESCE(pmt.paid_foreign, 0) AS paid_foreign
        FROM invoice_headers h
        LEFT JOIN currencies cur ON cur.id = h.currency_id
        LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'INV' AND snap.transaction_id = h.id
        LEFT JOIN ${pmtSql} pmt ON pmt.source_type = 'INV' AND pmt.source_id = h.id
        WHERE h.transaction_date <= ? AND h.company_id = ?

        UNION ALL

        SELECT
          'AR_BEGINNING' AS source_type, l.id AS source_id,
          l.party_id, l.party_name,
          l.reference_no,
          DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
          DATE_FORMAT(l.due_date, '%Y-%m-%d') AS due_date,
          l.debit AS base_original,
          l.currency_id, bbcur.currency_code, bbcur.currency_symbol,
          bbsnap.exchange_rate AS historical_rate,
          bbsnap.base_currency_id AS snap_base_currency_id,
          l.foreign_original_amount AS foreign_original,
          COALESCE(pmt2.paid_base, 0) AS paid_base,
          COALESCE(pmt2.paid_foreign, 0) AS paid_foreign
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id AND h.balance_type = 'AR'
        LEFT JOIN currencies bbcur ON bbcur.id = l.currency_id
        LEFT JOIN transaction_currency_snapshots bbsnap ON bbsnap.transaction_type = 'AR_BEGINNING' AND bbsnap.transaction_id = l.id
        LEFT JOIN ${pmtSql} pmt2 ON pmt2.source_type = 'AR_BEGINNING' AND pmt2.source_id = l.id
        WHERE h.balance_date <= ? AND h.company_id = ?
      ) agg
      ORDER BY party_name ASC, due_date ASC
      `,
      [asOfDate, asOfDate, companyId, asOfDate, asOfDate, companyId]
    );
    return rows;
  }

  const [rows] = await pool.execute(
    `
    SELECT * FROM (
      SELECT
        'APV' AS source_type, h.id AS source_id,
        h.supplier_id AS party_id, h.supplier_name AS party_name,
        h.voucher_no AS reference_no,
        DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
        DATE_FORMAT(h.due_date, '%Y-%m-%d') AS due_date,
        h.total_credit AS base_original,
        h.currency_id, cur.currency_code, cur.currency_symbol,
        snap.exchange_rate AS historical_rate,
        snap.base_currency_id AS snap_base_currency_id,
        snap.foreign_total AS foreign_original,
        COALESCE(pmt.paid_base, 0) AS paid_base,
        COALESCE(pmt.paid_foreign, 0) AS paid_foreign
      FROM apv_headers h
      LEFT JOIN currencies cur ON cur.id = h.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'APV' AND snap.transaction_id = h.id
      LEFT JOIN ${pmtSql} pmt ON pmt.source_type = 'APV' AND pmt.source_id = h.id
      WHERE h.transaction_date <= ? AND h.company_id = ?

      UNION ALL

      SELECT
        'AP_BEGINNING' AS source_type, l.id AS source_id,
        l.party_id, l.party_name,
        l.reference_no,
        DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
        DATE_FORMAT(l.due_date, '%Y-%m-%d') AS due_date,
        l.credit AS base_original,
        l.currency_id, bbcur.currency_code, bbcur.currency_symbol,
        bbsnap.exchange_rate AS historical_rate,
        bbsnap.base_currency_id AS snap_base_currency_id,
        l.foreign_original_amount AS foreign_original,
        COALESCE(pmt2.paid_base, 0) AS paid_base,
        COALESCE(pmt2.paid_foreign, 0) AS paid_foreign
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id AND h.balance_type = 'AP'
      LEFT JOIN currencies bbcur ON bbcur.id = l.currency_id
      LEFT JOIN transaction_currency_snapshots bbsnap ON bbsnap.transaction_type = 'AP_BEGINNING' AND bbsnap.transaction_id = l.id
      LEFT JOIN ${pmtSql} pmt2 ON pmt2.source_type = 'AP_BEGINNING' AND pmt2.source_id = l.id
      WHERE h.balance_date <= ? AND h.company_id = ?
    ) agg
    ORDER BY party_name ASC, due_date ASC
    `,
    [asOfDate, asOfDate, companyId, asOfDate, asOfDate, companyId]
  );
  return rows;
}

function daysBetween(asOfDate, otherDate) {
  const a = new Date(`${asOfDate}T00:00:00Z`);
  const b = new Date(`${otherDate}T00:00:00Z`);
  const diff = Math.round((a.getTime() - b.getTime()) / 86400000);
  return Math.max(diff, 0);
}

function bucketOf(days) {
  if (days === 0) return "current";
  if (days >= 1 && days <= 30) return "days1to30";
  if (days >= 31 && days <= 60) return "days31to60";
  if (days >= 61 && days <= 90) return "days61to90";
  return "over90";
}

function shapeRow(raw, asOfDate) {
  const baseOriginal = Number(raw.base_original || 0);
  const paidBase = Number(raw.paid_base || 0);
  const baseBalance = Math.round((baseOriginal - paidBase) * 100) / 100;

  const isForeign = raw.currency_id != null && raw.snap_base_currency_id != null && raw.currency_id !== raw.snap_base_currency_id;
  const foreignOriginal = isForeign ? Number(raw.foreign_original || 0) : null;
  const paidForeign = isForeign ? Number(raw.paid_foreign || 0) : null;
  const foreignBalance = isForeign ? Math.round((foreignOriginal - paidForeign) * 100) / 100 : null;

  const days = daysBetween(asOfDate, raw.due_date || raw.transaction_date);
  const bucket = bucketOf(days);

  return {
    sourceType: raw.source_type,
    sourceId: raw.source_id,
    partyId: raw.party_id,
    partyName: raw.party_name,
    referenceNo: raw.reference_no,
    transactionDate: raw.transaction_date,
    dueDate: raw.due_date,
    daysOutstanding: days,
    bucket,
    currencyId: raw.currency_id,
    currencyCode: raw.currency_code || null,
    currencySymbol: raw.currency_symbol || null,
    isForeign,
    historicalRate: isForeign ? Number(raw.historical_rate || 0) : null,
    foreignOriginal,
    foreignPaid: isForeign ? Math.round(paidForeign * 100) / 100 : null,
    foreignBalance,
    baseOriginal: Math.round(baseOriginal * 100) / 100,
    basePaid: Math.round(paidBase * 100) / 100,
    baseBalance,
  };
}

function applyFilters(rows, { currencyCode, partyId, status }) {
  let out = rows;

  if (currencyCode) {
    const cc = String(currencyCode).toUpperCase();
    out = out.filter((r) => (r.currencyCode || "").toUpperCase() === cc);
  }

  if (partyId) {
    out = out.filter((r) => String(r.partyId) === String(partyId));
  }

  const statusFilter = (status || "OPEN").toUpperCase();
  if (statusFilter === "OPEN") {
    out = out.filter((r) => r.baseBalance > MONEY_EPSILON);
  } else if (statusFilter === "PAID") {
    out = out.filter((r) => r.baseBalance <= MONEY_EPSILON);
  }
  // 'ALL' -> no balance filter

  return out;
}

async function getAgingRows(type, { companyId, asOfDate, currencyCode, partyId, status } = {}) {
  if (!companyId) throw new Error("getAgingRows requires companyId - no fallback to all companies.");
  const reportDate = asOfDate || new Date().toISOString().slice(0, 10);
  const raw = await fetchRawRows(type, reportDate, companyId);
  const shaped = raw.map((r) => shapeRow(r, reportDate));
  return applyFilters(shaped, { currencyCode, partyId, status });
}

const EMPTY_BUCKETS = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0 };

function getBucketTotals(rows) {
  const base = { ...EMPTY_BUCKETS };
  const byCurrency = {};

  for (const row of rows) {
    base[row.bucket] += row.baseBalance;
    base.total += row.baseBalance;

    if (row.isForeign && row.currencyCode) {
      if (!byCurrency[row.currencyCode]) {
        byCurrency[row.currencyCode] = { ...EMPTY_BUCKETS, currencySymbol: row.currencySymbol };
      }
      byCurrency[row.currencyCode][row.bucket] += row.foreignBalance || 0;
      byCurrency[row.currencyCode].total += row.foreignBalance || 0;
    }
  }

  for (const key of Object.keys(base)) base[key] = Math.round(base[key] * 100) / 100;
  for (const code of Object.keys(byCurrency)) {
    for (const key of Object.keys(EMPTY_BUCKETS)) {
      byCurrency[code][key] = Math.round(byCurrency[code][key] * 100) / 100;
    }
  }

  return { base, byCurrency };
}

function getSummaryByParty(rows) {
  const parties = new Map();

  for (const row of rows) {
    const key = row.partyId != null ? `id:${row.partyId}` : `name:${row.partyName}`;
    if (!parties.has(key)) {
      parties.set(key, {
        partyId: row.partyId,
        partyName: row.partyName,
        baseBalance: 0,
        documentCount: 0,
        buckets: { ...EMPTY_BUCKETS },
        foreignByCurrency: {},
      });
    }
    const p = parties.get(key);
    p.baseBalance += row.baseBalance;
    p.documentCount += 1;
    p.buckets[row.bucket] += row.baseBalance;
    p.buckets.total += row.baseBalance;

    if (row.isForeign && row.currencyCode) {
      if (!p.foreignByCurrency[row.currencyCode]) {
        p.foreignByCurrency[row.currencyCode] = { currencySymbol: row.currencySymbol, original: 0, paid: 0, balance: 0 };
      }
      const fc = p.foreignByCurrency[row.currencyCode];
      fc.original += row.foreignOriginal || 0;
      fc.paid += row.foreignPaid || 0;
      fc.balance += row.foreignBalance || 0;
    }
  }

  const result = Array.from(parties.values()).map((p) => {
    p.baseBalance = Math.round(p.baseBalance * 100) / 100;
    for (const key of Object.keys(p.buckets)) p.buckets[key] = Math.round(p.buckets[key] * 100) / 100;
    for (const code of Object.keys(p.foreignByCurrency)) {
      const fc = p.foreignByCurrency[code];
      fc.original = Math.round(fc.original * 100) / 100;
      fc.paid = Math.round(fc.paid * 100) / 100;
      fc.balance = Math.round(fc.balance * 100) / 100;
    }
    return p;
  });

  result.sort((a, b) => (a.partyName || "").localeCompare(b.partyName || ""));
  return result;
}

module.exports = {
  getAgingRows,
  getBucketTotals,
  getSummaryByParty,
  daysBetween,
  bucketOf,
};