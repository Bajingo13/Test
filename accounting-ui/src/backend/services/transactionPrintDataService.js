const pool = require("../db");
const { HttpError } = require("../lib/httpError");

// invoice_lines doubles as both the item list and the GL entries (no
// separate qty/unit-price/discount/VAT/EWT columns exist today) - see
// transaction_print_permissions_migration.sql and the Phase 1 plan for why
// "without entries" strips account code/title/debit/credit down to a
// single customer-facing amount per line.
async function getCompanyProfile() {
  const [rows] = await pool.execute(
    "SELECT payor_name AS name, payor_tin AS tin, payor_address AS address, payor_zip AS zip FROM company_profile WHERE id = 1"
  );
  return rows[0] || { name: "", tin: "", address: "", zip: "" };
}

async function getInvoiceDocument(id, { withEntries }) {
  const [headers] = await pool.execute(
    `SELECT
      id,
      voucher_no AS voucherNo,
      customer_id AS customerId,
      customer_name AS customerName,
      DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
      DATE_FORMAT(due_date, '%Y-%m-%d') AS dueDate,
      reference_no AS referenceNo,
      description,
      remarks,
      total_debit AS totalDebit,
      total_credit AS totalCredit,
      paid_amount AS paidAmount,
      balance_amount AS balanceAmount,
      payment_status AS paymentStatus,
      status
    FROM invoice_headers
    WHERE id = ?`,
    [id]
  );

  if (headers.length === 0) {
    throw new HttpError(404, "Invoice not found");
  }
  const invoice = headers[0];

  const [lineRows] = await pool.execute(
    `SELECT account_code AS accountCode, account_title AS accountTitle, particulars,
      debit, credit, gen_ref AS genRef, gen_name AS genName
    FROM invoice_lines
    WHERE invoice_id = ?
    ORDER BY id ASC`,
    [id]
  );

  const lines = lineRows.map((l) => {
    const amount = Number(l.debit) > 0 ? Number(l.debit) : Number(l.credit);
    if (withEntries) {
      return {
        particulars: l.particulars,
        amount,
        accountCode: l.accountCode,
        accountTitle: l.accountTitle,
        debit: Number(l.debit) || 0,
        credit: Number(l.credit) || 0,
        genRef: l.genRef,
        genName: l.genName,
      };
    }
    return { particulars: l.particulars, amount };
  });

  let entriesSummary = null;
  if (withEntries) {
    const totalDebit = lineRows.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const totalCredit = lineRows.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    entriesSummary = {
      totalDebit,
      totalCredit,
      balanced: Math.abs(totalDebit - totalCredit) < 0.01,
    };
  }

  let customer = null;
  if (invoice.customerId) {
    const [custRows] = await pool.execute(
      `SELECT name, address1, address2, address3, tin, telephone, mobile, email
      FROM general_libraries WHERE id = ?`,
      [invoice.customerId]
    );
    customer = custRows[0] || null;
  }

  const company = await getCompanyProfile();

  return { invoice, lines, entriesSummary, customer, company };
}

const LIST_ORDER_BY = {
  number: "voucher_no ASC",
  date: "transaction_date ASC, voucher_no ASC",
  customer: "customer_name ASC, transaction_date ASC",
};

async function getInvoiceList({ from, to, customerId, grouping }) {
  const params = [];
  let where = "WHERE 1=1";

  if (from) {
    where += " AND transaction_date >= ?";
    params.push(from);
  }
  if (to) {
    where += " AND transaction_date <= ?";
    params.push(to);
  }
  if (customerId) {
    where += " AND customer_id = ?";
    params.push(customerId);
  }

  const orderBy = LIST_ORDER_BY[grouping] || LIST_ORDER_BY.number;

  const [rows] = await pool.execute(
    `SELECT
      id,
      voucher_no AS voucherNo,
      customer_id AS customerId,
      customer_name AS customerName,
      DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
      reference_no AS referenceNo,
      status,
      total_debit AS totalAmount,
      paid_amount AS paidAmount,
      balance_amount AS balanceAmount
    FROM invoice_headers
    ${where}
    ORDER BY ${orderBy}`,
    params
  );

  const company = await getCompanyProfile();

  if (grouping === "customer") {
    const groupsMap = new Map();
    for (const row of rows) {
      const key = row.customerId || row.customerName || "UNASSIGNED";
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          customerId: row.customerId,
          customerName: row.customerName || "(No Customer)",
          rows: [],
          subtotal: 0,
        });
      }
      const group = groupsMap.get(key);
      group.rows.push(row);
      group.subtotal += Number(row.totalAmount) || 0;
    }
    const groups = [...groupsMap.values()];
    const grandTotal = groups.reduce((s, g) => s + g.subtotal, 0);
    return { company, grouping, groups, grandTotal, count: rows.length };
  }

  const grandTotal = rows.reduce((s, r) => s + (Number(r.totalAmount) || 0), 0);
  return { company, grouping, rows, grandTotal, count: rows.length };
}

module.exports = { getCompanyProfile, getInvoiceDocument, getInvoiceList };
