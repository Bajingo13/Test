const pool = require("../db");
const { postedOnlySql } = require("./reportRecognitionService");
const { normalizeVatTreatment, roundMoney } = require("./vatCalculationService");

// Phase 7F: one normalized Output VAT report dataset, structured-first with a
// GL fallback for historical/legacy records.
//
// Authoritative source per transaction:
//   - a transaction (INV) that has structured OUTPUT_VAT rows in
//     transaction_tax_entries  -> use ONLY those (never also its GL line)
//   - a transaction with no structured OUTPUT_VAT entry (pre-Phase-7C
//     Invoices, and every OR - OR never writes structured entries) ->
//     GL fallback: its posted journal lines to the selected Output VAT
//     account_code
//
// Classification is taken from the stored Phase 7E vat_treatment SNAPSHOT
// only - never inferred from rate, account name, or GL title. ZERO_RATED
// and EXEMPT are kept in separate buckets from STANDARD (and from each
// other). Posted-only and company-scoped, exactly like every other report.
//
// This is the single dataset the UI and any export/print surface consume -
// there is no second calculation path.

const INCLUSION_RULE = "POSTED transactions only";

async function getOutputVatReport({ companyId, from, to, accountCode }) {
  const cid = Number(companyId);
  const acct = accountCode ? String(accountCode) : null;

  // ---- 1. Structured OUTPUT_VAT entries (authoritative for modern Invoices) ----
  const [structRows] = await pool.execute(
    `SELECT
       h.id AS transactionId,
       DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS date,
       h.voucher_no AS docRef,
       COALESCE(NULLIF(tte.party_name_snapshot, ''), h.customer_name) AS customer,
       tte.party_tin_snapshot AS tin,
       tte.vat_treatment AS vatTreatment,
       tte.net_amount AS netAmount,
       tte.vat_amount AS vatAmount,
       tte.gross_amount AS grossAmount
     FROM transaction_tax_entries tte
     JOIN invoice_headers h ON h.id = tte.transaction_id
     WHERE tte.transaction_type = 'INV'
       AND tte.entry_type = 'OUTPUT_VAT'
       AND tte.company_id = ?
       AND h.company_id = ?
       AND h.transaction_date BETWEEN ? AND ?
       AND ${postedOnlySql("h")}
     ORDER BY h.transaction_date, h.voucher_no, tte.id`,
    [cid, cid, from, to]
  );

  // One row per Invoice; buckets summed across its OUTPUT_VAT entries
  // (an invoice can carry e.g. a STANDARD line and a ZERO_RATED line).
  const byTxn = new Map();
  for (const r of structRows) {
    let row = byTxn.get(r.transactionId);
    if (!row) {
      row = {
        date: r.date, sourceType: "INV", docRef: r.docRef,
        customer: r.customer || "", tin: r.tin || "",
        vatableSales: 0, zeroRatedSales: 0, exemptSales: 0,
        vatAmount: 0, grossAmount: 0, source: "structured",
      };
      byTxn.set(r.transactionId, row);
    }
    const net = Number(r.netAmount) || 0;
    const vat = Number(r.vatAmount) || 0;
    const gross = Number(r.grossAmount) || 0;
    const t = normalizeVatTreatment(r.vatTreatment);
    if (t === "ZERO_RATED") {
      row.zeroRatedSales = roundMoney(row.zeroRatedSales + net);
    } else if (t === "EXEMPT") {
      row.exemptSales = roundMoney(row.exemptSales + net);
    } else {
      row.vatableSales = roundMoney(row.vatableSales + net);
      row.vatAmount = roundMoney(row.vatAmount + vat);
    }
    row.grossAmount = roundMoney(row.grossAmount + gross);
  }
  for (const row of byTxn.values()) {
    // STANDARD identity: gross ~= vatable + zero-rated + exempt + VAT
    // (zero-rated/exempt contribute gross === base, VAT 0). Flag only -
    // never drop a historical row just because it does not reconcile.
    const parts = row.vatableSales + row.zeroRatedSales + row.exemptSales + row.vatAmount;
    row.reconciles = Math.abs(row.grossAmount - parts) < 0.01;
  }

  // ---- 2. GL fallback for transactions with NO structured OUTPUT_VAT entry ----
  let glRows = [];
  if (acct) {
    const [gl] = await pool.execute(
      `SELECT src, transactionId, date, docRef, customer, headerTotal,
              ROUND(SUM(credit) - SUM(debit), 2) AS vatAmount
       FROM (
         SELECT 'INV' AS src, h.id AS transactionId,
                DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS date,
                h.voucher_no AS docRef, h.customer_name AS customer,
                h.total_debit AS headerTotal,
                COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit
         FROM invoice_lines l
         JOIN invoice_headers h ON h.id = l.invoice_id
         WHERE l.account_code = ?
           AND h.company_id = ?
           AND h.transaction_date BETWEEN ? AND ?
           AND ${postedOnlySql("h")}
           AND h.id NOT IN (
             SELECT DISTINCT transaction_id FROM transaction_tax_entries
             WHERE transaction_type = 'INV' AND entry_type = 'OUTPUT_VAT' AND company_id = ?
           )

         UNION ALL

         SELECT 'OR' AS src, h.id AS transactionId,
                DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS date,
                h.voucher_no AS docRef, h.customer_name AS customer,
                h.total_debit AS headerTotal,
                COALESCE(l.debit, 0) AS debit, COALESCE(l.credit, 0) AS credit
         FROM or_lines l
         JOIN or_headers h ON h.id = l.or_id
         WHERE l.account_code = ?
           AND h.company_id = ?
           AND h.transaction_date BETWEEN ? AND ?
           AND ${postedOnlySql("h")}
       ) x
       GROUP BY src, transactionId, date, docRef, customer, headerTotal
       HAVING ROUND(SUM(credit) - SUM(debit), 2) <> 0
       ORDER BY date, docRef`,
      [acct, cid, from, to, cid, acct, cid, from, to]
    );

    glRows = gl.map((r) => ({
      date: r.date, sourceType: r.src, docRef: r.docRef,
      customer: r.customer || "", tin: "",
      // The GL line alone does not carry a net/base or a treatment, so a
      // GL-fallback row can only report its VAT Amount honestly. It is
      // never placed in the VATable/Zero-Rated/Exempt buckets (that would
      // be inferring a classification that was never recorded).
      vatableSales: null, zeroRatedSales: null, exemptSales: null,
      vatAmount: roundMoney(Number(r.vatAmount) || 0),
      grossAmount: Number(r.headerTotal) || 0,
      source: "gl", reconciles: null,
    }));
  }

  const rows = [...byTxn.values(), ...glRows].sort(
    (a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      String(a.docRef).localeCompare(String(b.docRef))
  );

  const totals = rows.reduce(
    (t, r) => ({
      vatableSales: roundMoney(t.vatableSales + (Number(r.vatableSales) || 0)),
      zeroRatedSales: roundMoney(t.zeroRatedSales + (Number(r.zeroRatedSales) || 0)),
      exemptSales: roundMoney(t.exemptSales + (Number(r.exemptSales) || 0)),
      vatAmount: roundMoney(t.vatAmount + (Number(r.vatAmount) || 0)),
      grossAmount: roundMoney(t.grossAmount + (Number(r.grossAmount) || 0)),
    }),
    { vatableSales: 0, zeroRatedSales: 0, exemptSales: 0, vatAmount: 0, grossAmount: 0 }
  );

  return { inclusionRule: INCLUSION_RULE, rows, totals };
}

module.exports = { getOutputVatReport, INCLUSION_RULE };
