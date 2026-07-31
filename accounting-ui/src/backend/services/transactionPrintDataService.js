const pool = require("../db");
const { HttpError } = require("../lib/httpError");

// Shared and configurable printing framework (Phase 1 = invoice, Phase 2
// adds or/apv/cv) - one query builder driven by this table/column config
// instead of a copy-pasted service per module. Adding a module later is a
// new MODULE_CONFIG entry, not new query code.
//
// *_lines doubles as both the item list and the GL entries for every one
// of these modules (no separate qty/unit-price/discount/VAT/EWT columns
// exist today) - see transaction_print_permissions_migration.sql and the
// Phase 1 plan for why "without entries" strips account code/title/debit/
// credit down to a single customer-facing amount per line.
const MODULE_CONFIG = {
  invoice: {
    moduleKey: "TRANSACTIONS.INVOICE",
    headerTable: "invoice_headers",
    lineTable: "invoice_lines",
    lineIdCol: "invoice_id",
    partyIdCol: "customer_id",
    partyNameCol: "customer_name",
    hasDueDate: true,
    hasPaidBalance: true,
    hasCheck: false,
    hasPaymentMethod: false,
  },
  or: {
    moduleKey: "TRANSACTIONS.OR",
    headerTable: "or_headers",
    lineTable: "or_lines",
    lineIdCol: "or_id",
    partyIdCol: "customer_id",
    partyNameCol: "customer_name",
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: true,
    hasPaymentMethod: true,
  },
  apv: {
    moduleKey: "TRANSACTIONS.APV",
    headerTable: "apv_headers",
    lineTable: "apv_lines",
    lineIdCol: "apv_id",
    partyIdCol: "supplier_id",
    partyNameCol: "supplier_name",
    hasDueDate: true,
    hasPaidBalance: true,
    hasCheck: false,
    hasPaymentMethod: false,
  },
  cv: {
    moduleKey: "TRANSACTIONS.CV",
    headerTable: "cv_headers",
    lineTable: "cv_lines",
    lineIdCol: "cv_id",
    partyIdCol: "payee_id",
    partyNameCol: "payee_name",
    hasDueDate: false,
    hasPaidBalance: false,
    hasCheck: true,
    hasPaymentMethod: true,
  },
};

function getModuleConfig(transactionType) {
  const cfg = MODULE_CONFIG[transactionType];
  if (!cfg) throw new HttpError(400, `Unsupported print module: ${transactionType}`);
  return cfg;
}

async function getCompanyProfile() {
  const [rows] = await pool.execute(
    "SELECT payor_name AS name, payor_tin AS tin, payor_address AS address, payor_zip AS zip FROM company_profile WHERE id = 1"
  );
  return rows[0] || { name: "", tin: "", address: "", zip: "" };
}

function mapLines(lineRows, withEntries) {
  return lineRows.map((l) => {
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
}

function buildEntriesSummary(lineRows) {
  const totalDebit = lineRows.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lineRows.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  return { totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

async function getTransactionDocument(transactionType, id, { withEntries }) {
  const cfg = getModuleConfig(transactionType);

  const metaCols = [
    "id",
    "voucher_no AS voucherNo",
    `${cfg.partyIdCol} AS partyId`,
    `${cfg.partyNameCol} AS partyName`,
    "DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate",
    "reference_no AS referenceNo",
    "description",
    "remarks",
    "total_debit AS totalDebit",
    "total_credit AS totalCredit",
    "status",
  ];
  if (cfg.hasDueDate) metaCols.push("DATE_FORMAT(due_date, '%Y-%m-%d') AS dueDate");
  if (cfg.hasPaidBalance) {
    metaCols.push("paid_amount AS paidAmount", "balance_amount AS balanceAmount", "payment_status AS paymentStatus");
  }
  if (cfg.hasCheck) metaCols.push("check_no AS checkNo", "DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate");
  if (cfg.hasPaymentMethod) metaCols.push("payment_method AS paymentMethod", "bank_account_id AS bankAccountId");

  const [headers] = await pool.execute(
    `SELECT ${metaCols.join(", ")} FROM ${cfg.headerTable} WHERE id = ?`,
    [id]
  );
  if (headers.length === 0) {
    throw new HttpError(404, "Transaction not found");
  }
  const doc = headers[0];

  const [lineRows] = await pool.execute(
    `SELECT account_code AS accountCode, account_title AS accountTitle, particulars,
      debit, credit, gen_ref AS genRef, gen_name AS genName
    FROM ${cfg.lineTable}
    WHERE ${cfg.lineIdCol} = ?
    ORDER BY id ASC`,
    [id]
  );

  const lines = mapLines(lineRows, withEntries);
  const entriesSummary = withEntries ? buildEntriesSummary(lineRows) : null;

  let party = null;
  if (doc.partyId) {
    const [partyRows] = await pool.execute(
      `SELECT name, address1, address2, address3, tin, telephone, mobile, email
      FROM general_libraries WHERE id = ?`,
      [doc.partyId]
    );
    party = partyRows[0] || null;
  }

  let bankAccount = null;
  if (cfg.hasPaymentMethod && doc.bankAccountId) {
    const [bankRows] = await pool.execute(
      `SELECT bank_code AS bankCode, bank_name AS bankName, account_no AS accountNo FROM bank_codes WHERE id = ?`,
      [doc.bankAccountId]
    );
    bankAccount = bankRows[0] || null;
  }

  const company = await getCompanyProfile();

  return { doc, lines, entriesSummary, party, bankAccount, company };
}

// grouping: "number" | "date" | "due_date" | "check_number" (flat sort) or
// "party" | "payment_method" | "bank_account" (subtotal groups).
const FLAT_ORDER_BY = {
  number: "voucher_no ASC",
  date: "transaction_date ASC, voucher_no ASC",
  due_date: "due_date ASC, voucher_no ASC",
  check_number: "check_no ASC, voucher_no ASC",
};

const GROUP_ORDER_BY = {
  party: "partyName ASC, transaction_date ASC",
  payment_method: "paymentMethod ASC, transaction_date ASC",
  bank_account: "bankAccountId ASC, transaction_date ASC",
};

const GROUP_KEY_FIELD = {
  party: { key: "partyId", label: "partyName", fallbackLabel: "(No Party)" },
  payment_method: { key: "paymentMethod", label: "paymentMethod", fallbackLabel: "(No Payment Method)" },
  bank_account: { key: "bankAccountId", label: "bankAccountId", fallbackLabel: "(No Bank Account)" },
};

async function getTransactionList(transactionType, { from, to, grouping }) {
  const cfg = getModuleConfig(transactionType);

  const cols = [
    "id",
    "voucher_no AS voucherNo",
    `${cfg.partyIdCol} AS partyId`,
    `${cfg.partyNameCol} AS partyName`,
    "DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate",
    "reference_no AS referenceNo",
    "status",
    "total_debit AS totalAmount",
  ];
  if (cfg.hasPaidBalance) cols.push("paid_amount AS paidAmount", "balance_amount AS balanceAmount");
  if (cfg.hasDueDate) cols.push("DATE_FORMAT(due_date, '%Y-%m-%d') AS dueDate");
  if (cfg.hasCheck) cols.push("check_no AS checkNo");
  if (cfg.hasPaymentMethod) cols.push("payment_method AS paymentMethod", "bank_account_id AS bankAccountId");

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

  const isGrouped = Object.prototype.hasOwnProperty.call(GROUP_ORDER_BY, grouping);
  const orderBy = isGrouped ? GROUP_ORDER_BY[grouping] : FLAT_ORDER_BY[grouping] || FLAT_ORDER_BY.number;

  const [rows] = await pool.execute(
    `SELECT ${cols.join(", ")} FROM ${cfg.headerTable} ${where} ORDER BY ${orderBy}`,
    params
  );

  let bankLabels = null;
  if (grouping === "bank_account" || cfg.hasPaymentMethod) {
    const [bankRows] = await pool.execute(
      "SELECT id, bank_code AS bankCode, bank_name AS bankName, account_no AS accountNo FROM bank_codes"
    );
    bankLabels = new Map(bankRows.map((b) => [b.id, `${b.bankCode} - ${b.bankName} (${b.accountNo})`]));
  }

  const company = await getCompanyProfile();

  if (isGrouped) {
    const { key, label, fallbackLabel } = GROUP_KEY_FIELD[grouping];
    const groupsMap = new Map();
    for (const row of rows) {
      const rawKey = row[key];
      const mapKey = rawKey ?? "UNASSIGNED";
      if (!groupsMap.has(mapKey)) {
        let groupLabel = row[label] || fallbackLabel;
        if (grouping === "bank_account") {
          groupLabel = (rawKey && bankLabels?.get(rawKey)) || fallbackLabel;
        }
        groupsMap.set(mapKey, { groupLabel, rows: [], subtotal: 0 });
      }
      const group = groupsMap.get(mapKey);
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

module.exports = { getCompanyProfile, getTransactionDocument, getTransactionList, MODULE_CONFIG };
