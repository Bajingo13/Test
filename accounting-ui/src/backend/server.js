require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const pool = require("./db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { parse: parseCsv } = require("csv-parse/sync");
const ExcelJS = require("exceljs");

console.log("ENV FILE:", require("path").resolve(".env"));
console.log("JWT_SECRET loaded:", Boolean(process.env.JWT_SECRET));

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim());

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Bank statement uploads: kept in memory (never written to disk) and capped
// at 10MB; only CSV/XLS/XLSX are accepted for the bank reconciliation import.
const bankStatementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if ([".csv", ".xls", ".xlsx"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .csv, .xls, or .xlsx files are supported"));
    }
  },
});



async function updateInvoicePaymentStatus(conn, invoiceId) {
  const [invoiceRows] = await conn.execute(
    `SELECT 
       total_debit AS totalDebit,
       total_credit AS totalCredit
     FROM invoice_headers
     WHERE id = ?`,
    [invoiceId]
  );

  if (invoiceRows.length === 0) return;

  const totalAmount = Math.max(
    Number(invoiceRows[0].totalDebit || 0),
    Number(invoiceRows[0].totalCredit || 0)
  );

  const [paymentRows] = await conn.execute(
    `SELECT COALESCE(SUM(amount), 0) AS paidAmount
     FROM transaction_applications
     WHERE source_type = 'INV'
       AND source_id = ?`,
    [invoiceId]
  );

  const paidAmount = Number(paymentRows[0].paidAmount || 0);
  const balanceAmount = Math.max(totalAmount - paidAmount, 0);

  let paymentStatus = "Unpaid";

  if (paidAmount > 0 && paidAmount < totalAmount) {
    paymentStatus = "Partially Paid";
  } else if (paidAmount >= totalAmount && totalAmount > 0) {
    paymentStatus = "Paid";
  }

  await conn.execute(
    `UPDATE invoice_headers
     SET paid_amount = ?,
         balance_amount = ?,
         payment_status = ?
     WHERE id = ?`,
    [paidAmount, balanceAmount, paymentStatus, invoiceId]
  );
}

async function updateApvPaymentStatus(conn, apvId) {
  const [apvRows] = await conn.execute(
    `SELECT 
       total_debit AS totalDebit,
       total_credit AS totalCredit
     FROM apv_headers
     WHERE id = ?`,
    [apvId]
  );

  if (apvRows.length === 0) return;

  const totalAmount = Math.max(
    Number(apvRows[0].totalDebit || 0),
    Number(apvRows[0].totalCredit || 0)
  );

  const [paymentRows] = await conn.execute(
    `SELECT COALESCE(SUM(amount), 0) AS paidAmount
     FROM transaction_applications
     WHERE source_type = 'APV'
       AND source_id = ?`,
    [apvId]
  );

  const paidAmount = Number(paymentRows[0].paidAmount || 0);
  const balanceAmount = Math.max(totalAmount - paidAmount, 0);

  let paymentStatus = "Unpaid";

  if (paidAmount > 0 && paidAmount < totalAmount) {
    paymentStatus = "Partially Paid";
  } else if (paidAmount >= totalAmount && totalAmount > 0) {
    paymentStatus = "Paid";
  }

  await conn.execute(
    `UPDATE apv_headers
     SET paid_amount = ?,
         balance_amount = ?,
         payment_status = ?
     WHERE id = ?`,
    [paidAmount, balanceAmount, paymentStatus, apvId]
  );
}

// ===================== LOGIN =====================

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const [rows] = await pool.execute(
      "SELECT id, username, password, role FROM users WHERE username = ?",
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const user = rows[0];

    // If your passwords are still plain text, temporarily use:
    // const isMatch = password === user.password;

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Access token required" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    req.user = user;
    next();
  });
}

// ===================== GENERAL LIBRARIES API =====================

app.get("/api/genlib", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        code,
        party_type AS type,
        name,
        status,
        DATE_FORMAT(start_date, '%Y-%m-%d') AS startDate,
        address1,
        address2,
        address3,
        attention,
        position,
        telephone,
        fax,
        mobile,
        tin,
        email,
        atc_code AS atcCode,
        ewt_code AS ewtCode,
        category,
        branch_code AS branchCode,
        rdo_code AS rdoCode,
        notes,
        is_prospective AS isProspective,
        is_client AS isClient
      FROM general_libraries
      ORDER BY id DESC
    `);

    const records = rows.map((row) => ({
      ...row,
      isProspective: Boolean(row.isProspective),
      isClient: Boolean(row.isClient),
    }));

    res.json(records);
  } catch (err) {
    console.error("GET GENLIB ERROR:", err);
    res.status(500).json({ message: "Failed to load General Libraries" });
  }
});

app.post("/api/genlib", async (req, res) => {
  try {
    const item = req.body;

    const [result] = await pool.execute(
      `INSERT INTO general_libraries (
        code, party_type, name, status, start_date,
        address1, address2, address3, attention, position,
        telephone, fax, mobile, tin, email,
        atc_code, ewt_code, category, branch_code, rdo_code,
        notes, is_prospective, is_client
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.code,
        item.type,
        item.name,
        item.status,
        item.startDate,
        item.address1,
        item.address2,
        item.address3,
        item.attention,
        item.position,
        item.telephone,
        item.fax,
        item.mobile,
        item.tin,
        item.email,
        item.atcCode,
        item.ewtCode,
        item.category,
        item.branchCode,
        item.rdoCode,
        item.notes,
        item.isProspective ? 1 : 0,
        item.isClient ? 1 : 0,
      ]
    );

    res.json({
      success: true,
      message: "Record created successfully",
      id: result.insertId,
    });
  } catch (err) {
    console.error("CREATE GENLIB ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Code already exists" });
    }

    res.status(500).json({ message: "Failed to create record" });
  }
});

app.put("/api/genlib/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const item = req.body;

    await pool.execute(
      `UPDATE general_libraries SET
        code = ?,
        party_type = ?,
        name = ?,
        status = ?,
        start_date = ?,
        address1 = ?,
        address2 = ?,
        address3 = ?,
        attention = ?,
        position = ?,
        telephone = ?,
        fax = ?,
        mobile = ?,
        tin = ?,
        email = ?,
        atc_code = ?,
        ewt_code = ?,
        category = ?,
        branch_code = ?,
        rdo_code = ?,
        notes = ?,
        is_prospective = ?,
        is_client = ?
      WHERE id = ?`,
      [
        item.code,
        item.type,
        item.name,
        item.status,
        item.startDate,
        item.address1,
        item.address2,
        item.address3,
        item.attention,
        item.position,
        item.telephone,
        item.fax,
        item.mobile,
        item.tin,
        item.email,
        item.atcCode,
        item.ewtCode,
        item.category,
        item.branchCode,
        item.rdoCode,
        item.notes,
        item.isProspective ? 1 : 0,
        item.isClient ? 1 : 0,
        id,
      ]
    );

    res.json({
      success: true,
      message: "Record updated successfully",
    });
  } catch (err) {
    console.error("UPDATE GENLIB ERROR:", err);
    res.status(500).json({ message: "Failed to update record" });
  }
});

app.delete("/api/genlib/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute("DELETE FROM general_libraries WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Record deleted successfully",
    });
  } catch (err) {
    console.error("DELETE GENLIB ERROR:", err);
    res.status(500).json({ message: "Failed to delete record" });
  }
});

async function syncBankCodeForAccount(conn, coaId, code, title, validations) {
  const isBankAccount = (validations || []).includes("BANK / CASH");

  const [existing] = await conn.execute(
    "SELECT id FROM bank_codes WHERE coa_account_id = ?",
    [coaId]
  );

  if (isBankAccount) {
    if (existing.length > 0) {
      await conn.execute(
        "UPDATE bank_codes SET coa_code = ?, status = 'ACTIVE' WHERE coa_account_id = ?",
        [code, coaId]
      );
    } else {
      await conn.execute(
        `INSERT INTO bank_codes (bank_code, bank_name, account_name, coa_account_id, coa_code, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
        [code, title, title, coaId, code]
      );
    }
  } else if (existing.length > 0) {
    await conn.execute(
      "UPDATE bank_codes SET status = 'INACTIVE' WHERE coa_account_id = ?",
      [coaId]
    );
  }
}

// Writes an audit_logs row. Pass the active transaction's `conn` (not the
// pool) when called inside a transaction so a logging failure rolls back
// the action it's documenting instead of silently leaving no trail.
async function logAudit(
  db,
  { module, entityType, entityId, action, description, beforeData = null, afterData = null, user = null }
) {
  await db.execute(
    `INSERT INTO audit_logs(module, entity_type, entity_id, action, description, before_data, after_data, user_id, username)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      module,
      entityType,
      entityId,
      action,
      description,
      beforeData ? JSON.stringify(beforeData) : null,
      afterData ? JSON.stringify(afterData) : null,
      user?.id || null,
      user?.username || null,
    ]
  );
}

// ===================== COA API =====================

app.get("/api/coa", authenticateToken, async (req, res) => {
  try {
    const [accounts] = await pool.execute(`
      SELECT
        id,
        code,
        DATE_FORMAT(account_date, '%Y-%m-%d') AS date,
        title,
        account_class AS accountClass,
        description
      FROM chart_of_accounts
      ORDER BY id DESC
    `);

    for (const account of accounts) {
      const [validations] = await pool.execute(
        "SELECT validation_name FROM coa_validations WHERE coa_id = ?",
        [account.id]
      );

      const [groups] = await pool.execute(
        `SELECT
          id,
          group_code AS code,
          group_description AS description
        FROM coa_groups
        WHERE coa_id = ?`,
        [account.id]
      );

      account.validations = validations.map(
        (item) => item.validation_name
      );

      account.groups = groups;
    }

    res.json(accounts);
  } catch (err) {
    console.error("GET COA ERROR:", err);

    res.status(500).json({
      message: "Failed to load Chart of Accounts",
    });
  }
});

app.post("/api/coa", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { code, date, title, accountClass, description, validations, groups } = req.body;

    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO chart_of_accounts 
        (code, account_date, title, account_class, description)
       VALUES (?, ?, ?, ?, ?)`,
      [code, date, title, accountClass, description]
    );

    const coaId = result.insertId;

    for (const validation of validations || []) {
      await conn.execute(
        "INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)",
        [coaId, validation]
      );
    }

    for (const group of groups || []) {
      await conn.execute(
        "INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)",
        [coaId, group.code, group.description]
      );
    }

    await syncBankCodeForAccount(conn, coaId, code, title, validations);

    await conn.commit();

    res.json({
      success: true,
      message: "Account created successfully",
      id: coaId,
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE COA ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Account code already exists" });
    }

    res.status(500).json({ message: "Failed to create account" });
  } finally {
    conn.release();
  }
});

app.put("/api/coa/:id", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { code, date, title, accountClass, description, validations, groups } = req.body;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE chart_of_accounts 
       SET code = ?, account_date = ?, title = ?, account_class = ?, description = ?
       WHERE id = ?`,
      [code, date, title, accountClass, description, id]
    );

    await conn.execute("DELETE FROM coa_validations WHERE coa_id = ?", [id]);
    await conn.execute("DELETE FROM coa_groups WHERE coa_id = ?", [id]);

    for (const validation of validations || []) {
      await conn.execute(
        "INSERT INTO coa_validations (coa_id, validation_name) VALUES (?, ?)",
        [id, validation]
      );
    }

    for (const group of groups || []) {
      await conn.execute(
        "INSERT INTO coa_groups (coa_id, group_code, group_description) VALUES (?, ?, ?)",
        [id, group.code, group.description]
      );
    }

    await syncBankCodeForAccount(conn, id, code, title, validations);

    await conn.commit();

    res.json({
      success: true,
      message: "Account updated successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE COA ERROR:", err);
    res.status(500).json({ message: "Failed to update account" });
  } finally {
    conn.release();
  }
});

app.delete("/api/coa/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute("DELETE FROM chart_of_accounts WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (err) {
    console.error("DELETE COA ERROR:", err);
    res.status(500).json({ message: "Failed to delete account" });
  }
});

// ===================== INVOICE API =====================

app.get("/api/invoices", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
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
        status,
        invoice_type AS invoiceType,
        recurrence_frequency AS recurrenceFrequency,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM invoice_headers
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET INVOICE ERROR:", err);
    res.status(500).json({ message: "Failed to load invoice records" });
  }
});

app.get("/api/invoices/unpaid", async (req, res) => {
  try {
    const { customerId, customerName } = req.query;

    const params = [];
    let customerFilterInv = "";
    let customerFilterBb = "";

    if (customerId) {
      customerFilterInv = " AND customer_id = ? ";
      customerFilterBb = " AND l.party_id = ? ";
      params.push(customerId, customerId);
    } else if (customerName) {
      customerFilterInv = " AND TRIM(LOWER(customer_name)) = TRIM(LOWER(?)) ";
      customerFilterBb = " AND TRIM(LOWER(l.party_name)) = TRIM(LOWER(?)) ";
      params.push(customerName, customerName);
    }

    const [rows] = await pool.execute(
      `
      SELECT
        id,
        'INV' AS sourceType,
        voucher_no AS voucherNo,
        customer_id AS customerId,
        customer_name AS customerName,
        total_debit AS totalAmount,
        COALESCE(paid_amount, 0) AS paidAmount,
        COALESCE(balance_amount, total_debit, 0) AS balanceAmount
      FROM invoice_headers
      WHERE COALESCE(balance_amount, total_debit, 0) > 0
        AND COALESCE(payment_status, 'Unpaid') != 'Paid'
        ${customerFilterInv}

      UNION ALL

      SELECT
        l.id,
        'AR_BEGINNING' AS sourceType,
        l.reference_no AS voucherNo,
        l.party_id AS customerId,
        l.party_name AS customerName,
        l.debit AS totalAmount,
        COALESCE(l.paid_amount, 0) AS paidAmount,
        COALESCE(l.balance_amount, l.debit, 0) AS balanceAmount
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
      WHERE h.balance_type = 'AR'
        AND COALESCE(l.balance_amount, l.debit, 0) > 0
        AND COALESCE(l.status, 'Unpaid') != 'Paid'
        ${customerFilterBb}

      ORDER BY voucherNo DESC
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("GET UNPAID INVOICE/AR BEGINNING ERROR:", err);
    res.status(500).json({ message: "Failed to load outstanding receivables" });
  }
});

app.get("/api/invoices/:id", async (req, res) => {
  try {
    const { id } = req.params;

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
        status,
        invoice_type AS invoiceType,
        recurrence_frequency AS recurrenceFrequency,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM invoice_headers
      WHERE id = ?`,
      [id]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const [lines] = await pool.execute(
      `SELECT
        id,
        invoice_id AS invoiceId,
        account_id AS accountId,
        account_code AS accountCode,
        account_title AS accountTitle,
        particulars,
        debit,
        credit,
        gen_ref AS genRef,
        gen_name AS genName
      FROM invoice_lines
      WHERE invoice_id = ?
      ORDER BY id ASC`,
      [id]
    );

    const [applications] = await pool.execute(
      `SELECT
        id,
        source_type AS sourceType,
        source_id AS sourceId,
        applied_type AS appliedType,
        applied_id AS appliedId,
        amount,
        DATE_FORMAT(application_date, '%Y-%m-%d') AS applicationDate,
        created_at AS createdAt
      FROM transaction_applications
      WHERE source_type = 'INV'
        AND source_id = ?
      ORDER BY id DESC`,
      [id]
    );

    res.json({
      ...headers[0],
      lines,
      applications,
    });
  } catch (err) {
    console.error("GET INVOICE DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load invoice details" });
  }
});

app.post("/api/invoices", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      voucherNo,
      customerId,
      customerName,
      transactionDate,
      dueDate,
      referenceNo,
      description,
      remarks,
      totalDebit,
      totalCredit,
      status,
      invoiceType,
      recurrenceFrequency,
      lines,
    } = req.body;

    await conn.beginTransaction();

    const total = Number(totalDebit || 0);

    const [result] = await conn.execute(
      `INSERT INTO invoice_headers (
        voucher_no,
        customer_id,
        customer_name,
        transaction_date,
        due_date,
        reference_no,
        description,
        remarks,
        total_debit,
        total_credit,
        paid_amount,
        balance_amount,
        payment_status,
        status,
        invoice_type,
        recurrence_frequency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        voucherNo,
        customerId || null,
        customerName || "",
        transactionDate || null,
        dueDate || transactionDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        total,
        totalCredit || 0,
        0,
        total,
        "Unpaid",
        status || "DRAFT",
        invoiceType === "Recurring" ? "Recurring" : "Standard",
        invoiceType === "Recurring" ? recurrenceFrequency || "Monthly" : null,
      ]
    );

    const invoiceId = result.insertId;

    for (const line of lines || []) {
      await conn.execute(
        `INSERT INTO invoice_lines (
          invoice_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
          line.genRef || "",
          line.genName || "",
        ]
      );
    }

    await conn.commit();

    res.json({
      success: true,
      message: "Invoice saved successfully",
      id: invoiceId,
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE INVOICE ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Invoice number already exists" });
    }

    res.status(500).json({ message: "Failed to save invoice" });
  } finally {
    conn.release();
  }
});

app.put("/api/invoices/:id", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const {
      voucherNo,
      customerId,
      customerName,
      transactionDate,
      dueDate,
      referenceNo,
      description,
      remarks,
      totalDebit,
      totalCredit,
      status,
      invoiceType,
      recurrenceFrequency,
      lines,
    } = req.body;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE invoice_headers SET
        voucher_no = ?,
        customer_id = ?,
        customer_name = ?,
        transaction_date = ?,
        due_date = ?,
        reference_no = ?,
        description = ?,
        remarks = ?,
        total_debit = ?,
        total_credit = ?,
        status = ?,
        invoice_type = ?,
        recurrence_frequency = ?
      WHERE id = ?`,
      [
        voucherNo,
        customerId || null,
        customerName || "",
        transactionDate || null,
        dueDate || transactionDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        totalDebit || 0,
        totalCredit || 0,
        status || "DRAFT",
        invoiceType === "Recurring" ? "Recurring" : "Standard",
        invoiceType === "Recurring" ? recurrenceFrequency || "Monthly" : null,
        id,
      ]
    );

    await conn.execute("DELETE FROM invoice_lines WHERE invoice_id = ?", [id]);

    for (const line of lines || []) {
      await conn.execute(
        `INSERT INTO invoice_lines (
          invoice_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
          line.genRef || "",
          line.genName || "",
        ]
      );
    }

    await updateInvoicePaymentStatus(conn, id);

    await conn.commit();

    res.json({
      success: true,
      message: "Invoice updated successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE INVOICE ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Invoice number already exists" });
    }

    res.status(500).json({ message: "Failed to update invoice" });
  } finally {
    conn.release();
  }
});

app.delete("/api/invoices/:id", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    await conn.beginTransaction();

    await conn.execute(
      `DELETE FROM transaction_applications
       WHERE source_type = 'INV'
         AND source_id = ?`,
      [id]
    );

    await conn.execute("DELETE FROM invoice_headers WHERE id = ?", [id]);

    await conn.commit();

    res.json({
      success: true,
      message: "Invoice deleted successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("DELETE INVOICE ERROR:", err);
    res.status(500).json({ message: "Failed to delete invoice" });
  } finally {
    conn.release();
  }
});


// ===================== OFFICIAL RECEIPT API =====================

app.get("/api/or", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        voucher_no AS voucherNo,
        customer_id AS customerId,
        customer_name AS customerName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        receipt_no AS receiptNo,
        description,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status,
        payment_method AS paymentMethod,
        bank_account_id AS bankAccountId,
        check_no AS checkNo,
        DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate
      FROM or_headers
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET OR ERROR:", err);
    res.status(500).json({ message: "Failed to load OR records" });
  }
});

app.post("/api/or", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const {
      voucherNo,
      customerId,
      customerName,
      transactionDate,
      referenceNo,
      receiptNo,
      description,
      totalDebit,
      totalCredit,
      status,
      paymentMethod,
      bankAccountId,
      checkNo,
      checkDate,
      lines = [],
      invoiceApplications = [],
    } = req.body;

    const finalCustomerId = customerId ?? req.body.partyId ?? null;
    const finalCustomerName = customerName || req.body.partyName || "";

    const [result] = await conn.execute(
      `INSERT INTO or_headers(
        voucher_no,
        customer_id,
        customer_name,
        transaction_date,
        reference_no,
        receipt_no,
        description,
        total_debit,
        total_credit,
        status,
        payment_method,
        bank_account_id,
        check_no,
        check_date
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        voucherNo || "",
        finalCustomerId,
        finalCustomerName,
        transactionDate || null,
        referenceNo || "",
        receiptNo || "",
        description || "",
        Number(totalDebit) || 0,
        Number(totalCredit) || 0,
        status || "Draft",
        paymentMethod === "Check" ? "Check" : "Cash",
        bankAccountId || null,
        paymentMethod === "Check" ? checkNo || "" : "",
        paymentMethod === "Check" ? checkDate || null : null,
      ]
    );

    const orId = result.insertId;

    for (const line of lines) {
      await conn.execute(
        `INSERT INTO or_lines(
          or_id,
          account_id,
          account_code,
          account_title,
          particulars,
          gen_ref,
          gen_name,
          debit,
          credit
        )
        VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          orId,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
        ]
      );
    }

    for (const appItem of invoiceApplications) {
      const sourceId = appItem.sourceId ?? appItem.invoiceId ?? null;
      const paymentAmount = Number(appItem.amount || 0);

      if (!sourceId || paymentAmount <= 0) continue;

      await conn.execute(
        `INSERT INTO transaction_applications
         (source_type, source_id, applied_type, applied_id, amount, application_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          appItem.sourceType === "AR_BEGINNING" ? "AR_BEGINNING" : "INV",
          sourceId,
          "OR",
          orId,
          paymentAmount,
          appItem.applicationDate || transactionDate || null,
        ]
      );

      if (appItem.sourceType === "AR_BEGINNING") {
        await conn.execute(
          `
          UPDATE arap_beginning_balance_lines
          SET paid_amount = COALESCE(paid_amount, 0) + ?,
              balance_amount = GREATEST(COALESCE(balance_amount, debit, 0) - ?, 0),
              status = CASE
                WHEN GREATEST(COALESCE(balance_amount, debit, 0) - ?, 0) <= 0 THEN 'Paid'
                ELSE 'Partially Paid'
              END
          WHERE id = ?
          `,
          [paymentAmount, paymentAmount, paymentAmount, sourceId]
        );
      } else {
        await updateInvoicePaymentStatus(conn, sourceId);
      }
    }

    await conn.commit();

    res.json({
      success: true,
      id: orId,
      message: "OR saved successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE OR ERROR:", err);

    res.status(500).json({
      message: "Failed to save OR",
    });
  } finally {
    conn.release();
  }
});

app.get("/api/or/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [headers] = await pool.execute(
      `SELECT
        id,
        voucher_no AS voucherNo,
        customer_id AS customerId,
        customer_name AS customerName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        receipt_no AS receiptNo,
        description,
        remarks,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status,
        payment_method AS paymentMethod,
        bank_account_id AS bankAccountId,
        check_no AS checkNo,
        DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate
      FROM or_headers
      WHERE id = ?`,
      [id]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "OR not found" });
    }

    const [lines] = await pool.execute(
      `SELECT
        id,
        or_id AS orId,
        account_id AS accountId,
        account_code AS accountCode,
        account_title AS accountTitle,
        particulars,
        debit,
        credit,
        gen_ref AS genRef,
        gen_name AS genName
      FROM or_lines
      WHERE or_id = ?
      ORDER BY id ASC`,
      [id]
    );

    const [applications] = await pool.execute(
      `SELECT
        id,
        source_type AS sourceType,
        source_id AS sourceId,
        applied_type AS appliedType,
        applied_id AS appliedId,
        amount,
        DATE_FORMAT(application_date, '%Y-%m-%d') AS applicationDate
      FROM transaction_applications
      WHERE applied_type = 'OR'
        AND applied_id = ?
      ORDER BY id DESC`,
      [id]
    );

    res.json({
      ...headers[0],
      lines,
      applications,
    });
  } catch (err) {
    console.error("GET OR DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load OR details" });
  }
});

app.put("/api/or/:id", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const {
      voucherNo,
      customerId,
      customerName,
      transactionDate,
      referenceNo,
      receiptNo,
      description,
      totalDebit,
      totalCredit,
      status,
      paymentMethod,
      bankAccountId,
      checkNo,
      checkDate,
      lines = [],
      invoiceApplications = [],
    } = req.body;

    await conn.beginTransaction();

    /*
     * STEP 1:
     * Load the OR's previous applications so their payment effects
     * can be reversed before the edited applications are saved.
     */
    const [oldApplications] = await conn.execute(
      `SELECT
         source_type AS sourceType,
         source_id AS sourceId,
         amount
       FROM transaction_applications
       WHERE applied_type = 'OR'
         AND applied_id = ?`,
      [id]
    );

    /*
     * STEP 2:
     * Remove the previous applications first.
     * Invoice status will later be recalculated using the remaining
     * transaction applications.
     */
    await conn.execute(
      `DELETE FROM transaction_applications
       WHERE applied_type = 'OR'
         AND applied_id = ?`,
      [id]
    );

    /*
     * STEP 3:
     * Reverse old payments applied to AR beginning balances.
     */
    for (const oldItem of oldApplications) {
      const oldAmount = Number(oldItem.amount || 0);

      if (oldItem.sourceType === "AR_BEGINNING") {
        await conn.execute(
          `
          UPDATE arap_beginning_balance_lines
          SET paid_amount = GREATEST(
                COALESCE(paid_amount, 0) - ?,
                0
              ),
              balance_amount = LEAST(
                COALESCE(balance_amount, debit, 0) + ?,
                COALESCE(debit, 0)
              ),
              status = CASE
                WHEN GREATEST(COALESCE(paid_amount, 0) - ?, 0) <= 0
                  THEN 'Unpaid'
                WHEN LEAST(
                  COALESCE(balance_amount, debit, 0) + ?,
                  COALESCE(debit, 0)
                ) > 0
                  THEN 'Partially Paid'
                ELSE 'Paid'
              END
          WHERE id = ?
          `,
          [
            oldAmount,
            oldAmount,
            oldAmount,
            oldAmount,
            oldItem.sourceId,
          ]
        );
      }
    }

    /*
     * STEP 4:
     * Recalculate invoice balances after old OR applications
     * have been removed.
     */
    for (const oldItem of oldApplications) {
      if (oldItem.sourceType === "INV") {
        await updateInvoicePaymentStatus(conn, oldItem.sourceId);
      }
    }

    /*
     * STEP 5:
     * Update the OR header.
     */
    await conn.execute(
      `UPDATE or_headers SET
         voucher_no = ?,
         customer_id = ?,
         customer_name = ?,
         transaction_date = ?,
         reference_no = ?,
         receipt_no = ?,
         description = ?,
         total_debit = ?,
         total_credit = ?,
         status = ?,
         payment_method = ?,
         bank_account_id = ?,
         check_no = ?,
         check_date = ?
       WHERE id = ?`,
      [
        voucherNo || "",
        customerId || null,
        customerName || "",
        transactionDate || null,
        referenceNo || "",
        receiptNo || "",
        description || "",
        Number(totalDebit) || 0,
        Number(totalCredit) || 0,
        status || "Draft",
        paymentMethod === "Check" ? "Check" : "Cash",
        bankAccountId || null,
        paymentMethod === "Check" ? checkNo || "" : "",
        paymentMethod === "Check" ? checkDate || null : null,
        id,
      ]
    );

    /*
     * STEP 6:
     * Replace the OR journal lines.
     */
    await conn.execute(
      `DELETE FROM or_lines
       WHERE or_id = ?`,
      [id]
    );

    for (const line of lines) {
      await conn.execute(
        `INSERT INTO or_lines (
           or_id,
           account_id,
           account_code,
           account_title,
           particulars,
           gen_ref,
           gen_name,
           debit,
           credit
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
        ]
      );
    }

    /*
     * STEP 7:
     * Save the edited invoice applications.
     */
    for (const appItem of invoiceApplications) {
      const sourceId =
        appItem.sourceId ??
        appItem.invoiceId ??
        null;

      const paymentAmount = Number(appItem.amount || 0);

      if (!sourceId || paymentAmount <= 0) {
        continue;
      }

      const sourceType =
        appItem.sourceType === "AR_BEGINNING"
          ? "AR_BEGINNING"
          : "INV";

      /*
       * Validate that the new payment does not exceed
       * the current outstanding balance.
       */
      if (sourceType === "INV") {
        const [invoiceRows] = await conn.execute(
          `SELECT
             COALESCE(balance_amount, total_debit, 0) AS balanceAmount
           FROM invoice_headers
           WHERE id = ?`,
          [sourceId]
        );

        if (invoiceRows.length === 0) {
          throw new Error(`Invoice ${sourceId} was not found.`);
        }

        const currentBalance = Number(
          invoiceRows[0].balanceAmount || 0
        );

        if (paymentAmount > currentBalance) {
          throw new Error(
            `Payment amount cannot exceed invoice balance of ${currentBalance.toFixed(
              2
            )}.`
          );
        }
      }

      if (sourceType === "AR_BEGINNING") {
        const [beginningRows] = await conn.execute(
          `SELECT
             COALESCE(balance_amount, debit, 0) AS balanceAmount
           FROM arap_beginning_balance_lines
           WHERE id = ?`,
          [sourceId]
        );

        if (beginningRows.length === 0) {
          throw new Error(
            `AR beginning balance ${sourceId} was not found.`
          );
        }

        const currentBalance = Number(
          beginningRows[0].balanceAmount || 0
        );

        if (paymentAmount > currentBalance) {
          throw new Error(
            `Payment amount cannot exceed AR beginning balance of ${currentBalance.toFixed(
              2
            )}.`
          );
        }
      }

      await conn.execute(
        `INSERT INTO transaction_applications (
           source_type,
           source_id,
           applied_type,
           applied_id,
           amount,
           application_date
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sourceType,
          sourceId,
          "OR",
          id,
          paymentAmount,
          appItem.applicationDate ||
            transactionDate ||
            new Date().toISOString().slice(0, 10),
        ]
      );

      if (sourceType === "AR_BEGINNING") {
        await conn.execute(
          `
          UPDATE arap_beginning_balance_lines
          SET paid_amount = COALESCE(paid_amount, 0) + ?,
              balance_amount = GREATEST(
                COALESCE(balance_amount, debit, 0) - ?,
                0
              ),
              status = CASE
                WHEN GREATEST(
                  COALESCE(balance_amount, debit, 0) - ?,
                  0
                ) <= 0
                  THEN 'Paid'
                ELSE 'Partially Paid'
              END
          WHERE id = ?
          `,
          [
            paymentAmount,
            paymentAmount,
            paymentAmount,
            sourceId,
          ]
        );
      } else {
        await updateInvoicePaymentStatus(conn, sourceId);
      }
    }

    await conn.commit();

    res.json({
      success: true,
      message: "Official Receipt updated successfully",
    });
  } catch (err) {
    await conn.rollback();

    console.error("UPDATE OR ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({
        message: "Official Receipt number already exists",
      });
    }

    res.status(500).json({
      message: err.message || "Failed to update Official Receipt",
    });
  } finally {
    conn.release();
  }
});

// ===================== APV API =====================

app.get("/api/apv", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        voucher_no AS voucherNo,
        supplier_id AS supplierId,
        supplier_name AS supplierName,
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
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM apv_headers
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET APV ERROR:", err);
    res.status(500).json({ message: "Failed to load APV records" });
  }
});

app.get("/api/apv/unpaid", async (req, res) => {
  try {
    const { supplierId, supplierName } = req.query;

    const params = [];
    let supplierFilterApv = "";
    let supplierFilterBb = "";

    if (supplierId) {
      supplierFilterApv = " AND supplier_id = ? ";
      supplierFilterBb = " AND l.party_id = ? ";
      params.push(supplierId, supplierId);
    } else if (supplierName) {
      supplierFilterApv = " AND TRIM(LOWER(supplier_name)) = TRIM(LOWER(?)) ";
      supplierFilterBb = " AND TRIM(LOWER(l.party_name)) = TRIM(LOWER(?)) ";
      params.push(supplierName, supplierName);
    }

    const [rows] = await pool.execute(
      `
      SELECT
        id,
        'APV' AS sourceType,
        voucher_no AS voucherNo,
        supplier_id AS supplierId,
        supplier_name AS supplierName,
        total_credit AS totalAmount,
        COALESCE(paid_amount, 0) AS paidAmount,
        COALESCE(balance_amount, total_credit, 0) AS balanceAmount
      FROM apv_headers
      WHERE COALESCE(balance_amount, total_credit, 0) > 0
        AND COALESCE(payment_status, 'Unpaid') != 'Paid'
        ${supplierFilterApv}

      UNION ALL

      SELECT
        l.id,
        'AP_BEGINNING' AS sourceType,
        l.reference_no AS voucherNo,
        l.party_id AS supplierId,
        l.party_name AS supplierName,
        l.credit AS totalAmount,
        COALESCE(l.paid_amount, 0) AS paidAmount,
        COALESCE(l.balance_amount, l.credit, 0) AS balanceAmount
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
      WHERE h.balance_type = 'AP'
        AND COALESCE(l.balance_amount, l.credit, 0) > 0
        AND COALESCE(l.status, 'Unpaid') != 'Paid'
        ${supplierFilterBb}

      ORDER BY voucherNo DESC
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("GET UNPAID APV/AP BEGINNING ERROR:", err);
    res.status(500).json({ message: "Failed to load outstanding payables" });
  }
});

app.get("/api/apv/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [headers] = await pool.execute(
      `SELECT
        id,
        voucher_no AS voucherNo,
        supplier_id AS supplierId,
        supplier_name AS supplierName,
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
        status,
        source_po_id AS sourcePoId,
        atc_code AS atcCode,
        tax_type AS taxType,
        tax_rate AS taxRate,
        tax_withheld_amount AS taxWithheldAmount,
        payee_tin AS payeeTin,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM apv_headers
      WHERE id = ?`,
      [id]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "APV not found" });
    }

    const [lines] = await pool.execute(
      `SELECT
        id,
        apv_id AS apvId,
        account_id AS accountId,
        account_code AS accountCode,
        account_title AS accountTitle,
        particulars,
        debit,
        credit,
        gen_ref AS genRef,
        gen_name AS genName
      FROM apv_lines
      WHERE apv_id = ?
      ORDER BY id ASC`,
      [id]
    );

    const [applications] = await pool.execute(
      `SELECT
        id,
        source_type AS sourceType,
        source_id AS sourceId,
        applied_type AS appliedType,
        applied_id AS appliedId,
        amount,
        DATE_FORMAT(application_date, '%Y-%m-%d') AS applicationDate,
        created_at AS createdAt
      FROM transaction_applications
      WHERE source_type = 'APV'
        AND source_id = ?
      ORDER BY id DESC`,
      [id]
    );

    res.json({
      ...headers[0],
      lines,
      applications,
    });
  } catch (err) {
    console.error("GET APV DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load APV details" });
  }
});

app.post("/api/apv", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      voucherNo,
      supplierId,
      supplierName,
      transactionDate,
      dueDate,
      referenceNo,
      description,
      remarks,
      totalDebit,
      totalCredit,
      status,
      lines,
      sourcePoId,
      atcCode,
      taxType,
      taxRate,
      taxWithheldAmount,
      payeeTin,
    } = req.body;

    await conn.beginTransaction();

    const total = Number(totalCredit || 0);

    const [result] = await conn.execute(
      `INSERT INTO apv_headers (
        voucher_no,
        supplier_id,
        supplier_name,
        transaction_date,
        due_date,
        reference_no,
        description,
        remarks,
        total_debit,
        total_credit,
        paid_amount,
        balance_amount,
        payment_status,
        status,
        source_po_id,
        atc_code,
        tax_type,
        tax_rate,
        tax_withheld_amount,
        payee_tin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        voucherNo,
        supplierId || null,
        supplierName || "",
        transactionDate || null,
        dueDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        totalDebit || 0,
        total,
        0,
        total,
        "Unpaid",
        status || "DRAFT",
        sourcePoId || null,
        atcCode || null,
        taxType || null,
        taxRate || null,
        taxWithheldAmount || null,
        payeeTin || null,
      ]
    );

    const apvId = result.insertId;

    if (sourcePoId) {
      await conn.execute(
        "UPDATE purchase_order_headers SET status = 'Converted' WHERE id = ?",
        [sourcePoId]
      );
    }

    for (const line of lines || []) {
      await conn.execute(
        `INSERT INTO apv_lines (
          apv_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          apvId,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
          line.genRef || "",
          line.genName || "",
        ]
      );
    }

    await conn.commit();

    res.json({
      success: true,
      message: "APV saved successfully",
      id: apvId,
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE APV ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "APV voucher number already exists" });
    }

    res.status(500).json({ message: "Failed to save APV" });
  } finally {
    conn.release();
  }
});

app.put("/api/apv/:id", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const {
      voucherNo,
      supplierId,
      supplierName,
      transactionDate,
      dueDate,
      referenceNo,
      description,
      remarks,
      totalDebit,
      totalCredit,
      status,
      lines,
      atcCode,
      taxType,
      taxRate,
      taxWithheldAmount,
      payeeTin,
    } = req.body;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE apv_headers SET
        voucher_no = ?,
        supplier_id = ?,
        supplier_name = ?,
        transaction_date = ?,
        due_date = ?,
        reference_no = ?,
        description = ?,
        remarks = ?,
        total_debit = ?,
        total_credit = ?,
        status = ?,
        atc_code = ?,
        tax_type = ?,
        tax_rate = ?,
        tax_withheld_amount = ?,
        payee_tin = ?
      WHERE id = ?`,
      [
        voucherNo,
        supplierId || null,
        supplierName || "",
        transactionDate || null,
        dueDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        totalDebit || 0,
        totalCredit || 0,
        status || "DRAFT",
        atcCode || null,
        taxType || null,
        taxRate || null,
        taxWithheldAmount || null,
        payeeTin || null,
        id,
      ]
    );

    await conn.execute("DELETE FROM apv_lines WHERE apv_id = ?", [id]);

    for (const line of lines || []) {
      await conn.execute(
        `INSERT INTO apv_lines (
          apv_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
          line.genRef || "",
          line.genName || "",
        ]
      );
    }

    await updateApvPaymentStatus(conn, id);

    await conn.commit();

    res.json({
      success: true,
      message: "APV updated successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE APV ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "APV voucher number already exists" });
    }

    res.status(500).json({ message: "Failed to update APV" });
  } finally {
    conn.release();
  }
});

app.delete("/api/apv/:id", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    await conn.beginTransaction();

    await conn.execute(
      `DELETE FROM transaction_applications
       WHERE source_type = 'APV'
         AND source_id = ?`,
      [id]
    );

    await conn.execute("DELETE FROM apv_headers WHERE id = ?", [id]);

    await conn.commit();

    res.json({
      success: true,
      message: "APV deleted successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("DELETE APV ERROR:", err);
    res.status(500).json({ message: "Failed to delete APV" });
  } finally {
    conn.release();
  }
});

// ===================== PURCHASE ORDER API =====================

app.get("/api/purchase-orders", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        voucher_no AS voucherNo,
        supplier_id AS supplierId,
        supplier_name AS supplierName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        description,
        remarks,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM purchase_order_headers
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET PURCHASE ORDER ERROR:", err);
    res.status(500).json({ message: "Failed to load Purchase Order records" });
  }
});

app.get("/api/purchase-orders/open", async (req, res) => {
  try {
    const { supplierId, supplierName } = req.query;

    const params = [];
    let filter = "";

    if (supplierId) {
      filter = " AND supplier_id = ? ";
      params.push(supplierId);
    } else if (supplierName) {
      filter = " AND TRIM(LOWER(supplier_name)) = TRIM(LOWER(?)) ";
      params.push(supplierName);
    }

    const [rows] = await pool.execute(
      `
      SELECT
        id,
        voucher_no AS voucherNo,
        supplier_id AS supplierId,
        supplier_name AS supplierName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        description,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status
      FROM purchase_order_headers
      WHERE status = 'Open'
        ${filter}
      ORDER BY id DESC
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("GET OPEN PURCHASE ORDERS ERROR:", err);
    res.status(500).json({ message: "Failed to load open Purchase Orders" });
  }
});

app.get("/api/purchase-orders/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [headers] = await pool.execute(
      `SELECT
        id,
        voucher_no AS voucherNo,
        supplier_id AS supplierId,
        supplier_name AS supplierName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        description,
        remarks,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM purchase_order_headers
      WHERE id = ?`,
      [id]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "Purchase Order not found" });
    }

    const [lines] = await pool.execute(
      `SELECT
        id,
        po_id AS poId,
        account_id AS accountId,
        account_code AS accountCode,
        account_title AS accountTitle,
        particulars,
        debit,
        credit,
        gen_ref AS genRef,
        gen_name AS genName
      FROM purchase_order_lines
      WHERE po_id = ?
      ORDER BY id ASC`,
      [id]
    );

    res.json({
      ...headers[0],
      lines,
    });
  } catch (err) {
    console.error("GET PURCHASE ORDER DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load Purchase Order details" });
  }
});

app.post("/api/purchase-orders", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      voucherNo,
      supplierId,
      supplierName,
      transactionDate,
      referenceNo,
      description,
      remarks,
      totalDebit,
      totalCredit,
      status,
      lines,
    } = req.body;

    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO purchase_order_headers (
        voucher_no,
        supplier_id,
        supplier_name,
        transaction_date,
        reference_no,
        description,
        remarks,
        total_debit,
        total_credit,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        voucherNo,
        supplierId || null,
        supplierName || "",
        transactionDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        totalDebit || 0,
        totalCredit || 0,
        status === "Draft" ? "Draft" : "Open",
      ]
    );

    const poId = result.insertId;

    for (const line of lines || []) {
      await conn.execute(
        `INSERT INTO purchase_order_lines (
          po_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          poId,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
          line.genRef || "",
          line.genName || "",
        ]
      );
    }

    await conn.commit();

    res.json({
      success: true,
      message: "Purchase Order saved successfully",
      id: poId,
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE PURCHASE ORDER ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Purchase Order number already exists" });
    }

    res.status(500).json({ message: "Failed to save Purchase Order" });
  } finally {
    conn.release();
  }
});

app.put("/api/purchase-orders/:id", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const {
      voucherNo,
      supplierId,
      supplierName,
      transactionDate,
      referenceNo,
      description,
      remarks,
      totalDebit,
      totalCredit,
      status,
      lines,
    } = req.body;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE purchase_order_headers SET
        voucher_no = ?,
        supplier_id = ?,
        supplier_name = ?,
        transaction_date = ?,
        reference_no = ?,
        description = ?,
        remarks = ?,
        total_debit = ?,
        total_credit = ?,
        status = ?
      WHERE id = ?`,
      [
        voucherNo,
        supplierId || null,
        supplierName || "",
        transactionDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        totalDebit || 0,
        totalCredit || 0,
        status || "Open",
        id,
      ]
    );

    await conn.execute("DELETE FROM purchase_order_lines WHERE po_id = ?", [id]);

    for (const line of lines || []) {
      await conn.execute(
        `INSERT INTO purchase_order_lines (
          po_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
          line.genRef || "",
          line.genName || "",
        ]
      );
    }

    await conn.commit();

    res.json({
      success: true,
      message: "Purchase Order updated successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE PURCHASE ORDER ERROR:", err);
    res.status(500).json({ message: "Failed to update Purchase Order" });
  } finally {
    conn.release();
  }
});

app.delete("/api/purchase-orders/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute("DELETE FROM purchase_order_headers WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Purchase Order deleted successfully",
    });
  } catch (err) {
    console.error("DELETE PURCHASE ORDER ERROR:", err);
    res.status(500).json({ message: "Failed to delete Purchase Order" });
  }
});

// ===================== QUOTATION API =====================

async function generateQuotationNo(conn) {
  const yy = String(new Date().getFullYear()).slice(-2);
  const prefix = `SQ${yy}-`;

  const [rows] = await conn.execute(
    `SELECT quotation_no FROM quotation_headers WHERE quotation_no LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );

  let seq = 1;
  if (rows.length > 0) {
    const match = rows[0].quotation_no.match(/-(\d+)$/);
    if (match) seq = parseInt(match[1], 10) + 1;
  }

  return `${prefix}${String(seq).padStart(5, "0")}`;
}

app.get("/api/quotations", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        quotation_no AS quotationNo,
        customer_id AS customerId,
        customer_name AS customerName,
        customer_address AS customerAddress,
        contact_name AS contactName,
        DATE_FORMAT(quotation_date, '%Y-%m-%d') AS quotationDate,
        DATE_FORMAT(expiration_date, '%Y-%m-%d') AS expirationDate,
        status,
        notes,
        total_amount AS totalAmount,
        converted_invoice_id AS convertedInvoiceId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM quotation_headers
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET QUOTATIONS ERROR:", err);
    res.status(500).json({ message: "Failed to load Quotations" });
  }
});

app.get("/api/quotations/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [headers] = await pool.execute(
      `SELECT
        id,
        quotation_no AS quotationNo,
        customer_id AS customerId,
        customer_name AS customerName,
        customer_address AS customerAddress,
        contact_name AS contactName,
        DATE_FORMAT(quotation_date, '%Y-%m-%d') AS quotationDate,
        DATE_FORMAT(expiration_date, '%Y-%m-%d') AS expirationDate,
        status,
        notes,
        total_amount AS totalAmount,
        converted_invoice_id AS convertedInvoiceId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM quotation_headers
      WHERE id = ?`,
      [id]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "Quotation not found" });
    }

    const [lines] = await pool.execute(
      `SELECT
        id,
        quotation_id AS quotationId,
        sort_order AS sortOrder,
        line_type AS lineType,
        description,
        notes,
        quantity,
        unit_label AS unitLabel,
        unit_price AS unitPrice,
        tax_rate AS taxRate,
        amount,
        account_id AS accountId,
        account_code AS accountCode,
        account_title AS accountTitle
      FROM quotation_lines
      WHERE quotation_id = ?
      ORDER BY sort_order ASC, id ASC`,
      [id]
    );

    res.json({
      ...headers[0],
      lines,
    });
  } catch (err) {
    console.error("GET QUOTATION DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load Quotation details" });
  }
});

app.post("/api/quotations", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      customerId,
      customerName,
      customerAddress,
      contactName,
      quotationDate,
      expirationDate,
      status,
      notes,
      totalAmount,
      lines,
    } = req.body;

    await conn.beginTransaction();

    const quotationNo = await generateQuotationNo(conn);

    const [result] = await conn.execute(
      `INSERT INTO quotation_headers (
        quotation_no,
        customer_id,
        customer_name,
        customer_address,
        contact_name,
        quotation_date,
        expiration_date,
        status,
        notes,
        total_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quotationNo,
        customerId || null,
        customerName || "",
        customerAddress || "",
        contactName || "",
        quotationDate || null,
        expirationDate || null,
        status === "Sent" ? "Sent" : "Draft",
        notes || "",
        totalAmount || 0,
      ]
    );

    const quotationId = result.insertId;

    let sortOrder = 0;
    for (const line of lines || []) {
      await conn.execute(
        `INSERT INTO quotation_lines (
          quotation_id,
          sort_order,
          line_type,
          description,
          notes,
          quantity,
          unit_label,
          unit_price,
          tax_rate,
          amount,
          account_id,
          account_code,
          account_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          quotationId,
          sortOrder++,
          line.lineType === "section" ? "section" : "item",
          line.description || "",
          line.notes || "",
          Number(line.quantity) || 0,
          line.unitLabel || "Units",
          Number(line.unitPrice) || 0,
          Number(line.taxRate) || 0,
          Number(line.amount) || 0,
          line.accountId || null,
          line.accountCode || null,
          line.accountTitle || null,
        ]
      );
    }

    await conn.commit();

    res.json({
      success: true,
      message: "Quotation saved successfully",
      id: quotationId,
      quotationNo,
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE QUOTATION ERROR:", err);
    res.status(500).json({ message: "Failed to save Quotation" });
  } finally {
    conn.release();
  }
});

app.put("/api/quotations/:id", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [existing] = await conn.execute(
      "SELECT status FROM quotation_headers WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "Quotation not found" });
    }

    if (existing[0].status === "Converted") {
      return res.status(400).json({
        message: "This Quotation has already been converted to an Invoice and can no longer be edited.",
      });
    }

    const {
      customerId,
      customerName,
      customerAddress,
      contactName,
      quotationDate,
      expirationDate,
      status,
      notes,
      totalAmount,
      lines,
    } = req.body;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE quotation_headers SET
        customer_id = ?,
        customer_name = ?,
        customer_address = ?,
        contact_name = ?,
        quotation_date = ?,
        expiration_date = ?,
        status = ?,
        notes = ?,
        total_amount = ?
      WHERE id = ?`,
      [
        customerId || null,
        customerName || "",
        customerAddress || "",
        contactName || "",
        quotationDate || null,
        expirationDate || null,
        status || "Draft",
        notes || "",
        totalAmount || 0,
        id,
      ]
    );

    await conn.execute("DELETE FROM quotation_lines WHERE quotation_id = ?", [id]);

    let sortOrder = 0;
    for (const line of lines || []) {
      await conn.execute(
        `INSERT INTO quotation_lines (
          quotation_id,
          sort_order,
          line_type,
          description,
          notes,
          quantity,
          unit_label,
          unit_price,
          tax_rate,
          amount,
          account_id,
          account_code,
          account_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          sortOrder++,
          line.lineType === "section" ? "section" : "item",
          line.description || "",
          line.notes || "",
          Number(line.quantity) || 0,
          line.unitLabel || "Units",
          Number(line.unitPrice) || 0,
          Number(line.taxRate) || 0,
          Number(line.amount) || 0,
          line.accountId || null,
          line.accountCode || null,
          line.accountTitle || null,
        ]
      );
    }

    await conn.commit();

    res.json({
      success: true,
      message: "Quotation updated successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE QUOTATION ERROR:", err);
    res.status(500).json({ message: "Failed to update Quotation" });
  } finally {
    conn.release();
  }
});

app.delete("/api/quotations/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute("DELETE FROM quotation_headers WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Quotation deleted successfully",
    });
  } catch (err) {
    console.error("DELETE QUOTATION ERROR:", err);
    res.status(500).json({ message: "Failed to delete Quotation" });
  }
});

app.post("/api/quotations/:id/convert-to-invoice", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    await conn.beginTransaction();

    const [headers] = await conn.execute(
      "SELECT * FROM quotation_headers WHERE id = ?",
      [id]
    );

    if (headers.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Quotation not found" });
    }

    const quotation = headers[0];

    if (quotation.status === "Converted") {
      await conn.rollback();
      return res.status(400).json({
        message: "This Quotation has already been converted to an Invoice.",
      });
    }

    const [arAccounts] = await conn.execute(
      `SELECT id, code, title FROM chart_of_accounts WHERE LOWER(title) LIKE '%receivable%' LIMIT 1`
    );

    if (arAccounts.length === 0) {
      await conn.rollback();
      return res.status(400).json({
        message: "Could not find an Accounts Receivable account in the Chart of Accounts. Please add one first.",
      });
    }

    const ar = arAccounts[0];

    const [itemLines] = await conn.execute(
      `SELECT account_id AS accountId, account_code AS accountCode, account_title AS accountTitle,
              amount, tax_rate AS taxRate
       FROM quotation_lines
       WHERE quotation_id = ? AND line_type = 'item'`,
      [id]
    );

    // Lines without an account picked fall back to an auto-detected Sales/Revenue
    // account, same as the original behavior before per-line accounts existed.
    let fallbackAccount = null;
    if (itemLines.some((line) => !line.accountId)) {
      const [salesAccounts] = await conn.execute(
        `SELECT id, code, title FROM chart_of_accounts
         WHERE LOWER(title) LIKE '%sales%' OR LOWER(title) LIKE '%revenue%' LIMIT 1`
      );

      if (salesAccounts.length === 0) {
        await conn.rollback();
        return res.status(400).json({
          message:
            "Some line items have no account selected, and no Sales/Revenue account could be found as a fallback. Please pick an account for each line item.",
        });
      }

      fallbackAccount = salesAccounts[0];
    }

    // Group item lines by account, summing tax-exclusive amounts per account.
    const groups = new Map();
    let taxTotal = 0;

    for (const line of itemLines) {
      const lineAmount = Number(line.amount) || 0;
      const lineTax = lineAmount * ((Number(line.taxRate) || 0) / 100);
      taxTotal += lineTax;

      const account = line.accountId
        ? { id: line.accountId, code: line.accountCode, title: line.accountTitle }
        : fallbackAccount;

      const key = account.id;
      const existing = groups.get(key);
      if (existing) {
        existing.amount += lineAmount;
      } else {
        groups.set(key, { account, amount: lineAmount });
      }
    }

    let vatAccount = null;
    if (taxTotal > 0.004) {
      const [vatAccounts] = await conn.execute(
        `SELECT id, code, title FROM chart_of_accounts WHERE LOWER(title) LIKE '%output vat%' LIMIT 1`
      );
      if (vatAccounts.length > 0) vatAccount = vatAccounts[0];
    }

    const subtotal = Array.from(groups.values()).reduce((sum, g) => sum + g.amount, 0);
    const total = vatAccount ? subtotal + taxTotal : Number(quotation.total_amount) || subtotal + taxTotal;
    const voucherNo = `INV-${quotation.quotation_no}`;

    const [result] = await conn.execute(
      `INSERT INTO invoice_headers (
        voucher_no,
        customer_id,
        customer_name,
        transaction_date,
        reference_no,
        description,
        total_debit,
        total_credit,
        balance_amount,
        payment_status,
        status,
        source_quotation_id
      ) VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, 'Unpaid', 'Draft', ?)`,
      [
        voucherNo,
        quotation.customer_id || null,
        quotation.customer_name,
        quotation.quotation_no,
        `Converted from Quotation ${quotation.quotation_no}`,
        total,
        total,
        total,
        quotation.id,
      ]
    );

    const invoiceId = result.insertId;

    await conn.execute(
      `INSERT INTO invoice_lines (
        invoice_id, account_id, account_code, account_title, particulars, debit, credit, gen_ref, gen_name
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        invoiceId,
        ar.id,
        ar.code,
        ar.title,
        "Accounts Receivable",
        total,
        quotation.customer_id ? String(quotation.customer_id) : "",
        quotation.customer_name,
      ]
    );

    for (const { account, amount } of groups.values()) {
      // If there's tax but no Output VAT account exists, fold it into the revenue
      // lines proportionally so the entry still balances to the quotation total.
      const creditAmount =
        !vatAccount && taxTotal > 0.004 ? amount + (amount / subtotal) * taxTotal : amount;

      await conn.execute(
        `INSERT INTO invoice_lines (
          invoice_id, account_id, account_code, account_title, particulars, debit, credit, gen_ref, gen_name
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [invoiceId, account.id, account.code, account.title, account.title, creditAmount, "", ""]
      );
    }

    if (vatAccount) {
      await conn.execute(
        `INSERT INTO invoice_lines (
          invoice_id, account_id, account_code, account_title, particulars, debit, credit, gen_ref, gen_name
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [invoiceId, vatAccount.id, vatAccount.code, vatAccount.title, "Output VAT", taxTotal, "", ""]
      );
    }

    await conn.execute(
      "UPDATE quotation_headers SET status = 'Converted', converted_invoice_id = ? WHERE id = ?",
      [invoiceId, id]
    );

    await conn.commit();

    res.json({
      success: true,
      message: "Quotation converted to Invoice successfully",
      invoiceId,
      voucherNo,
    });
  } catch (err) {
    await conn.rollback();
    console.error("CONVERT QUOTATION TO INVOICE ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "An invoice with this reference already exists" });
    }

    res.status(500).json({ message: "Failed to convert Quotation to Invoice" });
  } finally {
    conn.release();
  }
});

// ===================== POSTING API =====================

app.get("/api/posting/pending", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT 'INV' AS sourceType, id, voucher_no AS voucherNo, customer_name AS party,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate, total_debit AS amount, status
      FROM invoice_headers WHERE UPPER(status) = 'DRAFT'

      UNION ALL

      SELECT 'OR' AS sourceType, id, voucher_no AS voucherNo, customer_name AS party,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate, total_debit AS amount, status
      FROM or_headers WHERE UPPER(status) = 'DRAFT'

      UNION ALL

      SELECT 'APV' AS sourceType, id, voucher_no AS voucherNo, supplier_name AS party,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate, total_credit AS amount, status
      FROM apv_headers WHERE UPPER(status) = 'DRAFT'

      UNION ALL

      SELECT 'CV' AS sourceType, id, voucher_no AS voucherNo, payee_name AS party,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate, total_credit AS amount, status
      FROM cv_headers WHERE UPPER(status) = 'DRAFT'

      UNION ALL

      SELECT 'PO' AS sourceType, id, voucher_no AS voucherNo, supplier_name AS party,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate, total_credit AS amount, status
      FROM purchase_order_headers WHERE UPPER(status) = 'DRAFT'

      ORDER BY transactionDate DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET PENDING POSTING ERROR:", err);
    res.status(500).json({ message: "Failed to load pending transactions" });
  }
});

const AR_POST_TARGETS = [
  { table: "invoice_headers", status: "Posted" },
  { table: "or_headers", status: "Posted" },
];

const AP_POST_TARGETS = [
  { table: "apv_headers", status: "Posted" },
  { table: "cv_headers", status: "Posted" },
  { table: "purchase_order_headers", status: "Open" },
];

app.post("/api/posting/post", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { scope } = req.body;

    const targets =
      scope === "ar"
        ? AR_POST_TARGETS
        : scope === "ap"
        ? AP_POST_TARGETS
        : [...AR_POST_TARGETS, ...AP_POST_TARGETS];

    await conn.beginTransaction();

    let postedCount = 0;

    for (const target of targets) {
      const [result] = await conn.execute(
        `UPDATE ${target.table} SET status = ? WHERE UPPER(status) = 'DRAFT'`,
        [target.status]
      );

      postedCount += result.affectedRows;
    }

    await conn.commit();

    res.json({
      success: true,
      message: `${postedCount} transaction(s) posted successfully`,
      postedCount,
    });
  } catch (err) {
    await conn.rollback();
    console.error("BULK POSTING ERROR:", err);
    res.status(500).json({ message: "Failed to post transactions" });
  } finally {
    conn.release();
  }
});

// ===================== PAYMENT APPLICATION API =====================

app.post("/api/apply-payment", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      sourceType,
      sourceId,
      appliedType,
      appliedId,
      amount,
      applicationDate,
    } = req.body;

    if (!sourceType || !sourceId || !appliedType || !appliedId || !amount) {
      return res.status(400).json({
        message: "Missing payment application data",
      });
    }

    if (sourceType !== "APV") {
      return res.status(400).json({
        message: "Only APV payment application is available right now.",
      });
    }

    await conn.beginTransaction();

    const [apvRows] = await conn.execute(
      `SELECT
        id,
        total_credit AS totalAmount,
        COALESCE(paid_amount, 0) AS paidAmount,
        COALESCE(balance_amount, total_credit) AS balanceAmount
      FROM apv_headers
      WHERE id = ?`,
      [sourceId]
    );

    if (apvRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "APV not found." });
    }

    const balanceAmount = Number(apvRows[0].balanceAmount || 0);
    const paymentAmount = Number(amount || 0);

    if (paymentAmount <= 0) {
      await conn.rollback();
      return res.status(400).json({ message: "Payment amount must be greater than zero." });
    }

    if (paymentAmount > balanceAmount) {
      await conn.rollback();
      return res.status(400).json({
        message: `Payment amount cannot exceed APV balance of ${balanceAmount.toFixed(2)}.`,
      });
    }

    await conn.execute(
      `INSERT INTO transaction_applications
       (source_type, source_id, applied_type, applied_id, amount, application_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "APV",
        sourceId,
        appliedType,
        appliedId,
        paymentAmount,
        applicationDate || new Date().toISOString().split("T")[0],
      ]
    );

    await updateApvPaymentStatus(conn, sourceId);

    await conn.commit();

    res.json({
      success: true,
      message: "Payment applied to APV successfully.",
    });
  } catch (err) {
    await conn.rollback();
    console.error("APPLY PAYMENT ERROR:", err);
    res.status(500).json({ message: "Failed to apply payment." });
  } finally {
    conn.release();
  }
});

// ===================== CV API =====================

app.get("/api/cv", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        voucher_no AS voucherNo,
        payee_id AS payeeId,
        payee_name AS payeeName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        check_no AS checkNo,
        description,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status,
        payment_method AS paymentMethod,
        bank_account_id AS bankAccountId,
        DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate
      FROM cv_headers
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET CV ERROR:", err);
    res.status(500).json({ message: "Failed to load CV records" });
  }
});

app.post("/api/cv", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const {
      voucherNo,
      payeeId,
      payeeName,
      transactionDate,
      referenceNo,
      checkNo,
      description,
      totalDebit,
      totalCredit,
      status,
      paymentMethod,
      bankAccountId,
      checkDate,
      lines = [],
      apvApplications = [],
    } = req.body;

    const finalPayeeId = payeeId ?? req.body.supplierId ?? null;
    const finalPayeeName = payeeName || req.body.supplierName || "";

    const [result] = await conn.execute(
      `INSERT INTO cv_headers(
        voucher_no,
        payee_id,
        payee_name,
        transaction_date,
        reference_no,
        check_no,
        description,
        total_debit,
        total_credit,
        status,
        payment_method,
        bank_account_id,
        check_date
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        voucherNo || "",
        finalPayeeId,
        finalPayeeName,
        transactionDate || null,
        referenceNo || "",
        checkNo || "",
        description || "",
        Number(totalDebit) || 0,
        Number(totalCredit) || 0,
        status || "Draft",
        paymentMethod === "Cash" ? "Cash" : "Check",
        bankAccountId || null,
        paymentMethod !== "Cash" ? checkDate || null : null,
      ]
    );

    const cvId = result.insertId;

    for (const line of lines) {
      await conn.execute(
        `INSERT INTO cv_lines(
          cv_id,
          account_id,
          account_code,
          account_title,
          particulars,
          gen_ref,
          gen_name,
          debit,
          credit
        )
        VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          cvId,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
        ]
      );
    }

    for (const appItem of apvApplications) {
      const sourceId = appItem.sourceId ?? appItem.apvId ?? null;
      const paymentAmount = Number(appItem.amount || 0);

      if (!sourceId || paymentAmount <= 0) continue;

      await conn.execute(
        `INSERT INTO transaction_applications
         (source_type, source_id, applied_type, applied_id, amount, application_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "APV",
          sourceId,
          "CV",
          cvId,
          paymentAmount,
          appItem.applicationDate || transactionDate || null,
        ]
      );

      if (appItem.sourceType === "AP_BEGINNING") {
  await conn.execute(
    `
    UPDATE arap_beginning_balance_lines
    SET paid_amount = COALESCE(paid_amount, 0) + ?,
        balance_amount = GREATEST(COALESCE(balance_amount, credit, 0) - ?, 0),
        status = CASE
          WHEN GREATEST(COALESCE(balance_amount, credit, 0) - ?, 0) <= 0 THEN 'Paid'
          ELSE 'Partially Paid'
        END
    WHERE id = ?
    `,
    [paymentAmount, paymentAmount, paymentAmount, sourceId]
  );
} else {
  await updateApvPaymentStatus(conn, sourceId);
}
    }

    await conn.commit();

    res.json({
      success: true,
      id: cvId,
      message: "CV saved successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE CV ERROR:", err);

    res.status(500).json({
      message: "Failed to save CV",
    });
  } finally {
    conn.release();
  }
});

app.get("/api/cv/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [headers] = await pool.execute(
      `SELECT
        id,
        voucher_no AS voucherNo,
        payee_id AS payeeId,
        payee_name AS payeeName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        check_no AS checkNo,
        description,
        remarks,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status,
        payment_method AS paymentMethod,
        bank_account_id AS bankAccountId,
        DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate
      FROM cv_headers
      WHERE id = ?`,
      [id]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "CV not found" });
    }

    const [lines] = await pool.execute(
      `SELECT
        id,
        cv_id AS cvId,
        account_id AS accountId,
        account_code AS accountCode,
        account_title AS accountTitle,
        particulars,
        debit,
        credit,
        gen_ref AS genRef,
        gen_name AS genName
      FROM cv_lines
      WHERE cv_id = ?
      ORDER BY id ASC`,
      [id]
    );

    const [applications] = await pool.execute(
      `SELECT
        id,
        source_type AS sourceType,
        source_id AS sourceId,
        applied_type AS appliedType,
        applied_id AS appliedId,
        amount,
        DATE_FORMAT(application_date, '%Y-%m-%d') AS applicationDate
      FROM transaction_applications
      WHERE applied_type = 'CV'
        AND applied_id = ?
      ORDER BY id DESC`,
      [id]
    );

    res.json({
      ...headers[0],
      lines,
      applications,
    });
  } catch (err) {
    console.error("GET CV DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load CV details" });
  }
});

app.put("/api/cv/:id", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const {
      voucherNo,
      payeeId,
      payeeName,
      transactionDate,
      referenceNo,
      checkNo,
      description,
      totalDebit,
      totalCredit,
      status,
      paymentMethod,
      bankAccountId,
      checkDate,
      lines = [],
      apvApplications = [],
    } = req.body;

    const finalPayeeId = payeeId ?? req.body.supplierId ?? null;
    const finalPayeeName = payeeName || req.body.supplierName || "";

    await conn.beginTransaction();

    // Reverse the payment effects of this CV's previous applications before
    // the edited ones are saved, mirroring the OR PUT handler's approach.
    const [oldApplications] = await conn.execute(
      `SELECT
         source_type AS sourceType,
         source_id AS sourceId,
         amount
       FROM transaction_applications
       WHERE applied_type = 'CV'
         AND applied_id = ?`,
      [id]
    );

    await conn.execute(
      `DELETE FROM transaction_applications
       WHERE applied_type = 'CV'
         AND applied_id = ?`,
      [id]
    );

    for (const oldItem of oldApplications) {
      const oldAmount = Number(oldItem.amount || 0);

      if (oldItem.sourceType === "AP_BEGINNING") {
        await conn.execute(
          `
          UPDATE arap_beginning_balance_lines
          SET paid_amount = GREATEST(COALESCE(paid_amount, 0) - ?, 0),
              balance_amount = LEAST(COALESCE(balance_amount, credit, 0) + ?, COALESCE(credit, 0)),
              status = CASE
                WHEN GREATEST(COALESCE(paid_amount, 0) - ?, 0) <= 0 THEN 'Unpaid'
                WHEN LEAST(COALESCE(balance_amount, credit, 0) + ?, COALESCE(credit, 0)) > 0 THEN 'Partially Paid'
                ELSE 'Paid'
              END
          WHERE id = ?
          `,
          [oldAmount, oldAmount, oldAmount, oldAmount, oldItem.sourceId]
        );
      }
    }

    for (const oldItem of oldApplications) {
      if (oldItem.sourceType === "APV") {
        await updateApvPaymentStatus(conn, oldItem.sourceId);
      }
    }

    await conn.execute(
      `UPDATE cv_headers SET
         voucher_no = ?,
         payee_id = ?,
         payee_name = ?,
         transaction_date = ?,
         reference_no = ?,
         check_no = ?,
         description = ?,
         total_debit = ?,
         total_credit = ?,
         status = ?,
         payment_method = ?,
         bank_account_id = ?,
         check_date = ?
       WHERE id = ?`,
      [
        voucherNo || "",
        finalPayeeId,
        finalPayeeName,
        transactionDate || null,
        referenceNo || "",
        checkNo || "",
        description || "",
        Number(totalDebit) || 0,
        Number(totalCredit) || 0,
        status || "Draft",
        paymentMethod === "Cash" ? "Cash" : "Check",
        bankAccountId || null,
        paymentMethod !== "Cash" ? checkDate || null : null,
        id,
      ]
    );

    await conn.execute("DELETE FROM cv_lines WHERE cv_id = ?", [id]);

    for (const line of lines) {
      await conn.execute(
        `INSERT INTO cv_lines(
          cv_id,
          account_id,
          account_code,
          account_title,
          particulars,
          gen_ref,
          gen_name,
          debit,
          credit
        )
        VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          id,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
        ]
      );
    }

    for (const appItem of apvApplications) {
      const sourceId = appItem.sourceId ?? appItem.apvId ?? null;
      const paymentAmount = Number(appItem.amount || 0);

      if (!sourceId || paymentAmount <= 0) continue;

      const sourceType = appItem.sourceType === "AP_BEGINNING" ? "AP_BEGINNING" : "APV";

      await conn.execute(
        `INSERT INTO transaction_applications
         (source_type, source_id, applied_type, applied_id, amount, application_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sourceType,
          sourceId,
          "CV",
          id,
          paymentAmount,
          appItem.applicationDate || transactionDate || null,
        ]
      );

      if (sourceType === "AP_BEGINNING") {
        await conn.execute(
          `
          UPDATE arap_beginning_balance_lines
          SET paid_amount = COALESCE(paid_amount, 0) + ?,
              balance_amount = GREATEST(COALESCE(balance_amount, credit, 0) - ?, 0),
              status = CASE
                WHEN GREATEST(COALESCE(balance_amount, credit, 0) - ?, 0) <= 0 THEN 'Paid'
                ELSE 'Partially Paid'
              END
          WHERE id = ?
          `,
          [paymentAmount, paymentAmount, paymentAmount, sourceId]
        );
      } else {
        await updateApvPaymentStatus(conn, sourceId);
      }
    }

    await conn.commit();

    res.json({
      success: true,
      message: "CV updated successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE CV ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "CV number already exists" });
    }

    res.status(500).json({ message: err.message || "Failed to update CV" });
  } finally {
    conn.release();
  }
});

// ===================== JV (JOURNAL VOUCHER) API =====================
// The frontend has no dedicated "post" action - Draft/Posted is embedded in the
// same create/update payload (handleSave(status) in TransactionFormLayout.jsx),
// so these routes follow that same shape rather than adding a separate endpoint.

app.get("/api/jv", authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        voucher_no AS voucherNo,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        prepared_for AS preparedFor,
        description,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status
      FROM jv_headers
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET JV ERROR:", err);
    res.status(500).json({ message: "Failed to load JV records" });
  }
});

app.post("/api/jv", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const {
      voucherNo,
      supplierName,
      customerName,
      transactionDate,
      referenceNo,
      description,
      remarks,
      totalDebit,
      totalCredit,
      status,
      lines = [],
    } = req.body;

    const preparedFor = req.body.preparedFor || supplierName || customerName || "";
    const finalStatus = status || "Draft";
    const userId = req.user?.id || null;

    const [result] = await conn.execute(
      `INSERT INTO jv_headers(
        voucher_no,
        transaction_date,
        reference_no,
        prepared_for,
        description,
        remarks,
        total_debit,
        total_credit,
        status,
        created_by,
        posted_by,
        posted_at
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        voucherNo || "",
        transactionDate || null,
        referenceNo || "",
        preparedFor,
        description || "",
        remarks || "",
        Number(totalDebit) || 0,
        Number(totalCredit) || 0,
        finalStatus,
        userId,
        finalStatus === "Posted" ? userId : null,
        finalStatus === "Posted" ? new Date() : null,
      ]
    );

    const jvId = result.insertId;

    for (const line of lines) {
      await conn.execute(
        `INSERT INTO jv_lines(
          jv_id,
          account_id,
          account_code,
          account_title,
          particulars,
          gen_ref,
          gen_name,
          debit,
          credit
        )
        VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          jvId,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
        ]
      );
    }

    await logAudit(conn, {
      module: "JV",
      entityType: "JV",
      entityId: jvId,
      action: finalStatus === "Posted" ? "POST" : "CREATE",
      description:
        finalStatus === "Posted"
          ? `JV ${voucherNo} created and posted`
          : `JV ${voucherNo} created (${finalStatus})`,
      afterData: { voucherNo, preparedFor, transactionDate, totalDebit, totalCredit, status: finalStatus },
      user: req.user,
    });

    await conn.commit();

    res.json({
      success: true,
      id: jvId,
      message: "JV saved successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE JV ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "JV number already exists" });
    }

    res.status(500).json({ message: "Failed to save JV" });
  } finally {
    conn.release();
  }
});

app.get("/api/jv/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [headers] = await pool.execute(
      `SELECT
        id,
        voucher_no AS voucherNo,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        prepared_for AS preparedFor,
        description,
        remarks,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status
      FROM jv_headers
      WHERE id = ?`,
      [id]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "JV not found" });
    }

    const [lines] = await pool.execute(
      `SELECT
        id,
        jv_id AS jvId,
        account_id AS accountId,
        account_code AS accountCode,
        account_title AS accountTitle,
        particulars,
        debit,
        credit,
        gen_ref AS genRef,
        gen_name AS genName
      FROM jv_lines
      WHERE jv_id = ?
      ORDER BY id ASC`,
      [id]
    );

    res.json({
      ...headers[0],
      lines,
    });
  } catch (err) {
    console.error("GET JV DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load JV details" });
  }
});

app.put("/api/jv/:id", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [existing] = await conn.execute(
      "SELECT status, posted_by, posted_at FROM jv_headers WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "JV not found" });
    }

    const {
      voucherNo,
      supplierName,
      customerName,
      transactionDate,
      referenceNo,
      description,
      remarks,
      totalDebit,
      totalCredit,
      status,
      lines = [],
    } = req.body;

    const preparedFor = req.body.preparedFor || supplierName || customerName || "";
    const finalStatus = status || "Draft";
    const userId = req.user?.id || null;
    const wasAlreadyPosted = existing[0].status === "Posted";

    // Preserve the original posted_by/posted_at if it was already Posted and stays
    // Posted through this edit - only set them fresh on the Draft->Posted transition.
    const nextPostedBy =
      finalStatus === "Posted" ? (wasAlreadyPosted ? existing[0].posted_by : userId) : null;
    const nextPostedAt =
      finalStatus === "Posted" ? (wasAlreadyPosted ? existing[0].posted_at : new Date()) : null;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE jv_headers SET
        voucher_no = ?,
        transaction_date = ?,
        reference_no = ?,
        prepared_for = ?,
        description = ?,
        remarks = ?,
        total_debit = ?,
        total_credit = ?,
        status = ?,
        posted_by = ?,
        posted_at = ?
      WHERE id = ?`,
      [
        voucherNo || "",
        transactionDate || null,
        referenceNo || "",
        preparedFor,
        description || "",
        remarks || "",
        Number(totalDebit) || 0,
        Number(totalCredit) || 0,
        finalStatus,
        nextPostedBy,
        nextPostedAt,
        id,
      ]
    );

    await conn.execute("DELETE FROM jv_lines WHERE jv_id = ?", [id]);

    for (const line of lines) {
      await conn.execute(
        `INSERT INTO jv_lines(
          jv_id,
          account_id,
          account_code,
          account_title,
          particulars,
          gen_ref,
          gen_name,
          debit,
          credit
        )
        VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          id,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          Number(line.debit) || 0,
          Number(line.credit) || 0,
        ]
      );
    }

    const isPostingNow = finalStatus === "Posted" && !wasAlreadyPosted;

    await logAudit(conn, {
      module: "JV",
      entityType: "JV",
      entityId: Number(id),
      action: isPostingNow ? "POST" : "UPDATE",
      description: isPostingNow
        ? `JV ${voucherNo} posted`
        : `JV ${voucherNo} updated (${finalStatus})`,
      beforeData: existing[0],
      afterData: { voucherNo, preparedFor, transactionDate, totalDebit, totalCredit, status: finalStatus },
      user: req.user,
    });

    await conn.commit();

    res.json({
      success: true,
      message: "JV updated successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE JV ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "JV number already exists" });
    }

    res.status(500).json({ message: "Failed to update JV" });
  } finally {
    conn.release();
  }
});

app.delete("/api/jv/:id", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [existing] = await conn.execute(
      "SELECT voucher_no, status FROM jv_headers WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "JV not found" });
    }

    await conn.beginTransaction();

    await conn.execute("DELETE FROM jv_headers WHERE id = ?", [id]);

    await logAudit(conn, {
      module: "JV",
      entityType: "JV",
      entityId: Number(id),
      action: "DELETE",
      description: `JV ${existing[0].voucher_no} deleted`,
      beforeData: existing[0],
      user: req.user,
    });

    await conn.commit();

    res.json({
      success: true,
      message: "JV deleted successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("DELETE JV ERROR:", err);
    res.status(500).json({ message: "Failed to delete JV" });
  } finally {
    conn.release();
  }
});

// ===================== AUDIT LOG API =====================

app.get("/api/audit-logs", authenticateToken, async (req, res) => {
  try {
    const { module, entityType, entityId, userId, from, to, limit } = req.query;

    const clauses = [];
    const params = [];

    if (module) {
      clauses.push("module = ?");
      params.push(module);
    }
    if (entityType) {
      clauses.push("entity_type = ?");
      params.push(entityType);
    }
    if (entityId) {
      clauses.push("entity_id = ?");
      params.push(Number(entityId));
    }
    if (userId) {
      clauses.push("user_id = ?");
      params.push(Number(userId));
    }
    if (from) {
      clauses.push("created_at >= ?");
      params.push(from);
    }
    if (to) {
      clauses.push("created_at <= ?");
      params.push(to);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const safeLimit = Math.min(Number(limit) || 200, 1000);

    const [rows] = await pool.execute(
      `SELECT
        id,
        module,
        entity_type AS entityType,
        entity_id AS entityId,
        action,
        description,
        before_data AS beforeData,
        after_data AS afterData,
        user_id AS userId,
        username,
        created_at AS createdAt
      FROM audit_logs
      ${where}
      ORDER BY id DESC
      LIMIT ${safeLimit}`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("GET AUDIT LOGS ERROR:", err);
    res.status(500).json({ message: "Failed to load audit logs" });
  }
});

// ===================== BANK RECONCILIATION API =====================
// Session management (Phase 3) and statement import (Phase 4). Matching/
// adjustments/finalize are handled by later phases and their own routes.

const BANK_RECON_SESSION_SELECT = `
  SELECT
    s.id,
    s.bank_account_id AS bankAccountId,
    bc.bank_code AS bankCode,
    bc.bank_name AS bankName,
    bc.account_no AS bankAccountNo,
    bc.account_name AS bankAccountName,
    bc.coa_account_id AS bankCoaAccountId,
    DATE_FORMAT(s.period_start, '%Y-%m-%d') AS periodStart,
    DATE_FORMAT(s.period_end, '%Y-%m-%d') AS periodEnd,
    s.statement_beginning_balance AS statementBeginningBalance,
    s.statement_ending_balance AS statementEndingBalance,
    s.date_tolerance_days AS dateToleranceDays,
    s.amount_variance_type AS amountVarianceType,
    s.amount_variance_value AS amountVarianceValue,
    s.status,
    s.notes,
    s.created_by AS createdBy,
    s.created_at AS createdAt,
    s.finalized_by AS finalizedBy,
    s.finalized_at AS finalizedAt
  FROM bank_recon_sessions s
  JOIN bank_codes bc ON bc.id = s.bank_account_id
`;

app.get("/api/bank-recon/sessions", authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `${BANK_RECON_SESSION_SELECT} ORDER BY s.id DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error("GET BANK RECON SESSIONS ERROR:", err);
    res.status(500).json({ message: "Failed to load reconciliation sessions" });
  }
});

app.post("/api/bank-recon/sessions", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      bankAccountId,
      periodStart,
      periodEnd,
      statementBeginningBalance,
      statementEndingBalance,
      dateToleranceDays,
      amountVarianceType,
      amountVarianceValue,
      notes,
    } = req.body;

    if (!bankAccountId) {
      return res.status(400).json({ message: "Bank account is required" });
    }
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ message: "Period start and end are required" });
    }
    if (new Date(periodEnd) < new Date(periodStart)) {
      return res.status(400).json({ message: "Period end cannot be before period start" });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO bank_recon_sessions(
        bank_account_id,
        period_start,
        period_end,
        statement_beginning_balance,
        statement_ending_balance,
        date_tolerance_days,
        amount_variance_type,
        amount_variance_value,
        status,
        notes,
        created_by
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        bankAccountId,
        periodStart,
        periodEnd,
        Number(statementBeginningBalance) || 0,
        Number(statementEndingBalance) || 0,
        Number(dateToleranceDays) || 3,
        amountVarianceType === "PERCENT" ? "PERCENT" : "FIXED",
        Number(amountVarianceValue) || 1.0,
        "IN_PROGRESS",
        notes || "",
        userId,
      ]
    );

    const sessionId = result.insertId;

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: sessionId,
      action: "CREATE",
      description: `Reconciliation session #${sessionId} created for bank account ${bankAccountId} (${periodStart} to ${periodEnd})`,
      afterData: { bankAccountId, periodStart, periodEnd, statementBeginningBalance, statementEndingBalance },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, id: sessionId, message: "Reconciliation session created" });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE BANK RECON SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to create reconciliation session" });
  } finally {
    conn.release();
  }
});

app.get("/api/bank-recon/sessions/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("GET BANK RECON SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to load reconciliation session" });
  }
});

app.patch("/api/bank-recon/sessions/:id", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [existingRows] = await conn.execute(
      "SELECT * FROM bank_recon_sessions WHERE id = ?",
      [id]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const existing = existingRows[0];

    if (existing.status === "FINALIZED") {
      return res.status(400).json({
        message: "Cannot edit a finalized session. Reopen it first.",
      });
    }

    const {
      periodStart,
      periodEnd,
      statementBeginningBalance,
      statementEndingBalance,
      dateToleranceDays,
      amountVarianceType,
      amountVarianceValue,
      notes,
    } = req.body;

    const next = {
      periodStart: periodStart || existing.period_start,
      periodEnd: periodEnd || existing.period_end,
      statementBeginningBalance:
        statementBeginningBalance !== undefined
          ? Number(statementBeginningBalance) || 0
          : existing.statement_beginning_balance,
      statementEndingBalance:
        statementEndingBalance !== undefined
          ? Number(statementEndingBalance) || 0
          : existing.statement_ending_balance,
      dateToleranceDays:
        dateToleranceDays !== undefined
          ? Number(dateToleranceDays) || 0
          : existing.date_tolerance_days,
      amountVarianceType:
        amountVarianceType === "PERCENT" || amountVarianceType === "FIXED"
          ? amountVarianceType
          : existing.amount_variance_type,
      amountVarianceValue:
        amountVarianceValue !== undefined
          ? Number(amountVarianceValue) || 0
          : existing.amount_variance_value,
      notes: notes !== undefined ? notes : existing.notes,
    };

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE bank_recon_sessions SET
        period_start = ?,
        period_end = ?,
        statement_beginning_balance = ?,
        statement_ending_balance = ?,
        date_tolerance_days = ?,
        amount_variance_type = ?,
        amount_variance_value = ?,
        notes = ?
      WHERE id = ?`,
      [
        next.periodStart,
        next.periodEnd,
        next.statementBeginningBalance,
        next.statementEndingBalance,
        next.dateToleranceDays,
        next.amountVarianceType,
        next.amountVarianceValue,
        next.notes,
        id,
      ]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(id),
      action: "CONFIG_UPDATE",
      description: `Reconciliation session #${id} settings updated`,
      beforeData: existing,
      afterData: next,
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, message: "Reconciliation session updated" });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE BANK RECON SESSION ERROR:", err);
    res.status(500).json({ message: "Failed to update reconciliation session" });
  } finally {
    conn.release();
  }
});

// ---- Statement import (Phase 4) ----

function handleUpload(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || "File upload failed" });
      }
      next();
    });
  };
}

const BANK_STMT_FIELD_ALIASES = {
  date: ["date", "transaction date", "txn date", "posting date", "value date", "trans date"],
  description: ["description", "particulars", "details", "narrative", "transaction description", "remarks"],
  referenceNo: ["reference", "reference no", "reference no.", "ref no", "ref no.", "ref#", "ref #", "transaction ref"],
  checkNo: ["check no", "check no.", "cheque no", "cheque no.", "check number", "chk no", "check #"],
  debit: ["debit", "withdrawal", "withdrawals", "dr", "money out", "debit amount", "out"],
  credit: ["credit", "deposit", "deposits", "cr", "money in", "credit amount", "in"],
  amount: ["amount", "transaction amount", "value"],
  runningBalance: ["balance", "running balance", "closing balance", "ending balance"],
};

function normalizeHeaderKey(header) {
  return String(header || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveColumnMapping(headers, explicitMapping) {
  const normalizedHeaders = headers.map((h) => normalizeHeaderKey(h));
  const mapping = {};

  for (const field of Object.keys(BANK_STMT_FIELD_ALIASES)) {
    if (explicitMapping && explicitMapping[field]) {
      const idx = headers.findIndex((h) => String(h) === String(explicitMapping[field]));
      if (idx !== -1) {
        mapping[field] = idx;
        continue;
      }
    }

    const aliasIdx = normalizedHeaders.findIndex((h) =>
      BANK_STMT_FIELD_ALIASES[field].includes(h)
    );
    if (aliasIdx !== -1) {
      mapping[field] = aliasIdx;
    }
  }

  return mapping;
}

// Deliberately avoids `date.toISOString()` for anything derived from a
// local/ambiguous string - `new Date(nonIsoString)` parses in the server's
// local timezone, so converting the result back via UTC getters silently
// shifts the calendar day whenever local time is ahead of UTC (e.g. UTC+8).
// Each branch below reads the calendar date back out the same way it went
// in (UTC in, UTC out; local in, local out) so the day never drifts.
function parseStatementDate(value) {
  if (value === undefined || value === null || value === "") return null;

  if (value instanceof Date && !isNaN(value)) {
    // exceljs date cells are UTC-midnight-anchored (Excel dates carry no
    // timezone of their own), so read them back out via UTC getters.
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const str = String(value).trim();
  if (!str) return null;

  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const slashMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slashMatch) {
    const [, a, b, yearRaw] = slashMatch;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    const month = String(a).padStart(2, "0");
    const day = String(b).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  if (/\d{4}/.test(str)) {
    const native = new Date(str);
    if (!isNaN(native)) {
      const y = native.getFullYear();
      const m = String(native.getMonth() + 1).padStart(2, "0");
      const d = String(native.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }

  return null;
}

function parseStatementAmount(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return value;

  let str = String(value).trim();
  if (!str) return null;

  const isNegativeParens = /^\(.*\)$/.test(str);
  str = str.replace(/[₱PHPphp,\s()]/g, "");

  if (str === "" || str === "-") return null;

  let num = Number(str);
  if (isNaN(num)) return null;

  if (isNegativeParens) num = -Math.abs(num);

  return num;
}

function buildStatementLine(rowValues, mapping) {
  const get = (field) =>
    mapping[field] !== undefined ? rowValues[mapping[field]] : undefined;

  const txnDate = parseStatementDate(get("date"));
  const description = get("description") != null ? String(get("description")).trim() : "";
  const referenceNo = get("referenceNo") != null ? String(get("referenceNo")).trim() : "";
  const checkNo = get("checkNo") != null ? String(get("checkNo")).trim() : "";

  let debit = mapping.debit !== undefined ? parseStatementAmount(get("debit")) : null;
  let credit = mapping.credit !== undefined ? parseStatementAmount(get("credit")) : null;

  if (mapping.debit === undefined && mapping.credit === undefined && mapping.amount !== undefined) {
    const amt = parseStatementAmount(get("amount"));
    if (amt !== null) {
      if (amt < 0) {
        debit = Math.abs(amt);
        credit = 0;
      } else {
        debit = 0;
        credit = amt;
      }
    }
  }

  const runningBalance =
    mapping.runningBalance !== undefined ? parseStatementAmount(get("runningBalance")) : null;

  return {
    txnDate,
    description,
    referenceNo,
    checkNo,
    debit: debit || 0,
    credit: credit || 0,
    runningBalance,
  };
}

function unwrapCellValue(value) {
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    if ("result" in value) return value.result;
    if ("richText" in value) return value.richText.map((t) => t.text).join("");
    if ("text" in value) return value.text;
  }
  return value;
}

async function extractRowsFromXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) return { headers: [], dataRows: [] };

  const allRows = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map(unwrapCellValue);
    allRows.push(values);
  });

  const headers = (allRows[0] || []).map((h) => (h == null ? "" : String(h)));
  const dataRows = allRows.slice(1);

  return { headers, dataRows };
}

app.post(
  "/api/bank-recon/sessions/:id/import",
  authenticateToken,
  handleUpload(bankStatementUpload.single("file")),
  async (req, res) => {
    const conn = await pool.getConnection();

    try {
      const { id } = req.params;

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const [sessionRows] = await conn.execute(
        "SELECT id, status FROM bank_recon_sessions WHERE id = ?",
        [id]
      );

      if (sessionRows.length === 0) {
        return res.status(404).json({ message: "Reconciliation session not found" });
      }
      if (sessionRows[0].status === "FINALIZED") {
        return res.status(400).json({ message: "Cannot import into a finalized session" });
      }

      const ext = path.extname(req.file.originalname || "").toLowerCase();
      const fileType = ext === ".csv" ? "CSV" : "XLSX";

      let headers = [];
      let dataRows = [];

      if (fileType === "CSV") {
        const records = parseCsv(req.file.buffer, {
          columns: false,
          skip_empty_lines: true,
          trim: true,
          relax_column_count: true,
        });
        headers = records[0] || [];
        dataRows = records.slice(1);
      } else {
        const extracted = await extractRowsFromXlsx(req.file.buffer);
        headers = extracted.headers;
        dataRows = extracted.dataRows;
      }

      if (headers.length === 0) {
        return res.status(400).json({ message: "The file appears to be empty" });
      }

      let explicitMapping = null;
      if (req.body.columnMapping) {
        try {
          explicitMapping = JSON.parse(req.body.columnMapping);
        } catch {
          explicitMapping = null;
        }
      }

      const mapping = resolveColumnMapping(headers, explicitMapping);

      if (mapping.date === undefined) {
        return res.status(400).json({
          message: "Could not detect a date column. Please provide columnMapping.",
          headers,
        });
      }
      if (mapping.debit === undefined && mapping.credit === undefined && mapping.amount === undefined) {
        return res.status(400).json({
          message: "Could not detect debit/credit or amount columns. Please provide columnMapping.",
          headers,
        });
      }

      const parsedLines = [];
      const skippedRows = [];

      dataRows.forEach((row, idx) => {
        const line = buildStatementLine(row, mapping);

        if (!line.txnDate) {
          skippedRows.push({ row: idx + 2, reason: "Unrecognized or missing date" });
          return;
        }
        if (!line.debit && !line.credit) {
          skippedRows.push({ row: idx + 2, reason: "No debit/credit/amount value" });
          return;
        }

        parsedLines.push(line);
      });

      if (parsedLines.length === 0) {
        return res.status(400).json({
          message: "No valid statement lines could be parsed from the file",
          skippedRows,
        });
      }

      await conn.beginTransaction();

      const [batchResult] = await conn.execute(
        `INSERT INTO bank_recon_import_batches(session_id, file_name, file_type, row_count, column_mapping, status, imported_by)
         VALUES(?,?,?,?,?,?,?)`,
        [
          id,
          req.file.originalname || "",
          fileType,
          parsedLines.length,
          JSON.stringify({ headers, mapping }),
          "IMPORTED",
          req.user?.id || null,
        ]
      );

      const batchId = batchResult.insertId;

      for (const line of parsedLines) {
        await conn.execute(
          `INSERT INTO bank_recon_statement_lines(
            batch_id, session_id, txn_date, description, reference_no, check_no, debit, credit, running_balance, match_status
          ) VALUES(?,?,?,?,?,?,?,?,?, 'UNMATCHED')`,
          [
            batchId,
            id,
            line.txnDate,
            line.description || "",
            line.referenceNo || "",
            line.checkNo || "",
            line.debit || 0,
            line.credit || 0,
            line.runningBalance,
          ]
        );
      }

      await logAudit(conn, {
        module: "BANK_RECON",
        entityType: "IMPORT_BATCH",
        entityId: batchId,
        action: "IMPORT",
        description: `Imported ${parsedLines.length} statement line(s) from ${req.file.originalname} into session #${id}`,
        afterData: {
          fileName: req.file.originalname,
          fileType,
          rowCount: parsedLines.length,
          skippedCount: skippedRows.length,
        },
        user: req.user,
      });

      await conn.commit();

      res.json({
        success: true,
        batchId,
        rowCount: parsedLines.length,
        skippedRows,
        message: `Imported ${parsedLines.length} statement line(s)${
          skippedRows.length ? `, ${skippedRows.length} row(s) skipped` : ""
        }`,
      });
    } catch (err) {
      await conn.rollback();
      console.error("IMPORT BANK STATEMENT ERROR:", err);
      res.status(500).json({ message: err.message || "Failed to import bank statement" });
    } finally {
      conn.release();
    }
  }
);

app.get("/api/bank-recon/sessions/:id/import-batches", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT
        id,
        session_id AS sessionId,
        file_name AS fileName,
        file_type AS fileType,
        row_count AS rowCount,
        column_mapping AS columnMapping,
        status,
        imported_by AS importedBy,
        imported_at AS importedAt
      FROM bank_recon_import_batches
      WHERE session_id = ?
      ORDER BY id DESC`,
      [id]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET IMPORT BATCHES ERROR:", err);
    res.status(500).json({ message: "Failed to load import batches" });
  }
});

app.get("/api/bank-recon/sessions/:id/statement-lines", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT
        sl.id,
        sl.batch_id AS batchId,
        DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate,
        sl.description,
        sl.reference_no AS referenceNo,
        sl.check_no AS checkNo,
        sl.debit,
        sl.credit,
        sl.running_balance AS runningBalance,
        sl.match_status AS matchStatus,
        m.id AS confirmedMatchId
      FROM bank_recon_statement_lines sl
      LEFT JOIN bank_recon_matches m
        ON m.statement_line_id = sl.id AND m.status = 'CONFIRMED'
      WHERE sl.session_id = ?
      ORDER BY sl.txn_date ASC, sl.id ASC`,
      [id]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET STATEMENT LINES ERROR:", err);
    res.status(500).json({ message: "Failed to load statement lines" });
  }
});

app.delete("/api/bank-recon/import-batches/:id", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [existing] = await conn.execute(
      "SELECT session_id, file_name, row_count FROM bank_recon_import_batches WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "Import batch not found" });
    }

    const [sessionRows] = await conn.execute(
      "SELECT status FROM bank_recon_sessions WHERE id = ?",
      [existing[0].session_id]
    );

    if (sessionRows[0]?.status === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }

    await conn.beginTransaction();

    await conn.execute("DELETE FROM bank_recon_import_batches WHERE id = ?", [id]);

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "IMPORT_BATCH",
      entityId: Number(id),
      action: "DELETE",
      description: `Import batch "${existing[0].file_name}" (${existing[0].row_count} rows) deleted from session #${existing[0].session_id}`,
      beforeData: existing[0],
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, message: "Import batch deleted" });
  } catch (err) {
    await conn.rollback();
    console.error("DELETE IMPORT BATCH ERROR:", err);
    res.status(500).json({ message: "Failed to delete import batch" });
  } finally {
    conn.release();
  }
});

// ---- Matching engine (Phase 5, compute-only) ----
// Deterministic weighted-rule scoring. Only CV, OR, and JV touch a bank
// account directly (invoice_headers/apv_headers have no bank_account_id -
// they're AR/AP documents; a paid invoice shows up here as the OR that
// applied against it, per the existing transaction_applications design).

function normalizeIdentifier(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase().replace(/^0+(?=\d)/, "");
}

function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function jaccardSimilarity(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Both sides of every date diff here are plain 'YYYY-MM-DD' strings pulled
// via SQL DATE_FORMAT (see loadBookTransactions/statement-lines queries),
// so anchoring to UTC midnight here is safe and never drifts a day.
function daysBetween(dateStrA, dateStrB) {
  const a = new Date(`${dateStrA}T00:00:00Z`);
  const b = new Date(`${dateStrB}T00:00:00Z`);
  return Math.round(Math.abs(a - b) / 86400000);
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().split("T")[0];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function loadBookTransactions(
  conn,
  bankAccountId,
  bankCoaAccountId,
  periodStart,
  periodEnd,
  toleranceDays
) {
  const widenDays = (Number(toleranceDays) || 0) * 2;
  const fromDate = shiftDate(periodStart, -widenDays);
  const toDate = shiftDate(periodEnd, widenDays);

  const [cvRows] = await conn.execute(
    `SELECT id, voucher_no AS voucherNo, payee_name AS payeeName,
            DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
            reference_no AS referenceNo, check_no AS checkNo, total_debit AS totalDebit, description
     FROM cv_headers
     WHERE bank_account_id = ? AND status = 'Posted' AND transaction_date BETWEEN ? AND ?`,
    [bankAccountId, fromDate, toDate]
  );

  const [orRows] = await conn.execute(
    `SELECT id, voucher_no AS voucherNo, customer_name AS customerName,
            DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
            reference_no AS referenceNo, receipt_no AS receiptNo, check_no AS checkNo,
            total_debit AS totalDebit, description
     FROM or_headers
     WHERE bank_account_id = ? AND status = 'Posted' AND transaction_date BETWEEN ? AND ?`,
    [bankAccountId, fromDate, toDate]
  );

  const jvRows = bankCoaAccountId
    ? (
        await conn.execute(
          `SELECT jl.id AS lineId, jh.id AS jvId, jh.voucher_no AS voucherNo, jh.prepared_for AS preparedFor,
                  DATE_FORMAT(jh.transaction_date, '%Y-%m-%d') AS txnDate,
                  jh.reference_no AS referenceNo, jh.description, jl.debit, jl.credit
           FROM jv_lines jl
           JOIN jv_headers jh ON jh.id = jl.jv_id
           WHERE jl.account_id = ? AND jh.status = 'Posted' AND jh.transaction_date BETWEEN ? AND ?`,
          [bankCoaAccountId, fromDate, toDate]
        )
      )[0]
    : [];

  const txns = [];

  for (const cv of cvRows) {
    txns.push({
      sourceType: "CV",
      sourceId: cv.id,
      lineId: null,
      amount: Number(cv.totalDebit),
      direction: "OUT",
      date: cv.txnDate,
      referenceNo: cv.referenceNo,
      checkNo: cv.checkNo,
      receiptNo: "",
      payeeOrCustomer: cv.payeeName,
      description: cv.description,
      voucherNo: cv.voucherNo,
    });
  }

  for (const or of orRows) {
    txns.push({
      sourceType: "OR",
      sourceId: or.id,
      lineId: null,
      amount: Number(or.totalDebit),
      direction: "IN",
      date: or.txnDate,
      referenceNo: or.referenceNo,
      checkNo: or.checkNo,
      receiptNo: or.receiptNo,
      payeeOrCustomer: or.customerName,
      description: or.description,
      voucherNo: or.voucherNo,
    });
  }

  for (const jl of jvRows) {
    const debit = Number(jl.debit);
    const credit = Number(jl.credit);
    if (debit <= 0 && credit <= 0) continue;

    txns.push({
      sourceType: "JV",
      sourceId: jl.jvId,
      lineId: jl.lineId,
      amount: debit > 0 ? debit : credit,
      direction: debit > 0 ? "IN" : "OUT",
      date: jl.txnDate,
      referenceNo: jl.referenceNo,
      checkNo: "",
      receiptNo: "",
      payeeOrCustomer: jl.preparedFor,
      description: jl.description,
      voucherNo: jl.voucherNo,
    });
  }

  return txns;
}

// Returns null when the candidate falls outside 2x the amount variance or
// 2x the date tolerance (excluded entirely), otherwise a scored candidate.
function scoreCandidate(stmtLine, bookTxn, session) {
  const stmtAmount = Number(stmtLine.debit) > 0 ? Number(stmtLine.debit) : Number(stmtLine.credit);
  const bookAmount = bookTxn.amount;
  const amountDiff = Math.abs(stmtAmount - bookAmount);

  const varianceEdge =
    session.amountVarianceType === "PERCENT"
      ? stmtAmount * (Number(session.amountVarianceValue) / 100)
      : Number(session.amountVarianceValue);

  let amountScore = 0;
  if (amountDiff === 0) {
    amountScore = 40;
  } else if (varianceEdge > 0 && amountDiff <= varianceEdge) {
    amountScore = 40 * (1 - amountDiff / varianceEdge);
  } else if (varianceEdge > 0 && amountDiff <= varianceEdge * 2) {
    amountScore = 0;
  } else {
    return null;
  }

  const tolerance = Number(session.dateToleranceDays) || 0;
  const dateDiffDays = daysBetween(stmtLine.txnDate, bookTxn.date);

  let dateScore = 0;
  if (dateDiffDays === 0) {
    dateScore = 20;
  } else if (tolerance > 0 && dateDiffDays <= tolerance) {
    dateScore = 20 * (1 - dateDiffDays / tolerance);
  } else if (tolerance > 0 && dateDiffDays <= tolerance * 2) {
    dateScore = 0;
  } else {
    return null;
  }

  const stmtIdentifiers = [stmtLine.referenceNo, stmtLine.checkNo]
    .map(normalizeIdentifier)
    .filter(Boolean);
  const bookIdentifiers = [bookTxn.referenceNo, bookTxn.checkNo, bookTxn.receiptNo]
    .map(normalizeIdentifier)
    .filter(Boolean);

  let identifierScore = 0;
  let identifierExact = false;

  if (stmtIdentifiers.length && bookIdentifiers.length) {
    if (stmtIdentifiers.some((s) => bookIdentifiers.includes(s))) {
      identifierScore = 25;
      identifierExact = true;
    } else if (
      stmtIdentifiers.some((s) =>
        bookIdentifiers.some(
          (b) => s.length >= 3 && b.length >= 3 && (s.includes(b) || b.includes(s))
        )
      )
    ) {
      identifierScore = 10;
    }
  }

  const stmtDescNormalized = normalizeIdentifier(stmtLine.description);
  const bookNameNormalized = normalizeIdentifier(bookTxn.payeeOrCustomer);

  let payeeScore = 0;
  if (bookNameNormalized) {
    if (stmtDescNormalized === bookNameNormalized) {
      payeeScore = 10;
    } else if (bookNameNormalized.length >= 3 && stmtDescNormalized.includes(bookNameNormalized)) {
      payeeScore = 5;
    }
  }

  const descScore = jaccardSimilarity(stmtLine.description, bookTxn.description) * 5;

  const totalScore = Math.min(
    100,
    amountScore + dateScore + identifierScore + payeeScore + descScore
  );

  // Amount(40) + date(20) + identifier(25) only sum to 85 of the 100
  // possible points, so requiring totalScore >= 95 on top of these three
  // being individually perfect would demand bonus payee/description
  // similarity too - something free-text bank statement wording routinely
  // lacks even on a genuinely exact match. EXACT is defined by the three
  // conditions themselves, not an unreachable extra score floor.
  const hasStmtIdentifier = stmtIdentifiers.length > 0;
  const isExact =
    amountDiff === 0 && dateDiffDays === 0 && (identifierExact || !hasStmtIdentifier);

  return {
    ...bookTxn,
    totalScore: round2(totalScore),
    matchType: isExact ? "EXACT" : "SUGGESTED",
    breakdown: {
      amountScore: round2(amountScore),
      dateScore: round2(dateScore),
      identifierScore,
      payeeScore,
      descScore: round2(descScore),
    },
  };
}

// ---- Outstanding items + adjustment suggestions (Phase 7) ----

const BANK_CHARGE_KEYWORDS = [
  "service charge",
  "bank charge",
  "maintaining balance",
  "debit memo",
  "atm fee",
];
const INTEREST_INCOME_KEYWORDS = ["interest", "int income", "credit memo interest"];

// Every statement line the matching engine can't explain becomes something
// the user must explicitly decide on - a guessed BANK_CHARGE/INTEREST_INCOME
// via keyword match, or OTHER when no keyword hits. Never auto-approved.
function classifyAdjustmentSuggestion(line) {
  const desc = String(line.description || "").toLowerCase();
  const isDebit = Number(line.debit) > 0;
  const isCredit = Number(line.credit) > 0;

  if (isDebit && BANK_CHARGE_KEYWORDS.some((kw) => desc.includes(kw))) {
    return { adjustmentType: "BANK_CHARGE", amount: Number(line.debit) };
  }
  if (isCredit && INTEREST_INCOME_KEYWORDS.some((kw) => desc.includes(kw))) {
    return { adjustmentType: "INTEREST_INCOME", amount: Number(line.credit) };
  }

  return { adjustmentType: "OTHER", amount: isDebit ? Number(line.debit) : Number(line.credit) };
}

app.post("/api/bank-recon/sessions/:id/run-matching", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];

    if (session.status === "FINALIZED") {
      return res.status(400).json({ message: "Cannot run matching on a finalized session" });
    }

    const [stmtLines] = await conn.execute(
      `SELECT id, DATE_FORMAT(txn_date, '%Y-%m-%d') AS txnDate, description,
              reference_no AS referenceNo, check_no AS checkNo, debit, credit
       FROM bank_recon_statement_lines
       WHERE session_id = ? AND match_status IN ('UNMATCHED', 'SUGGESTED')`,
      [id]
    );

    if (stmtLines.length === 0) {
      return res.json({
        success: true,
        processed: 0,
        suggested: 0,
        message: "No unmatched statement lines to process",
      });
    }

    const bookTxns = await loadBookTransactions(
      conn,
      session.bankAccountId,
      session.bankCoaAccountId,
      session.periodStart,
      session.periodEnd,
      session.dateToleranceDays
    );

    const [confirmedRows] = await conn.execute(
      `SELECT book_source_type AS sourceType, book_source_id AS sourceId, book_line_id AS lineId
       FROM bank_recon_matches
       WHERE session_id = ? AND status = 'CONFIRMED'`,
      [id]
    );
    const confirmedKeys = new Set(
      confirmedRows.map((r) => `${r.sourceType}:${r.sourceId}:${r.lineId ?? ""}`)
    );

    await conn.beginTransaction();

    let suggestedCount = 0;

    for (const line of stmtLines) {
      await conn.execute(
        "DELETE FROM bank_recon_matches WHERE statement_line_id = ? AND status = 'PENDING'",
        [line.id]
      );

      const wantDirection = Number(line.debit) > 0 ? "OUT" : "IN";

      const candidates = bookTxns
        .filter((t) => t.direction === wantDirection)
        .filter((t) => !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`))
        .map((t) => scoreCandidate(line, t, session))
        .filter((c) => c && c.totalScore >= 30)
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 3);

      for (const c of candidates) {
        await conn.execute(
          `INSERT INTO bank_recon_matches(
            session_id, statement_line_id, book_source_type, book_source_id, book_line_id,
            match_type, confidence_score, score_breakdown, status, amount, created_by
          ) VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`,
          [
            id,
            line.id,
            c.sourceType,
            c.sourceId,
            c.lineId,
            c.matchType,
            c.totalScore,
            JSON.stringify(c.breakdown),
            c.amount,
            req.user?.id || null,
          ]
        );
      }

      const newStatus = candidates.length > 0 ? "SUGGESTED" : "UNMATCHED";

      await conn.execute("UPDATE bank_recon_statement_lines SET match_status = ? WHERE id = ?", [
        newStatus,
        line.id,
      ]);

      if (newStatus === "SUGGESTED") suggestedCount++;

      // A line with no viable book match either explains itself (bank
      // charge/interest) or needs a human decision (OTHER) - either way it
      // becomes a PENDING adjustment suggestion. Only refresh suggestions
      // still PENDING; once a user has approved/rejected one, leave it be.
      if (newStatus === "UNMATCHED") {
        const [existingAdj] = await conn.execute(
          "SELECT id FROM bank_recon_adjustments WHERE statement_line_id = ? AND status = 'PENDING'",
          [line.id]
        );

        if (existingAdj.length === 0) {
          const [anyAdj] = await conn.execute(
            "SELECT id FROM bank_recon_adjustments WHERE statement_line_id = ?",
            [line.id]
          );

          if (anyAdj.length === 0) {
            const { adjustmentType, amount } = classifyAdjustmentSuggestion(line);

            await conn.execute(
              `INSERT INTO bank_recon_adjustments(
                session_id, statement_line_id, adjustment_type, amount, description, status
              ) VALUES (?,?,?,?,?, 'PENDING')`,
              [id, line.id, adjustmentType, amount, line.description || ""]
            );
          }
        }
      }
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(id),
      action: "MATCH",
      description: `Matching engine run on session #${id}: ${stmtLines.length} line(s) processed, ${suggestedCount} with suggestions`,
      afterData: { processed: stmtLines.length, suggested: suggestedCount },
      user: req.user,
    });

    await conn.commit();

    res.json({
      success: true,
      processed: stmtLines.length,
      suggested: suggestedCount,
      message: `Processed ${stmtLines.length} statement line(s), ${suggestedCount} with suggested matches`,
    });
  } catch (err) {
    await conn.rollback();
    console.error("RUN MATCHING ERROR:", err);
    res.status(500).json({ message: "Failed to run matching" });
  } finally {
    conn.release();
  }
});

app.get(
  "/api/bank-recon/statement-lines/:id/candidates",
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;

      const [rows] = await pool.execute(
        `SELECT
          m.id,
          m.book_source_type AS bookSourceType,
          m.book_source_id AS bookSourceId,
          m.book_line_id AS bookLineId,
          m.match_type AS matchType,
          m.confidence_score AS confidenceScore,
          m.score_breakdown AS scoreBreakdown,
          m.status,
          m.amount
        FROM bank_recon_matches m
        WHERE m.statement_line_id = ? AND m.status = 'PENDING'
        ORDER BY m.confidence_score DESC`,
        [id]
      );

      const enriched = [];

      for (const row of rows) {
        let detail = null;

        if (row.bookSourceType === "CV") {
          const [d] = await pool.execute(
            `SELECT voucher_no AS voucherNo, payee_name AS payeeName,
                    DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
                    reference_no AS referenceNo, check_no AS checkNo, description
             FROM cv_headers WHERE id = ?`,
            [row.bookSourceId]
          );
          detail = d[0] || null;
        } else if (row.bookSourceType === "OR") {
          const [d] = await pool.execute(
            `SELECT voucher_no AS voucherNo, customer_name AS customerName,
                    DATE_FORMAT(transaction_date, '%Y-%m-%d') AS txnDate,
                    reference_no AS referenceNo, receipt_no AS receiptNo, check_no AS checkNo, description
             FROM or_headers WHERE id = ?`,
            [row.bookSourceId]
          );
          detail = d[0] || null;
        } else if (row.bookSourceType === "JV") {
          const [d] = await pool.execute(
            `SELECT jh.voucher_no AS voucherNo, jh.prepared_for AS preparedFor,
                    DATE_FORMAT(jh.transaction_date, '%Y-%m-%d') AS txnDate,
                    jh.reference_no AS referenceNo, jh.description
             FROM jv_headers jh WHERE jh.id = ?`,
            [row.bookSourceId]
          );
          detail = d[0] || null;
        }

        enriched.push({ ...row, detail });
      }

      res.json(enriched);
    } catch (err) {
      console.error("GET MATCH CANDIDATES ERROR:", err);
      res.status(500).json({ message: "Failed to load match candidates" });
    }
  }
);

app.get("/api/bank-recon/sessions/:id/book-items", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];

    const bookTxns = await loadBookTransactions(
      conn,
      session.bankAccountId,
      session.bankCoaAccountId,
      session.periodStart,
      session.periodEnd,
      session.dateToleranceDays
    );

    const [confirmedRows] = await conn.execute(
      `SELECT book_source_type AS sourceType, book_source_id AS sourceId, book_line_id AS lineId
       FROM bank_recon_matches
       WHERE session_id = ? AND status = 'CONFIRMED'`,
      [id]
    );
    const confirmedKeys = new Set(
      confirmedRows.map((r) => `${r.sourceType}:${r.sourceId}:${r.lineId ?? ""}`)
    );

    const unmatched = bookTxns.filter(
      (t) => !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`)
    );

    res.json(unmatched);
  } catch (err) {
    console.error("GET BOOK ITEMS ERROR:", err);
    res.status(500).json({ message: "Failed to load book items" });
  } finally {
    conn.release();
  }
});

// ---- Match confirm/unmatch/ignore (Phase 6) ----
// 1:1 matches only for now (many-to-one is explicitly out of scope for this
// plan). Confirming a candidate auto-rejects its sibling PENDING candidates
// for the same statement line, since only one can end up CONFIRMED.

app.post("/api/bank-recon/matches/:id/confirm", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [rows] = await conn.execute(
      `SELECT m.*, s.status AS sessionStatus
       FROM bank_recon_matches m
       JOIN bank_recon_sessions s ON s.id = m.session_id
       WHERE m.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Match not found" });
    }

    const match = rows[0];

    if (match.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (match.status !== "PENDING") {
      return res.status(400).json({ message: `Match is already ${match.status}` });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_matches SET status = 'CONFIRMED', matched_by = ?, matched_at = NOW() WHERE id = ?",
      [userId, id]
    );

    await conn.execute(
      `UPDATE bank_recon_matches
       SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
       WHERE statement_line_id = ? AND status = 'PENDING' AND id != ?`,
      [userId, match.statement_line_id, id]
    );

    await conn.execute(
      "UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?",
      [match.statement_line_id]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: Number(id),
      action: "MATCH",
      description: `Confirmed ${match.match_type} match: statement line #${match.statement_line_id} <-> ${match.book_source_type} #${match.book_source_id}`,
      beforeData: { status: match.status },
      afterData: { status: "CONFIRMED" },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, message: "Match confirmed" });
  } catch (err) {
    await conn.rollback();
    console.error("CONFIRM MATCH ERROR:", err);
    res.status(500).json({ message: "Failed to confirm match" });
  } finally {
    conn.release();
  }
});

app.post("/api/bank-recon/matches/bulk-confirm", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required" });
    }

    const [sessionRows] = await conn.execute(
      "SELECT status FROM bank_recon_sessions WHERE id = ?",
      [sessionId]
    );

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }
    if (sessionRows[0].status === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }

    const [exactMatches] = await conn.execute(
      "SELECT id, statement_line_id AS statementLineId FROM bank_recon_matches WHERE session_id = ? AND status = 'PENDING' AND match_type = 'EXACT'",
      [sessionId]
    );

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    for (const m of exactMatches) {
      await conn.execute(
        "UPDATE bank_recon_matches SET status = 'CONFIRMED', matched_by = ?, matched_at = NOW() WHERE id = ?",
        [userId, m.id]
      );
      await conn.execute(
        `UPDATE bank_recon_matches
         SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
         WHERE statement_line_id = ? AND status = 'PENDING' AND id != ?`,
        [userId, m.statementLineId, m.id]
      );
      await conn.execute(
        "UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?",
        [m.statementLineId]
      );
    }

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "SESSION",
      entityId: Number(sessionId),
      action: "MATCH",
      description: `Bulk-confirmed ${exactMatches.length} exact match(es) in session #${sessionId}`,
      afterData: { confirmedCount: exactMatches.length },
      user: req.user,
    });

    await conn.commit();

    res.json({
      success: true,
      confirmedCount: exactMatches.length,
      message: `Confirmed ${exactMatches.length} exact match(es)`,
    });
  } catch (err) {
    await conn.rollback();
    console.error("BULK CONFIRM MATCHES ERROR:", err);
    res.status(500).json({ message: "Failed to bulk-confirm matches" });
  } finally {
    conn.release();
  }
});

app.post("/api/bank-recon/matches", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { statementLineId, bookSourceType, bookSourceId, bookLineId, amount } = req.body;

    if (!statementLineId || !bookSourceType || !bookSourceId) {
      return res
        .status(400)
        .json({ message: "statementLineId, bookSourceType, and bookSourceId are required" });
    }
    if (!["CV", "OR", "JV"].includes(bookSourceType)) {
      return res.status(400).json({ message: "Invalid bookSourceType" });
    }

    const [lineRows] = await conn.execute(
      `SELECT sl.id, sl.session_id AS sessionId, sl.match_status AS matchStatus, s.status AS sessionStatus
       FROM bank_recon_statement_lines sl
       JOIN bank_recon_sessions s ON s.id = sl.session_id
       WHERE sl.id = ?`,
      [statementLineId]
    );

    if (lineRows.length === 0) {
      return res.status(404).json({ message: "Statement line not found" });
    }

    const line = lineRows[0];

    if (line.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (line.matchStatus === "MATCHED") {
      return res.status(400).json({ message: "Statement line is already matched" });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE bank_recon_matches
       SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW()
       WHERE statement_line_id = ? AND status = 'PENDING'`,
      [userId, statementLineId]
    );

    const [result] = await conn.execute(
      `INSERT INTO bank_recon_matches(
        session_id, statement_line_id, book_source_type, book_source_id, book_line_id,
        match_type, confidence_score, status, amount, created_by, matched_by, matched_at
      ) VALUES (?,?,?,?,?, 'MANUAL', NULL, 'CONFIRMED', ?, ?, ?, NOW())`,
      [
        line.sessionId,
        statementLineId,
        bookSourceType,
        bookSourceId,
        bookLineId || null,
        Number(amount) || 0,
        userId,
        userId,
      ]
    );

    await conn.execute(
      "UPDATE bank_recon_statement_lines SET match_status = 'MATCHED' WHERE id = ?",
      [statementLineId]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: result.insertId,
      action: "MATCH",
      description: `Manually matched statement line #${statementLineId} to ${bookSourceType} #${bookSourceId}`,
      afterData: { bookSourceType, bookSourceId, bookLineId, amount },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, id: result.insertId, message: "Match created" });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE MANUAL MATCH ERROR:", err);
    res.status(500).json({ message: "Failed to create match" });
  } finally {
    conn.release();
  }
});

app.delete("/api/bank-recon/matches/:id", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [rows] = await conn.execute(
      `SELECT m.*, s.status AS sessionStatus
       FROM bank_recon_matches m
       JOIN bank_recon_sessions s ON s.id = m.session_id
       WHERE m.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Match not found" });
    }

    const match = rows[0];

    if (match.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (match.status !== "CONFIRMED") {
      return res.status(400).json({ message: "Only confirmed matches can be unmatched" });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_matches SET status = 'REJECTED', unmatched_by = ?, unmatched_at = NOW() WHERE id = ?",
      [userId, id]
    );

    await conn.execute(
      "UPDATE bank_recon_statement_lines SET match_status = 'UNMATCHED' WHERE id = ?",
      [match.statement_line_id]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "MATCH",
      entityId: Number(id),
      action: "UNMATCH",
      description: `Unmatched statement line #${match.statement_line_id} from ${match.book_source_type} #${match.book_source_id}`,
      beforeData: { status: match.status },
      afterData: { status: "REJECTED" },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, message: "Match unmatched" });
  } catch (err) {
    await conn.rollback();
    console.error("UNMATCH ERROR:", err);
    res.status(500).json({ message: "Failed to unmatch" });
  } finally {
    conn.release();
  }
});

app.post("/api/bank-recon/statement-lines/:id/ignore", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [rows] = await conn.execute(
      `SELECT sl.id, sl.match_status AS matchStatus, s.status AS sessionStatus
       FROM bank_recon_statement_lines sl
       JOIN bank_recon_sessions s ON s.id = sl.session_id
       WHERE sl.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Statement line not found" });
    }

    const line = rows[0];

    if (line.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (line.matchStatus === "MATCHED") {
      return res
        .status(400)
        .json({ message: "Cannot ignore a matched line - unmatch it first" });
    }

    const nextStatus = line.matchStatus === "IGNORED" ? "UNMATCHED" : "IGNORED";

    await conn.beginTransaction();

    await conn.execute("UPDATE bank_recon_statement_lines SET match_status = ? WHERE id = ?", [
      nextStatus,
      id,
    ]);

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "STATEMENT_LINE",
      entityId: Number(id),
      action: nextStatus === "IGNORED" ? "IGNORE" : "CONFIG_UPDATE",
      description: `Statement line #${id} ${
        nextStatus === "IGNORED" ? "marked as ignored" : "un-ignored"
      }`,
      beforeData: { matchStatus: line.matchStatus },
      afterData: { matchStatus: nextStatus },
      user: req.user,
    });

    await conn.commit();

    res.json({
      success: true,
      status: nextStatus,
      message: nextStatus === "IGNORED" ? "Line ignored" : "Line un-ignored",
    });
  } catch (err) {
    await conn.rollback();
    console.error("IGNORE STATEMENT LINE ERROR:", err);
    res.status(500).json({ message: "Failed to update statement line" });
  } finally {
    conn.release();
  }
});

// ---- Outstanding items (Phase 7, read-only/derived) ----
// Book lines against this bank account with no confirmed bank match, dated
// on or before the period end: a book-side credit (cash left the books but
// hasn't cleared the bank) is an Outstanding Check; a book-side debit
// (cash landed in the books but not yet on the statement) is a Deposit in
// Transit. Both are just the existing book-items list filtered by date and
// bucketed by direction - not a separate computation pass.

app.get("/api/bank-recon/sessions/:id/outstanding-items", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [sessionRows] = await conn.execute(`${BANK_RECON_SESSION_SELECT} WHERE s.id = ?`, [id]);

    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }

    const session = sessionRows[0];

    const bookTxns = await loadBookTransactions(
      conn,
      session.bankAccountId,
      session.bankCoaAccountId,
      session.periodStart,
      session.periodEnd,
      session.dateToleranceDays
    );

    const [confirmedRows] = await conn.execute(
      `SELECT book_source_type AS sourceType, book_source_id AS sourceId, book_line_id AS lineId
       FROM bank_recon_matches
       WHERE session_id = ? AND status = 'CONFIRMED'`,
      [id]
    );
    const confirmedKeys = new Set(
      confirmedRows.map((r) => `${r.sourceType}:${r.sourceId}:${r.lineId ?? ""}`)
    );

    const unmatched = bookTxns.filter(
      (t) =>
        !confirmedKeys.has(`${t.sourceType}:${t.sourceId}:${t.lineId ?? ""}`) &&
        t.date <= session.periodEnd
    );

    res.json({
      outstandingChecks: unmatched.filter((t) => t.direction === "OUT"),
      depositsInTransit: unmatched.filter((t) => t.direction === "IN"),
    });
  } catch (err) {
    console.error("GET OUTSTANDING ITEMS ERROR:", err);
    res.status(500).json({ message: "Failed to load outstanding items" });
  } finally {
    conn.release();
  }
});

// ---- Adjustment suggestions (Phase 7: view/approve/reject; posting to a
// real JV is Phase 8) ----

app.get("/api/bank-recon/sessions/:id/adjustments", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT
        a.id,
        a.statement_line_id AS statementLineId,
        a.adjustment_type AS adjustmentType,
        a.suggested_account_id AS suggestedAccountId,
        a.amount,
        a.description,
        a.status,
        a.jv_id AS jvId,
        a.created_at AS createdAt,
        a.decided_by AS decidedBy,
        a.decided_at AS decidedAt,
        DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate,
        sl.reference_no AS referenceNo,
        sl.check_no AS checkNo
      FROM bank_recon_adjustments a
      JOIN bank_recon_statement_lines sl ON sl.id = a.statement_line_id
      WHERE a.session_id = ?
      ORDER BY a.status = 'PENDING' DESC, sl.txn_date ASC`,
      [id]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET ADJUSTMENTS ERROR:", err);
    res.status(500).json({ message: "Failed to load adjustments" });
  }
});

app.post("/api/bank-recon/sessions/:id/adjustments", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { statementLineId, adjustmentType, suggestedAccountId, amount, description } = req.body;

    if (!statementLineId || !adjustmentType) {
      return res.status(400).json({ message: "statementLineId and adjustmentType are required" });
    }
    if (!["BANK_CHARGE", "INTEREST_INCOME", "OTHER"].includes(adjustmentType)) {
      return res.status(400).json({ message: "Invalid adjustmentType" });
    }

    const [sessionRows] = await conn.execute(
      "SELECT status FROM bank_recon_sessions WHERE id = ?",
      [id]
    );
    if (sessionRows.length === 0) {
      return res.status(404).json({ message: "Reconciliation session not found" });
    }
    if (sessionRows[0].status === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }

    await conn.beginTransaction();

    const [result] = await conn.execute(
      `INSERT INTO bank_recon_adjustments(
        session_id, statement_line_id, adjustment_type, suggested_account_id, amount, description, status
      ) VALUES (?,?,?,?,?,?, 'PENDING')`,
      [
        id,
        statementLineId,
        adjustmentType,
        suggestedAccountId || null,
        Number(amount) || 0,
        description || "",
      ]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "ADJUSTMENT",
      entityId: result.insertId,
      action: "CREATE",
      description: `Adjustment (${adjustmentType}) added for statement line #${statementLineId} in session #${id}`,
      afterData: { adjustmentType, amount, suggestedAccountId },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, id: result.insertId, message: "Adjustment added" });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE ADJUSTMENT ERROR:", err);
    res.status(500).json({ message: "Failed to add adjustment" });
  } finally {
    conn.release();
  }
});

app.post("/api/bank-recon/adjustments/:id/approve", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { adjustmentType, suggestedAccountId, amount, description } = req.body;

    const [rows] = await conn.execute(
      `SELECT a.*, s.status AS sessionStatus
       FROM bank_recon_adjustments a
       JOIN bank_recon_sessions s ON s.id = a.session_id
       WHERE a.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Adjustment not found" });
    }

    const adj = rows[0];

    if (adj.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (adj.status !== "PENDING") {
      return res.status(400).json({ message: `Adjustment is already ${adj.status}` });
    }
    if (!suggestedAccountId && !adj.suggested_account_id) {
      return res.status(400).json({ message: "An account must be selected to approve this adjustment" });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE bank_recon_adjustments SET
        status = 'APPROVED',
        adjustment_type = ?,
        suggested_account_id = ?,
        amount = ?,
        description = ?,
        decided_by = ?,
        decided_at = NOW()
      WHERE id = ?`,
      [
        adjustmentType || adj.adjustment_type,
        suggestedAccountId || adj.suggested_account_id,
        amount !== undefined ? Number(amount) : adj.amount,
        description !== undefined ? description : adj.description,
        userId,
        id,
      ]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "ADJUSTMENT",
      entityId: Number(id),
      action: "APPROVE_ADJUSTMENT",
      description: `Adjustment #${id} approved`,
      beforeData: { status: adj.status },
      afterData: { status: "APPROVED" },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, message: "Adjustment approved" });
  } catch (err) {
    await conn.rollback();
    console.error("APPROVE ADJUSTMENT ERROR:", err);
    res.status(500).json({ message: "Failed to approve adjustment" });
  } finally {
    conn.release();
  }
});

app.post("/api/bank-recon/adjustments/:id/reject", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [rows] = await conn.execute(
      `SELECT a.*, s.status AS sessionStatus
       FROM bank_recon_adjustments a
       JOIN bank_recon_sessions s ON s.id = a.session_id
       WHERE a.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Adjustment not found" });
    }

    const adj = rows[0];

    if (adj.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (adj.status !== "PENDING") {
      return res.status(400).json({ message: `Adjustment is already ${adj.status}` });
    }

    const userId = req.user?.id || null;

    await conn.beginTransaction();

    await conn.execute(
      "UPDATE bank_recon_adjustments SET status = 'REJECTED', decided_by = ?, decided_at = NOW() WHERE id = ?",
      [userId, id]
    );

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "ADJUSTMENT",
      entityId: Number(id),
      action: "REJECT_ADJUSTMENT",
      description: `Adjustment #${id} rejected`,
      beforeData: { status: adj.status },
      afterData: { status: "REJECTED" },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, message: "Adjustment rejected" });
  } catch (err) {
    await conn.rollback();
    console.error("REJECT ADJUSTMENT ERROR:", err);
    res.status(500).json({ message: "Failed to reject adjustment" });
  } finally {
    conn.release();
  }
});

// ---- Adjustment posting to JV (Phase 8) ----
// Only APPROVED adjustments (with an account already picked) can post, and
// only once - the adjustment moves straight to POSTED, never back to
// PENDING/APPROVED, so there is no double-post path.

app.post("/api/bank-recon/adjustments/:id/post", authenticateToken, async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const [rows] = await conn.execute(
      `SELECT a.*, sl.debit AS lineDebit, sl.credit AS lineCredit,
              sl.reference_no AS lineReferenceNo, sl.check_no AS lineCheckNo,
              DATE_FORMAT(sl.txn_date, '%Y-%m-%d') AS txnDate,
              s.status AS sessionStatus, s.bank_account_id AS bankAccountId
       FROM bank_recon_adjustments a
       JOIN bank_recon_statement_lines sl ON sl.id = a.statement_line_id
       JOIN bank_recon_sessions s ON s.id = a.session_id
       WHERE a.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Adjustment not found" });
    }

    const adj = rows[0];

    if (adj.sessionStatus === "FINALIZED") {
      return res.status(400).json({ message: "Cannot modify a finalized session" });
    }
    if (adj.status !== "APPROVED") {
      return res
        .status(400)
        .json({ message: `Adjustment must be APPROVED before posting (currently ${adj.status})` });
    }
    if (!adj.suggested_account_id) {
      return res.status(400).json({ message: "Adjustment has no account assigned" });
    }

    const [bankRows] = await conn.execute(
      "SELECT coa_account_id AS coaAccountId, coa_code AS coaCode, bank_name AS bankName FROM bank_codes WHERE id = ?",
      [adj.bankAccountId]
    );

    if (bankRows.length === 0 || !bankRows[0].coaAccountId) {
      return res
        .status(400)
        .json({ message: "Bank account has no linked Chart of Accounts entry" });
    }

    const bank = bankRows[0];

    const [accountRows] = await conn.execute(
      "SELECT code, title FROM chart_of_accounts WHERE id = ?",
      [adj.suggested_account_id]
    );

    if (accountRows.length === 0) {
      return res.status(400).json({ message: "Selected account not found" });
    }

    const account = accountRows[0];
    const isMoneyOut = Number(adj.lineDebit) > 0;
    const amount = Number(adj.amount);
    const userId = req.user?.id || null;
    const voucherNo = `JV-BR-${adj.session_id}-${adj.id}`;

    await conn.beginTransaction();

    const [jvResult] = await conn.execute(
      `INSERT INTO jv_headers(
        voucher_no, transaction_date, reference_no, prepared_for, description,
        total_debit, total_credit, status, source_module, source_reference_id,
        created_by, posted_by, posted_at
      ) VALUES (?,?,?,?,?,?,?, 'Posted', 'BANK_RECON', ?, ?, ?, NOW())`,
      [
        voucherNo,
        adj.txnDate,
        adj.lineReferenceNo || adj.lineCheckNo || "",
        bank.bankName,
        adj.description || `Bank reconciliation adjustment (${adj.adjustment_type})`,
        amount,
        amount,
        Number(id),
        userId,
        userId,
      ]
    );

    const jvId = jvResult.insertId;

    // Money-out (bank charge, etc.): debit the suggested account, credit the
    // bank. Money-in (interest, etc.): debit the bank, credit the suggested
    // account.
    const lines = isMoneyOut
      ? [
          { accountId: adj.suggested_account_id, code: account.code, title: account.title, debit: amount, credit: 0 },
          { accountId: bank.coaAccountId, code: bank.coaCode, title: bank.bankName, debit: 0, credit: amount },
        ]
      : [
          { accountId: bank.coaAccountId, code: bank.coaCode, title: bank.bankName, debit: amount, credit: 0 },
          { accountId: adj.suggested_account_id, code: account.code, title: account.title, debit: 0, credit: amount },
        ];

    for (const line of lines) {
      await conn.execute(
        `INSERT INTO jv_lines(jv_id, account_id, account_code, account_title, particulars, debit, credit)
         VALUES (?,?,?,?,?,?,?)`,
        [jvId, line.accountId, line.code, line.title, adj.description || "", line.debit, line.credit]
      );
    }

    await conn.execute("UPDATE bank_recon_adjustments SET status = 'POSTED', jv_id = ? WHERE id = ?", [
      jvId,
      id,
    ]);

    await logAudit(conn, {
      module: "JV",
      entityType: "JV",
      entityId: jvId,
      action: "POST",
      description: `JV ${voucherNo} created and posted from bank reconciliation adjustment #${id}`,
      afterData: { voucherNo, amount, sourceModule: "BANK_RECON", sourceReferenceId: Number(id) },
      user: req.user,
    });

    await logAudit(conn, {
      module: "BANK_RECON",
      entityType: "ADJUSTMENT",
      entityId: Number(id),
      action: "POST_JV",
      description: `Adjustment #${id} posted as JV ${voucherNo} (#${jvId})`,
      beforeData: { status: "APPROVED" },
      afterData: { status: "POSTED", jvId },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, jvId, voucherNo, message: "Adjustment posted as JV" });
  } catch (err) {
    await conn.rollback();
    console.error("POST ADJUSTMENT ERROR:", err);
    res.status(500).json({ message: "Failed to post adjustment" });
  } finally {
    conn.release();
  }
});

// ===================== ACCOUNT GROUP CODES API =====================

app.get("/api/group-codes", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        group_code AS groupCode,
        group_description AS groupDescription,
        account_class AS accountClass,
        status
      FROM account_group_codes
      ORDER BY group_code ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET GROUP CODES ERROR:", err);
    res.status(500).json({ message: "Failed to load group codes" });
  }
});

app.post("/api/group-codes", async (req, res) => {
  try {
    const { groupCode, groupDescription, accountClass, status } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO account_group_codes
       (group_code, group_description, account_class, status)
       VALUES (?, ?, ?, ?)`,
      [
        groupCode,
        groupDescription,
        accountClass || "",
        status || "ACTIVE",
      ]
    );

    res.json({
      success: true,
      message: "Group code created successfully",
      id: result.insertId,
    });
  } catch (err) {
    console.error("CREATE GROUP CODE ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Group code already exists" });
    }

    res.status(500).json({ message: "Failed to create group code" });
  }
});

app.put("/api/group-codes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { groupCode, groupDescription, accountClass, status } = req.body;

    await pool.execute(
      `UPDATE account_group_codes SET
        group_code = ?,
        group_description = ?,
        account_class = ?,
        status = ?
       WHERE id = ?`,
      [
        groupCode,
        groupDescription,
        accountClass || "",
        status || "ACTIVE",
        id,
      ]
    );

    res.json({
      success: true,
      message: "Group code updated successfully",
    });
  } catch (err) {
    console.error("UPDATE GROUP CODE ERROR:", err);
    res.status(500).json({ message: "Failed to update group code" });
  }
});

app.delete("/api/group-codes/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute("DELETE FROM account_group_codes WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Group code deleted successfully",
    });
  } catch (err) {
    console.error("DELETE GROUP CODE ERROR:", err);
    res.status(500).json({ message: "Failed to delete group code" });
  }
});

app.get("/api/arap-beginning-balances/:type", async (req, res) => {
  try {
    const { type } = req.params;

    const [rows] = await pool.execute(
      `
      SELECT
        l.id,
        h.balance_type AS balanceType,
        DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS balanceDate,
        h.currency_code AS currencyCode,
        h.currency_name AS currencyName,
        l.party_id AS partyId,
        l.party_code AS partyCode,
        l.party_name AS partyName,
        l.account_id AS accountId,
        l.account_code AS accountCode,
        l.account_title AS accountTitle,
        l.reference_no AS referenceNo,
        DATE_FORMAT(l.due_date, '%Y-%m-%d') AS dueDate,
        l.debit,
        l.credit,
        l.balance_amount AS balanceAmount,
        l.paid_amount AS paidAmount,
        l.status,
        DATE_FORMAT(s.schedule_date, '%Y-%m-%d') AS scheduleDate
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
      LEFT JOIN arap_payment_schedules s ON s.beginning_balance_line_id = l.id
      WHERE h.balance_type = ?
      ORDER BY l.id DESC
      `,
      [type]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET ARAP BB ERROR:", err);
    res.status(500).json({ message: "Failed to load AR/AP beginning balances" });
  }
});

app.post("/api/arap-beginning-balances", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      balanceType,
      balanceDate,
      currencyCode,
      currencyName,
      remarks,
      line,
    } = req.body;

    await conn.beginTransaction();

    const [headerResult] = await conn.execute(
      `
      INSERT INTO arap_beginning_balance_headers
      (balance_type, balance_date, currency_code, currency_name, remarks, status)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        balanceType,
        balanceDate,
        currencyCode || "PHP",
        currencyName || "PHILIPPINE PESO",
        remarks || "",
        "Posted",
      ]
    );

    const headerId = headerResult.insertId;

    const [lineResult] = await conn.execute(
      `
      INSERT INTO arap_beginning_balance_lines
      (
        header_id,
        party_id,
        party_code,
        party_name,
        account_id,
        account_code,
        account_title,
        reference_no,
        due_date,
        debit,
        credit,
        balance_amount,
        paid_amount,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        headerId,
        line.partyId || null,
        line.partyCode || "",
        line.partyName || "",
        line.accountId || null,
        line.accountCode || "",
        line.accountTitle || "",
        line.referenceNo || "",
        line.dueDate || null,
        Number(line.debit) || 0,
        Number(line.credit) || 0,
        Number(line.balanceAmount) || 0,
        0,
        "Unpaid",
      ]
    );

    const lineId = lineResult.insertId;

    await conn.execute(
      `
      INSERT INTO arap_payment_schedules
      (
        beginning_balance_line_id,
        schedule_date,
        amount,
        paid_amount,
        balance_amount,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        lineId,
        line.scheduleDate || line.dueDate || balanceDate,
        Number(line.scheduleAmount || line.balanceAmount) || 0,
        0,
        Number(line.scheduleAmount || line.balanceAmount) || 0,
        "Unpaid",
      ]
    );

    await conn.commit();

    res.json({ success: true, message: "Beginning balance saved successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("SAVE ARAP BB ERROR:", err);
    res.status(500).json({ message: "Failed to save AR/AP beginning balance" });
  } finally {
    conn.release();
  }
});

app.put("/api/arap-beginning-balances", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { line } = req.body;

    await conn.beginTransaction();

    await conn.execute(
      `
      UPDATE arap_beginning_balance_lines SET
        party_id = ?,
        party_code = ?,
        party_name = ?,
        account_id = ?,
        account_code = ?,
        account_title = ?,
        reference_no = ?,
        due_date = ?,
        debit = ?,
        credit = ?,
        balance_amount = ?
      WHERE id = ?
      `,
      [
        line.partyId || null,
        line.partyCode || "",
        line.partyName || "",
        line.accountId || null,
        line.accountCode || "",
        line.accountTitle || "",
        line.referenceNo || "",
        line.dueDate || null,
        Number(line.debit) || 0,
        Number(line.credit) || 0,
        Number(line.balanceAmount) || 0,
        line.id,
      ]
    );

    await conn.execute(
      `
      UPDATE arap_payment_schedules SET
        schedule_date = ?,
        amount = ?,
        balance_amount = ?
      WHERE beginning_balance_line_id = ?
      `,
      [
        line.scheduleDate || line.dueDate || null,
        Number(line.scheduleAmount || line.balanceAmount) || 0,
        Number(line.scheduleAmount || line.balanceAmount) || 0,
        line.id,
      ]
    );

    await conn.commit();

    res.json({ success: true, message: "Beginning balance updated successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE ARAP BB ERROR:", err);
    res.status(500).json({ message: "Failed to update AR/AP beginning balance" });
  } finally {
    conn.release();
  }
});

app.delete("/api/arap-beginning-balances/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute(
      `DELETE FROM arap_beginning_balance_lines WHERE id = ?`,
      [id]
    );

    res.json({ success: true, message: "Beginning balance removed successfully" });
  } catch (err) {
    console.error("DELETE ARAP BB ERROR:", err);
    res.status(500).json({ message: "Failed to remove beginning balance" });
  }
});


// ====================== TRIAL BALANCE REPORT =================

app.get("/api/reports/trial-balance", async (req, res) => {
  try {
    const { from, to } = req.query;

    const params = [];
    let dateFilterAPV = "";
    let dateFilterCV = "";
    let dateFilterARAP = "";
    let dateFilterJV = "";

    if (from && to) {
      dateFilterAPV = "WHERE h.transaction_date BETWEEN ? AND ?";
      dateFilterCV = "WHERE h.transaction_date BETWEEN ? AND ?";
      dateFilterARAP = "WHERE h.balance_date BETWEEN ? AND ?";
      dateFilterJV = "WHERE h.transaction_date BETWEEN ? AND ?";
      params.push(from, to, from, to, from, to, from, to);
    }

    const [rows] = await pool.execute(
      `
      SELECT
        tb.account_code,
        tb.account_name,
    CASE
  WHEN UPPER(TRIM(c.account_class)) = 'ASSET' THEN 'A'
  WHEN UPPER(TRIM(c.account_class)) IN ('LIABILITY', 'LIABILITIES') THEN 'L'
  WHEN UPPER(TRIM(c.account_class)) = 'INCOME' THEN 'I'
  WHEN UPPER(TRIM(c.account_class)) IN ('CAPITAL', 'EQUITY') THEN 'C'
  WHEN UPPER(TRIM(c.account_class)) = 'EXPENSE' THEN 'E'
  ELSE ''
END AS account_class,
        CASE
          WHEN SUM(tb.debit) - SUM(tb.credit) > 0
          THEN SUM(tb.debit) - SUM(tb.credit)
          ELSE 0
        END AS debit,
        CASE
          WHEN SUM(tb.credit) - SUM(tb.debit) > 0
          THEN SUM(tb.credit) - SUM(tb.debit)
          ELSE 0
        END AS credit
      FROM (
        SELECT
          l.account_code,
          l.account_title AS account_name,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM apv_lines l
        JOIN apv_headers h ON h.id = l.apv_id
        ${dateFilterAPV}

        UNION ALL

        SELECT
          l.account_code,
          l.account_title AS account_name,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM cv_lines l
        JOIN cv_headers h ON h.id = l.cv_id
        ${dateFilterCV}

        UNION ALL

        SELECT
          l.account_code,
          l.account_title AS account_name,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        ${dateFilterARAP}

        UNION ALL

        SELECT
          l.account_code,
          l.account_title AS account_name,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM jv_lines l
        JOIN jv_headers h ON h.id = l.jv_id
        ${dateFilterJV}
      ) tb
      LEFT JOIN chart_of_accounts c 
  ON TRIM(CAST(c.code AS CHAR)) = TRIM(CAST(tb.account_code AS CHAR))
      WHERE tb.account_code IS NOT NULL
        AND tb.account_code != ''
      GROUP BY tb.account_code, tb.account_name, c.account_class
      HAVING debit != 0 OR credit != 0
      ORDER BY tb.account_code ASC
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("TRIAL BALANCE REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate trial balance",
      error: err.message,
    });
  }
});

// ====================== ACCOUNT ANALYSIS REPORT =================

app.get("/api/reports/account-analysis", async (req, res) => {
  try {
    const { from, to, accountCode } = req.query;

    if (!accountCode) {
      return res.status(400).json({ message: "Account code is required" });
    }

    const params = [
      accountCode,
      from,
      to,

      accountCode,
      from,
      to,

      accountCode,
      from,
      to,
    ];

    const [rows] = await pool.execute(
      `
      SELECT
        transaction_date,
        source_type,
        reference_no,
        transaction_id,
        account_code,
        account_title,
        particulars,
        debit,
        credit,
        SUM(debit - credit) OVER (
          ORDER BY transaction_date, sort_order, id
        ) AS running_balance
      FROM (
        SELECT
          l.id,
          DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
          'APV' AS source_type,
          h.voucher_no AS reference_no,
          h.id AS transaction_id,
          l.account_code,
          l.account_title,
          COALESCE(l.particulars, h.description, '') AS particulars,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit,
          1 AS sort_order
        FROM apv_lines l
        JOIN apv_headers h ON h.id = l.apv_id
        WHERE l.account_code = ?
          AND h.transaction_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          l.id,
          DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
          'CV' AS source_type,
          h.voucher_no AS reference_no,
          h.id AS transaction_id,
          l.account_code,
          l.account_title,
          COALESCE(l.particulars, h.description, '') AS particulars,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit,
          2 AS sort_order
        FROM cv_lines l
        JOIN cv_headers h ON h.id = l.cv_id
        WHERE l.account_code = ?
          AND h.transaction_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          l.id,
          DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
          h.balance_type AS source_type,
          l.reference_no AS reference_no,
          NULL AS transaction_id,
          l.account_code,
          l.account_title,
          COALESCE(l.party_name, '') AS particulars,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit,
          3 AS sort_order
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE l.account_code = ?
          AND h.balance_date BETWEEN ? AND ?
      ) aa
      ORDER BY transaction_date, sort_order, id
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("ACCOUNT ANALYSIS REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate account analysis",
      error: err.message,
    });
  }
});

// ====================== OUTPUT VAT REPORT =================

app.get("/api/reports/output-vat", async (req, res) => {
  try {
    const { from, to, accountCode } = req.query;

    if (!accountCode) {
      return res.status(400).json({ message: "Account code is required" });
    }

    const params = [accountCode, from, to, accountCode, from, to];

    const [rows] = await pool.execute(
      `
      SELECT
        transaction_date,
        source_type,
        reference_no,
        transaction_id,
        account_code,
        account_title,
        particulars,
        debit,
        credit,
        SUM(debit - credit) OVER (
          ORDER BY transaction_date, sort_order, id
        ) AS running_balance
      FROM (
        SELECT
          l.id,
          DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
          'INV' AS source_type,
          h.voucher_no AS reference_no,
          h.id AS transaction_id,
          l.account_code,
          l.account_title,
          COALESCE(l.particulars, h.description, '') AS particulars,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit,
          1 AS sort_order
        FROM invoice_lines l
        JOIN invoice_headers h ON h.id = l.invoice_id
        WHERE l.account_code = ?
          AND h.transaction_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          l.id,
          DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
          'OR' AS source_type,
          h.voucher_no AS reference_no,
          h.id AS transaction_id,
          l.account_code,
          l.account_title,
          COALESCE(l.particulars, h.description, '') AS particulars,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit,
          2 AS sort_order
        FROM or_lines l
        JOIN or_headers h ON h.id = l.or_id
        WHERE l.account_code = ?
          AND h.transaction_date BETWEEN ? AND ?
      ) ov
      ORDER BY transaction_date, sort_order, id
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("OUTPUT VAT REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate output VAT report",
      error: err.message,
    });
  }
});

// ====================== INCOME STATEMENT REPORT ======================

app.get("/api/reports/income-statement", async (req, res) => {
  try {
    const { from, to } = req.query;

    const params = [from, to, from, to, from, to, from, to];

    const [rows] = await pool.execute(
      `
      SELECT
        ag.group_description AS group_name,
        ca.code AS account_code,
        ca.title AS account_title,
        ca.account_class,
        COALESCE(SUM(tx.credit - tx.debit), 0) AS amount
      FROM chart_of_accounts ca
      JOIN coa_groups cg ON cg.coa_id = ca.id
      JOIN account_group_codes ag ON ag.group_code = cg.group_code
      LEFT JOIN (
        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM apv_lines l
        JOIN apv_headers h ON h.id = l.apv_id
        WHERE h.transaction_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM cv_lines l
        JOIN cv_headers h ON h.id = l.cv_id
        WHERE h.transaction_date BETWEEN ? AND ?

        UNION ALL

          SELECT
  l.account_code,
  COALESCE(l.othrdebit, 0) AS debit,
  COALESCE(l.othrcredit, 0) AS credit
FROM gl_beginning_balance_lines l
JOIN gl_beginning_balance_headers h ON h.id = l.header_id
WHERE h.balance_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_date BETWEEN ? AND ?
      ) tx ON TRIM(tx.account_code) = TRIM(ca.code)
      WHERE UPPER(ag.group_description) IN ('REVENUE', 'EXPENSES', 'EXPENSE')
         OR UPPER(ca.account_class) IN ('INCOME', 'EXPENSE')
      GROUP BY
        ag.group_description,
        ca.code,
        ca.title,
        ca.account_class
      ORDER BY
        CASE
          WHEN UPPER(ag.group_description) = 'REVENUE' THEN 1
          WHEN UPPER(ca.account_class) = 'INCOME' THEN 1
          WHEN UPPER(ag.group_description) IN ('EXPENSES', 'EXPENSE') THEN 2
          WHEN UPPER(ca.account_class) = 'EXPENSE' THEN 2
          ELSE 9
        END,
        ca.code ASC
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("INCOME STATEMENT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate income statement",
      error: err.message,
    });
  }
});


// ====================== BALANCE SHEET REPORT ======================

app.get("/api/reports/balance-sheet", async (req, res) => {
  try {
    const { to } = req.query;

    const params = [to, to, to, to];

    const [rows] = await pool.execute(
      `
      SELECT
        ag.group_description AS group_name,
        ca.code AS account_code,
        ca.title AS account_title,
        ca.account_class,
        CASE
          WHEN UPPER(ca.account_class) = 'ASSET'
            THEN COALESCE(SUM(tx.debit - tx.credit), 0)
          ELSE COALESCE(SUM(tx.credit - tx.debit), 0)
        END AS amount
      FROM chart_of_accounts ca
      JOIN coa_groups cg ON cg.coa_id = ca.id
      JOIN account_group_codes ag ON ag.group_code = cg.group_code
      LEFT JOIN (
        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM apv_lines l
        JOIN apv_headers h ON h.id = l.apv_id
        WHERE h.transaction_date <= ?

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM cv_lines l
        JOIN cv_headers h ON h.id = l.cv_id
        WHERE h.transaction_date <= ?

        UNION ALL

        SELECT
  l.account_code,
  COALESCE(l.othrdebit, 0) AS debit,
  COALESCE(l.othrcredit, 0) AS credit
FROM gl_beginning_balance_lines l
JOIN gl_beginning_balance_headers h ON h.id = l.header_id
WHERE h.balance_date <= ?

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_date <= ?
      ) tx ON TRIM(tx.account_code) = TRIM(ca.code)
      WHERE UPPER(ag.group_description) IN ('ASSETS', 'ASSET', 'LIABILITIES', 'LIABILITY', 'EQUITY', 'CAPITAL')
         OR UPPER(ca.account_class) IN ('ASSET', 'LIABILITY', 'LIABILITIES', 'EQUITY', 'CAPITAL')
      GROUP BY
        ag.group_description,
        ca.code,
        ca.title,
        ca.account_class
      ORDER BY
        CASE
          WHEN UPPER(ag.group_description) IN ('ASSETS', 'ASSET') THEN 1
          WHEN UPPER(ag.group_description) IN ('LIABILITIES', 'LIABILITY') THEN 2
          WHEN UPPER(ag.group_description) IN ('EQUITY', 'CAPITAL') THEN 3
          ELSE 9
        END,
        ca.code ASC
      `,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error("BALANCE SHEET ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate balance sheet",
      error: err.message,
    });
  }
});

// ====================== AGING REPORT ======================
app.get("/api/reports/aging", async (req, res) => {
  try {
    const { type = "AP", asOf } = req.query;
    const reportType = String(type).toUpperCase();
    const reportDate = asOf || new Date().toISOString().split("T")[0];

    if (!["AP", "AR"].includes(reportType)) {
      return res.status(400).json({ message: "Invalid aging type. Use AP or AR." });
    }

    let rows = [];

    if (reportType === "AP") {
      const [apvRows] = await pool.execute(
        `
        SELECT
          'APV' AS sourceType,
          id,
          voucher_no AS referenceNo,
          supplier_id AS partyId,
          supplier_name AS partyName,
          DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
          DATE_FORMAT(due_date, '%Y-%m-%d') AS dueDate,
          total_credit AS totalAmount,
          COALESCE(paid_amount, 0) AS paidAmount,
          COALESCE(balance_amount, total_credit, 0) AS balanceAmount,
          GREATEST(DATEDIFF(?, COALESCE(due_date, transaction_date)), 0) AS daysPastDue
        FROM apv_headers
        WHERE COALESCE(balance_amount, total_credit, 0) > 0
          AND COALESCE(payment_status, 'Unpaid') != 'Paid'
        `,
        [reportDate]
      );

      rows = rows.concat(apvRows);
    }

    const [bbRows] = await pool.execute(
      `
      SELECT
        h.balance_type AS sourceType,
        l.id,
        l.reference_no AS referenceNo,
        l.party_id AS partyId,
        l.party_name AS partyName,
        DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transactionDate,
        DATE_FORMAT(l.due_date, '%Y-%m-%d') AS dueDate,
        CASE WHEN h.balance_type = 'AR' THEN l.debit ELSE l.credit END AS totalAmount,
        COALESCE(l.paid_amount, 0) AS paidAmount,
        COALESCE(
          l.balance_amount,
          CASE WHEN h.balance_type = 'AR' THEN l.debit ELSE l.credit END,
          0
        ) AS balanceAmount,
        GREATEST(DATEDIFF(?, COALESCE(l.due_date, h.balance_date)), 0) AS daysPastDue
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
      WHERE h.balance_type = ?
        AND COALESCE(
          l.balance_amount,
          CASE WHEN h.balance_type = 'AR' THEN l.debit ELSE l.credit END,
          0
        ) > 0
        AND COALESCE(l.status, 'Unpaid') != 'Paid'
      `,
      [reportDate, reportType]
    );

    rows = rows.concat(bbRows);

    const mappedRows = rows.map((row) => {
      const balance = Number(row.balanceAmount || 0);
      const days = Number(row.daysPastDue || 0);

      return {
        ...row,
        current: days === 0 ? balance : 0,
        days1To30: days >= 1 && days <= 30 ? balance : 0,
        days31To60: days >= 31 && days <= 60 ? balance : 0,
        days61To90: days >= 61 && days <= 90 ? balance : 0,
        over90: days > 90 ? balance : 0,
      };
    });

    res.json(mappedRows);
  } catch (err) {
    console.error("AGING REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate aging report",
      error: err.message,
    });
  }
});

// ====================== AP AGING REPORT ======================
app.get("/api/reports/ap-aging", async (req, res) => {
  try {
    const { asOf } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);

    const [rows] = await pool.execute(
      `
      SELECT
        source_type,
        id,
        reference_no,
        party_name,
        transaction_date,
        due_date,
        total_amount,
        paid_amount,
        balance_amount,
        days_past_due
      FROM (
        SELECT
          'APV' AS source_type,
          id,
          voucher_no AS reference_no,
          supplier_name AS party_name,
          DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
          DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date,
          total_credit AS total_amount,
          COALESCE(paid_amount, 0) AS paid_amount,
          COALESCE(balance_amount, total_credit, 0) AS balance_amount,
          GREATEST(DATEDIFF(?, COALESCE(due_date, transaction_date)), 0) AS days_past_due
        FROM apv_headers
        WHERE COALESCE(balance_amount, total_credit, 0) > 0
          AND COALESCE(payment_status, 'Unpaid') != 'Paid'

        UNION ALL

        SELECT
          'AP BEGINNING' AS source_type,
          l.id,
          l.reference_no,
          l.party_name,
          DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
          DATE_FORMAT(l.due_date, '%Y-%m-%d') AS due_date,
          l.credit AS total_amount,
          COALESCE(l.paid_amount, 0) AS paid_amount,
          COALESCE(l.balance_amount, l.credit, 0) AS balance_amount,
          GREATEST(DATEDIFF(?, COALESCE(l.due_date, h.balance_date)), 0) AS days_past_due
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_type = 'AP'
          AND COALESCE(l.balance_amount, l.credit, 0) > 0
          AND COALESCE(l.status, 'Unpaid') != 'Paid'
      ) aging
      ORDER BY party_name ASC, due_date ASC
      `,
      [reportDate, reportDate]
    );

    res.json(rows);
  } catch (err) {
    console.error("AP AGING REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate AP aging report",
      error: err.message,
    });
  }
});


// ====================== AR AGING REPORT ======================
app.get("/api/reports/ar-aging", async (req, res) => {
  try {
    const { asOf } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);

    const [rows] = await pool.execute(
      `
      SELECT
        source_type,
        id,
        reference_no,
        party_name,
        transaction_date,
        due_date,
        total_amount,
        paid_amount,
        balance_amount,
        days_past_due
      FROM (
        SELECT
          'INV' AS source_type,
          id,
          voucher_no AS reference_no,
          customer_name AS party_name,
          DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
          DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date,
          total_debit AS total_amount,
          COALESCE(paid_amount, 0) AS paid_amount,
          COALESCE(balance_amount, total_debit, 0) AS balance_amount,
          GREATEST(DATEDIFF(?, COALESCE(due_date, transaction_date)), 0) AS days_past_due
        FROM invoice_headers
        WHERE COALESCE(balance_amount, total_debit, 0) > 0
          AND COALESCE(payment_status, 'Unpaid') != 'Paid'

        UNION ALL

        SELECT
          'AR BEGINNING' AS source_type,
          l.id,
          l.reference_no,
          l.party_name,
          DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
          DATE_FORMAT(l.due_date, '%Y-%m-%d') AS due_date,
          l.debit AS total_amount,
          COALESCE(l.paid_amount, 0) AS paid_amount,
          COALESCE(l.balance_amount, l.debit, 0) AS balance_amount,
          GREATEST(DATEDIFF(?, COALESCE(l.due_date, h.balance_date)), 0) AS days_past_due
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_type = 'AR'
          AND COALESCE(l.balance_amount, l.debit, 0) > 0
          AND COALESCE(l.status, 'Unpaid') != 'Paid'
      ) aging
      ORDER BY party_name ASC, due_date ASC
      `,
      [reportDate, reportDate]
    );

    res.json(rows);
  } catch (err) {
    console.error("AR AGING REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate AR aging report",
      error: err.message,
    });
  }
});

// ====================== SUBSIDIARY LEDGER REPORT ======================

app.get("/api/reports/subsidiary-ledger", async (req, res) => {
  try {
    const { type, partyId, from, to } = req.query;

    if (!type || !["AR", "AP"].includes(type)) {
      return res.status(400).json({ message: "type must be AR or AP" });
    }

    if (!partyId) {
      return res.status(400).json({ message: "partyId is required" });
    }

    const query =
      type === "AR"
        ? `
      SELECT
        transaction_date, source_type, reference_no, transaction_id, particulars, debit, credit,
        SUM(debit - credit) OVER (ORDER BY transaction_date, sort_order, id) AS running_balance
      FROM (
        SELECT
          id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
          'INV' AS source_type, voucher_no AS reference_no, id AS transaction_id,
          COALESCE(description, '') AS particulars,
          COALESCE(total_debit, 0) AS debit, 0 AS credit, 1 AS sort_order
        FROM invoice_headers
        WHERE customer_id = ? AND transaction_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
          'OR' AS source_type, voucher_no AS reference_no, id AS transaction_id,
          COALESCE(description, '') AS particulars,
          0 AS debit, COALESCE(total_debit, 0) AS credit, 2 AS sort_order
        FROM or_headers
        WHERE customer_id = ? AND transaction_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
          'AR BEGINNING' AS source_type, l.reference_no, NULL AS transaction_id,
          COALESCE(l.party_name, '') AS particulars,
          COALESCE(l.debit, 0) AS debit, 0 AS credit, 0 AS sort_order
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_type = ? AND l.party_id = ? AND h.balance_date BETWEEN ? AND ?
      ) sl
      ORDER BY transaction_date, sort_order, id
      `
        : `
      SELECT
        transaction_date, source_type, reference_no, transaction_id, particulars, debit, credit,
        SUM(credit - debit) OVER (ORDER BY transaction_date, sort_order, id) AS running_balance
      FROM (
        SELECT
          id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
          'CV' AS source_type, voucher_no AS reference_no, id AS transaction_id,
          COALESCE(description, '') AS particulars,
          COALESCE(total_credit, 0) AS debit, 0 AS credit, 2 AS sort_order
        FROM cv_headers
        WHERE payee_id = ? AND transaction_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
          'APV' AS source_type, voucher_no AS reference_no, id AS transaction_id,
          COALESCE(description, '') AS particulars,
          0 AS debit, COALESCE(total_credit, 0) AS credit, 1 AS sort_order
        FROM apv_headers
        WHERE supplier_id = ? AND transaction_date BETWEEN ? AND ?

        UNION ALL

        SELECT
          l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
          'AP BEGINNING' AS source_type, l.reference_no, NULL AS transaction_id,
          COALESCE(l.party_name, '') AS particulars,
          0 AS debit, COALESCE(l.credit, 0) AS credit, 0 AS sort_order
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_type = ? AND l.party_id = ? AND h.balance_date BETWEEN ? AND ?
      ) sl
      ORDER BY transaction_date, sort_order, id
      `;

    const queryParams =
      type === "AR"
        ? [partyId, from, to, partyId, from, to, "AR", partyId, from, to]
        : [partyId, from, to, partyId, from, to, "AP", partyId, from, to];

    const [rows] = await pool.execute(query, queryParams);

    res.json(rows);
  } catch (err) {
    console.error("SUBSIDIARY LEDGER REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate subsidiary ledger",
      error: err.message,
    });
  }
});

// ===================== FIXED ASSET API =====================

app.get("/api/fixed-assets", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        asset_code AS assetCode,
        asset_name AS assetName,
        category,
        DATE_FORMAT(acquisition_date, '%Y-%m-%d') AS acquisitionDate,
        acquisition_cost AS acquisitionCost,
        salvage_value AS salvageValue,
        useful_life_years AS usefulLifeYears,
        depreciation_method AS depreciationMethod,
        asset_account_code AS assetAccountCode,
        status,
        DATE_FORMAT(disposal_date, '%Y-%m-%d') AS disposalDate
      FROM fixed_assets
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET FIXED ASSETS ERROR:", err);
    res.status(500).json({ message: "Failed to load fixed assets" });
  }
});

app.post("/api/fixed-assets", async (req, res) => {
  try {
    const {
      assetCode,
      assetName,
      category,
      acquisitionDate,
      acquisitionCost,
      salvageValue,
      usefulLifeYears,
      depreciationMethod,
      assetAccountCode,
      status,
    } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO fixed_assets (
        asset_code, asset_name, category, acquisition_date, acquisition_cost,
        salvage_value, useful_life_years, depreciation_method, asset_account_code, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetCode || "",
        assetName || "",
        category || "",
        acquisitionDate || null,
        Number(acquisitionCost) || 0,
        Number(salvageValue) || 0,
        Number(usefulLifeYears) || 5,
        depreciationMethod || "STRAIGHT_LINE",
        assetAccountCode || "",
        status || "Active",
      ]
    );

    res.json({ success: true, message: "Fixed asset saved successfully", id: result.insertId });
  } catch (err) {
    console.error("CREATE FIXED ASSET ERROR:", err);
    res.status(500).json({ message: "Failed to save fixed asset" });
  }
});

app.put("/api/fixed-assets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      assetCode,
      assetName,
      category,
      acquisitionDate,
      acquisitionCost,
      salvageValue,
      usefulLifeYears,
      depreciationMethod,
      assetAccountCode,
      status,
      disposalDate,
    } = req.body;

    await pool.execute(
      `UPDATE fixed_assets SET
        asset_code = ?, asset_name = ?, category = ?, acquisition_date = ?,
        acquisition_cost = ?, salvage_value = ?, useful_life_years = ?,
        depreciation_method = ?, asset_account_code = ?, status = ?, disposal_date = ?
      WHERE id = ?`,
      [
        assetCode || "",
        assetName || "",
        category || "",
        acquisitionDate || null,
        Number(acquisitionCost) || 0,
        Number(salvageValue) || 0,
        Number(usefulLifeYears) || 5,
        depreciationMethod || "STRAIGHT_LINE",
        assetAccountCode || "",
        status || "Active",
        disposalDate || null,
        id,
      ]
    );

    res.json({ success: true, message: "Fixed asset updated successfully" });
  } catch (err) {
    console.error("UPDATE FIXED ASSET ERROR:", err);
    res.status(500).json({ message: "Failed to update fixed asset" });
  }
});

app.delete("/api/fixed-assets/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute("DELETE FROM fixed_assets WHERE id = ?", [id]);
    res.json({ success: true, message: "Fixed asset deleted successfully" });
  } catch (err) {
    console.error("DELETE FIXED ASSET ERROR:", err);
    res.status(500).json({ message: "Failed to delete fixed asset" });
  }
});

// ====================== FIXED ASSET REGISTER REPORT ======================

app.get("/api/reports/fixed-asset-register", async (req, res) => {
  try {
    const { asOf } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);

    const [rows] = await pool.execute(
      `
      SELECT
        id,
        asset_code AS assetCode,
        asset_name AS assetName,
        category,
        DATE_FORMAT(acquisition_date, '%Y-%m-%d') AS acquisitionDate,
        acquisition_cost AS acquisitionCost,
        salvage_value AS salvageValue,
        useful_life_years AS usefulLifeYears,
        status,
        ROUND((acquisition_cost - salvage_value) / (useful_life_years * 12), 2) AS monthlyDepreciation,
        LEAST(
          ROUND((acquisition_cost - salvage_value) / (useful_life_years * 12), 2) *
            LEAST(GREATEST(TIMESTAMPDIFF(MONTH, acquisition_date, ?), 0), useful_life_years * 12),
          acquisition_cost - salvage_value
        ) AS accumulatedDepreciation,
        acquisition_cost - LEAST(
          ROUND((acquisition_cost - salvage_value) / (useful_life_years * 12), 2) *
            LEAST(GREATEST(TIMESTAMPDIFF(MONTH, acquisition_date, ?), 0), useful_life_years * 12),
          acquisition_cost - salvage_value
        ) AS bookValue
      FROM fixed_assets
      WHERE status = 'Active'
      ORDER BY asset_code ASC
      `,
      [reportDate, reportDate]
    );

    res.json(rows);
  } catch (err) {
    console.error("FIXED ASSET REGISTER REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate fixed asset register", error: err.message });
  }
});

// ===================== PREPAID ACCOUNTS API =====================

app.get("/api/prepaid-accounts", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        prepaid_code AS prepaidCode,
        description,
        party_name AS partyName,
        account_code AS accountCode,
        expense_account_code AS expenseAccountCode,
        DATE_FORMAT(start_date, '%Y-%m-%d') AS startDate,
        amount,
        term_months AS termMonths,
        status
      FROM prepaid_accounts
      ORDER BY id DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET PREPAID ACCOUNTS ERROR:", err);
    res.status(500).json({ message: "Failed to load prepaid accounts" });
  }
});

app.post("/api/prepaid-accounts", async (req, res) => {
  try {
    const {
      prepaidCode,
      description,
      partyName,
      accountCode,
      expenseAccountCode,
      startDate,
      amount,
      termMonths,
      status,
    } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO prepaid_accounts (
        prepaid_code, description, party_name, account_code, expense_account_code,
        start_date, amount, term_months, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        prepaidCode || "",
        description || "",
        partyName || "",
        accountCode || "",
        expenseAccountCode || "",
        startDate || null,
        Number(amount) || 0,
        Number(termMonths) || 1,
        status || "Active",
      ]
    );

    res.json({ success: true, message: "Prepaid account saved successfully", id: result.insertId });
  } catch (err) {
    console.error("CREATE PREPAID ACCOUNT ERROR:", err);
    res.status(500).json({ message: "Failed to save prepaid account" });
  }
});

app.put("/api/prepaid-accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      prepaidCode,
      description,
      partyName,
      accountCode,
      expenseAccountCode,
      startDate,
      amount,
      termMonths,
      status,
    } = req.body;

    await pool.execute(
      `UPDATE prepaid_accounts SET
        prepaid_code = ?, description = ?, party_name = ?, account_code = ?,
        expense_account_code = ?, start_date = ?, amount = ?, term_months = ?, status = ?
      WHERE id = ?`,
      [
        prepaidCode || "",
        description || "",
        partyName || "",
        accountCode || "",
        expenseAccountCode || "",
        startDate || null,
        Number(amount) || 0,
        Number(termMonths) || 1,
        status || "Active",
        id,
      ]
    );

    res.json({ success: true, message: "Prepaid account updated successfully" });
  } catch (err) {
    console.error("UPDATE PREPAID ACCOUNT ERROR:", err);
    res.status(500).json({ message: "Failed to update prepaid account" });
  }
});

app.delete("/api/prepaid-accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute("DELETE FROM prepaid_accounts WHERE id = ?", [id]);
    res.json({ success: true, message: "Prepaid account deleted successfully" });
  } catch (err) {
    console.error("DELETE PREPAID ACCOUNT ERROR:", err);
    res.status(500).json({ message: "Failed to delete prepaid account" });
  }
});

// ====================== PREPAID ACCOUNTS REPORTS ======================
// Shared computed-status subquery reused across all 4 report endpoints.

const PREPAID_COMPUTED_SQL = `
  SELECT
    id, prepaid_code, description, party_name, account_code, expense_account_code,
    start_date, amount, term_months, status,
    ROUND(amount / term_months, 2) AS monthly_amortization,
    LEAST(GREATEST(TIMESTAMPDIFF(MONTH, start_date, ?), 0), term_months) AS months_elapsed,
    LEAST(
      ROUND(amount / term_months, 2) * LEAST(GREATEST(TIMESTAMPDIFF(MONTH, start_date, ?), 0), term_months),
      amount
    ) AS amortized_to_date,
    amount - LEAST(
      ROUND(amount / term_months, 2) * LEAST(GREATEST(TIMESTAMPDIFF(MONTH, start_date, ?), 0), term_months),
      amount
    ) AS remaining_balance,
    (LEAST(GREATEST(TIMESTAMPDIFF(MONTH, start_date, ?), 0), term_months) >= term_months) AS is_lapsed
  FROM prepaid_accounts
  WHERE status != 'Cancelled'
`;

app.get("/api/reports/prepaid-list", async (req, res) => {
  try {
    const { asOf } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);

    const [rows] = await pool.execute(
      `
      SELECT
        id, prepaid_code AS prepaidCode, description, party_name AS partyName,
        DATE_FORMAT(start_date, '%Y-%m-%d') AS startDate, amount, term_months AS termMonths,
        monthly_amortization AS monthlyAmortization,
        amortized_to_date AS amortizedToDate,
        remaining_balance AS remainingBalance,
        is_lapsed AS isLapsed
      FROM (${PREPAID_COMPUTED_SQL}) p
      WHERE is_lapsed = 0
      ORDER BY prepaid_code ASC
      `,
      [reportDate, reportDate, reportDate, reportDate]
    );

    res.json(rows);
  } catch (err) {
    console.error("PREPAID LIST REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate list of prepaid accounts", error: err.message });
  }
});

app.get("/api/reports/lapsed-prepayments", async (req, res) => {
  try {
    const { asOf } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);

    const [rows] = await pool.execute(
      `
      SELECT
        id, prepaid_code AS prepaidCode, description, party_name AS partyName,
        DATE_FORMAT(start_date, '%Y-%m-%d') AS startDate, amount, term_months AS termMonths,
        amortized_to_date AS amortizedToDate,
        remaining_balance AS remainingBalance
      FROM (${PREPAID_COMPUTED_SQL}) p
      WHERE is_lapsed = 1
      ORDER BY prepaid_code ASC
      `,
      [reportDate, reportDate, reportDate, reportDate]
    );

    res.json(rows);
  } catch (err) {
    console.error("LAPSED PREPAYMENTS REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate list of lapsed prepayments", error: err.message });
  }
});

app.get("/api/reports/prepayment-lapsing", async (req, res) => {
  try {
    const { asOf } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);

    const [rows] = await pool.execute(
      `
      SELECT
        id, prepaid_code AS prepaidCode, description, party_name AS partyName,
        DATE_FORMAT(start_date, '%Y-%m-%d') AS startDate, amount, term_months AS termMonths,
        monthly_amortization AS monthlyAmortization,
        months_elapsed AS monthsElapsed,
        amortized_to_date AS amortizedToDate,
        remaining_balance AS remainingBalance,
        is_lapsed AS isLapsed
      FROM (${PREPAID_COMPUTED_SQL}) p
      ORDER BY prepaid_code ASC
      `,
      [reportDate, reportDate, reportDate, reportDate]
    );

    res.json(rows);
  } catch (err) {
    console.error("PREPAYMENT LAPSING REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate prepayment lapsing report", error: err.message });
  }
});

app.get("/api/reports/prepaid-subsidiary", async (req, res) => {
  try {
    const { prepaidId, asOf } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);

    if (!prepaidId) {
      return res.status(400).json({ message: "prepaidId is required" });
    }

    const [rows] = await pool.execute(
      `
      SELECT
        id, prepaid_code, description, start_date, amount, term_months,
        ROUND(amount / term_months, 2) AS monthly_amortization,
        LEAST(GREATEST(TIMESTAMPDIFF(MONTH, start_date, ?), 0), term_months) AS months_elapsed
      FROM prepaid_accounts
      WHERE id = ?
      `,
      [reportDate, prepaidId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Prepaid account not found" });
    }

    const p = rows[0];
    const schedule = [];
    let runningAmortized = 0;

    for (let m = 1; m <= p.term_months; m++) {
      const amortizationThisMonth =
        m === p.term_months
          ? Number(p.amount) - runningAmortized
          : Number(p.monthly_amortization);

      runningAmortized += amortizationThisMonth;

      const periodDate = new Date(p.start_date);
      periodDate.setMonth(periodDate.getMonth() + m);

      schedule.push({
        period: periodDate.toISOString().slice(0, 7),
        amortization: Math.round(amortizationThisMonth * 100) / 100,
        cumulativeAmortized: Math.round(runningAmortized * 100) / 100,
        remainingBalance: Math.round((Number(p.amount) - runningAmortized) * 100) / 100,
        lapsed: m <= p.months_elapsed,
      });
    }

    res.json({
      id: p.id,
      prepaidCode: p.prepaid_code,
      description: p.description,
      startDate: p.start_date,
      amount: p.amount,
      termMonths: p.term_months,
      schedule,
    });
  } catch (err) {
    console.error("PREPAID SUBSIDIARY REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate prepaid subsidiary report", error: err.message });
  }
});

// ===================== EWT LIBRARY API =====================

app.get("/api/ewt-library", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        atc_code AS atcCode,
        description,
        tax_type AS taxType,
        rate,
        bir_form AS birForm,
        status
      FROM ewt_library
      ORDER BY atc_code ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET EWT LIBRARY ERROR:", err);
    res.status(500).json({ message: "Failed to load EWT library" });
  }
});

app.post("/api/ewt-library", async (req, res) => {
  try {
    const { atcCode, description, taxType, rate, birForm, status } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO ewt_library (atc_code, description, tax_type, rate, bir_form, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        atcCode || "",
        description || "",
        taxType || "EWT",
        Number(rate) || 0,
        birForm || "",
        status || "ACTIVE",
      ]
    );

    res.json({ success: true, message: "EWT code saved successfully", id: result.insertId });
  } catch (err) {
    console.error("CREATE EWT LIBRARY ERROR:", err);
    res.status(500).json({ message: "Failed to save EWT code" });
  }
});

app.put("/api/ewt-library/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { atcCode, description, taxType, rate, birForm, status } = req.body;

    await pool.execute(
      `UPDATE ewt_library SET
        atc_code = ?, description = ?, tax_type = ?, rate = ?, bir_form = ?, status = ?
      WHERE id = ?`,
      [
        atcCode || "",
        description || "",
        taxType || "EWT",
        Number(rate) || 0,
        birForm || "",
        status || "ACTIVE",
        id,
      ]
    );

    res.json({ success: true, message: "EWT code updated successfully" });
  } catch (err) {
    console.error("UPDATE EWT LIBRARY ERROR:", err);
    res.status(500).json({ message: "Failed to update EWT code" });
  }
});

app.delete("/api/ewt-library/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute("DELETE FROM ewt_library WHERE id = ?", [id]);
    res.json({ success: true, message: "EWT code deleted successfully" });
  } catch (err) {
    console.error("DELETE EWT LIBRARY ERROR:", err);
    res.status(500).json({ message: "Failed to delete EWT code" });
  }
});

// ====================== TAX ALPHALIST REPORTS ======================
// Aggregates APV records that captured withholding tax (atc_code + tax_type)
// within a given month, grouped by payee -- the standard monthly
// Final/Expanded Withholding Tax alphalist shape (payee, TIN, ATC, gross, tax withheld).

app.get("/api/reports/alphalist", async (req, res) => {
  try {
    const { taxType, month } = req.query;

    if (!taxType || !["EWT", "FINAL"].includes(taxType)) {
      return res.status(400).json({ message: "taxType must be EWT or FINAL" });
    }

    if (!month) {
      return res.status(400).json({ message: "month (YYYY-MM) is required" });
    }

    const [rows] = await pool.execute(
      `
      SELECT
        supplier_name AS payeeName,
        COALESCE(payee_tin, '') AS tin,
        atc_code AS atcCode,
        tax_rate AS taxRate,
        COUNT(*) AS transactionCount,
        SUM(total_credit) AS grossAmount,
        SUM(tax_withheld_amount) AS taxWithheld
      FROM apv_headers
      WHERE tax_type = ?
        AND DATE_FORMAT(transaction_date, '%Y-%m') = ?
        AND tax_withheld_amount > 0
      GROUP BY supplier_name, payee_tin, atc_code, tax_rate
      ORDER BY payeeName ASC
      `,
      [taxType, month]
    );

    res.json(rows);
  } catch (err) {
    console.error("ALPHALIST REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate alphalist report", error: err.message });
  }
});

// ===================== COMPANY PROFILE API =====================

app.get("/api/company-profile", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT payor_name AS payorName, payor_tin AS payorTin, payor_address AS payorAddress, payor_zip AS payorZip FROM company_profile WHERE id = 1"
    );

    res.json(rows[0] || { payorName: "", payorTin: "", payorAddress: "", payorZip: "" });
  } catch (err) {
    console.error("GET COMPANY PROFILE ERROR:", err);
    res.status(500).json({ message: "Failed to load company profile" });
  }
});

app.put("/api/company-profile", async (req, res) => {
  try {
    const { payorName, payorTin, payorAddress, payorZip } = req.body;

    await pool.execute(
      `UPDATE company_profile SET payor_name = ?, payor_tin = ?, payor_address = ?, payor_zip = ? WHERE id = 1`,
      [payorName || "", payorTin || "", payorAddress || "", payorZip || ""]
    );

    res.json({ success: true, message: "Company profile saved successfully" });
  } catch (err) {
    console.error("UPDATE COMPANY PROFILE ERROR:", err);
    res.status(500).json({ message: "Failed to save company profile" });
  }
});

// ====================== BIR FORM 2307 REPORT ======================
// Certificate of Creditable Tax Withheld at Source, per payee per quarter.

app.get("/api/reports/2307", async (req, res) => {
  try {
    const { supplierId, year, quarter } = req.query;

    if (!supplierId || !year || !quarter) {
      return res.status(400).json({ message: "supplierId, year, and quarter are required" });
    }

    const q = Number(quarter);
    if (![1, 2, 3, 4].includes(q)) {
      return res.status(400).json({ message: "quarter must be 1, 2, 3, or 4" });
    }

    const firstMonth = (q - 1) * 3 + 1;
    const secondMonth = firstMonth + 1;
    const thirdMonth = firstMonth + 2;

    const [payeeRows] = await pool.execute(
      `SELECT name, tin, address1, address2, address3, atc_code AS atcCode
       FROM general_libraries WHERE id = ?`,
      [supplierId]
    );

    if (payeeRows.length === 0) {
      return res.status(404).json({ message: "Payee not found" });
    }

    const payee = payeeRows[0];
    const payeeAddress = [payee.address1, payee.address2, payee.address3]
      .filter(Boolean)
      .join(", ");

    const [payorRows] = await pool.execute(
      "SELECT payor_name AS payorName, payor_tin AS payorTin, payor_address AS payorAddress, payor_zip AS payorZip FROM company_profile WHERE id = 1"
    );
    const payor = payorRows[0] || { payorName: "", payorTin: "", payorAddress: "", payorZip: "" };

    const [lines] = await pool.execute(
      `
      SELECT
        atc_code AS atcCode,
        SUM(CASE WHEN MONTH(transaction_date) = ? THEN total_credit ELSE 0 END) AS month1Amount,
        SUM(CASE WHEN MONTH(transaction_date) = ? THEN total_credit ELSE 0 END) AS month2Amount,
        SUM(CASE WHEN MONTH(transaction_date) = ? THEN total_credit ELSE 0 END) AS month3Amount,
        SUM(total_credit) AS totalAmount,
        SUM(tax_withheld_amount) AS totalTaxWithheld
      FROM apv_headers
      WHERE supplier_id = ?
        AND tax_type = 'EWT'
        AND tax_withheld_amount > 0
        AND YEAR(transaction_date) = ?
        AND QUARTER(transaction_date) = ?
      GROUP BY atc_code
      ORDER BY atc_code ASC
      `,
      [firstMonth, secondMonth, thirdMonth, supplierId, year, q]
    );

    res.json({
      payee: {
        name: payee.name,
        tin: payee.tin,
        address: payeeAddress,
      },
      payor,
      period: {
        year: Number(year),
        quarter: q,
        firstMonth,
        secondMonth,
        thirdMonth,
      },
      lines,
      totals: lines.reduce(
        (sum, line) => ({
          month1Amount: sum.month1Amount + Number(line.month1Amount || 0),
          month2Amount: sum.month2Amount + Number(line.month2Amount || 0),
          month3Amount: sum.month3Amount + Number(line.month3Amount || 0),
          totalAmount: sum.totalAmount + Number(line.totalAmount || 0),
          totalTaxWithheld: sum.totalTaxWithheld + Number(line.totalTaxWithheld || 0),
        }),
        { month1Amount: 0, month2Amount: 0, month3Amount: 0, totalAmount: 0, totalTaxWithheld: 0 }
      ),
    });
  } catch (err) {
    console.error("2307 REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate 2307 report", error: err.message });
  }
});

// ===================== BANK CODES API =====================

app.get("/api/bank-codes", async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        id,
        bank_code AS bankCode,
        bank_name AS bankName,
        account_no AS accountNo,
        account_name AS accountName,
        coa_account_id AS coaAccountId,
        coa_code AS coaCode,
        status
      FROM bank_codes
      ORDER BY bank_code ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error("GET BANK CODES ERROR:", err);
    res.status(500).json({ message: "Failed to load bank codes" });
  }
});

app.post("/api/bank-codes/sync", async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const [bankAccounts] = await conn.execute(`
      SELECT ca.id, ca.code, ca.title
      FROM chart_of_accounts ca
      JOIN coa_validations cv ON cv.coa_id = ca.id
      WHERE cv.validation_name = 'BANK / CASH'
    `);

    await conn.beginTransaction();

    let addedCount = 0;

    for (const account of bankAccounts) {
      const [existing] = await conn.execute(
        "SELECT id FROM bank_codes WHERE coa_account_id = ?",
        [account.id]
      );

      if (existing.length === 0) {
        await conn.execute(
          `INSERT INTO bank_codes (bank_code, bank_name, account_name, coa_account_id, coa_code, status)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
          [account.code, account.title, account.title, account.id, account.code]
        );
        addedCount++;
      } else {
        await conn.execute(
          "UPDATE bank_codes SET status = 'ACTIVE' WHERE coa_account_id = ?",
          [account.id]
        );
      }
    }

    await conn.commit();

    res.json({
      success: true,
      message: `${addedCount} bank code(s) added from Chart of Accounts`,
      addedCount,
    });
  } catch (err) {
    await conn.rollback();
    console.error("SYNC BANK CODES ERROR:", err);
    res.status(500).json({ message: "Failed to sync bank codes from Chart of Accounts" });
  } finally {
    conn.release();
  }
});

app.post("/api/bank-codes", async (req, res) => {
  try {
    const { bankCode, bankName, accountNo, accountName, status } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO bank_codes (bank_code, bank_name, account_no, account_name, status)
       VALUES (?, ?, ?, ?, ?)`,
      [bankCode || "", bankName || "", accountNo || "", accountName || "", status || "ACTIVE"]
    );

    res.json({ success: true, message: "Bank code saved successfully", id: result.insertId });
  } catch (err) {
    console.error("CREATE BANK CODE ERROR:", err);
    res.status(500).json({ message: "Failed to save bank code" });
  }
});

app.put("/api/bank-codes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { bankCode, bankName, accountNo, accountName, status } = req.body;

    await pool.execute(
      `UPDATE bank_codes SET bank_code = ?, bank_name = ?, account_no = ?, account_name = ?, status = ?
       WHERE id = ?`,
      [bankCode || "", bankName || "", accountNo || "", accountName || "", status || "ACTIVE", id]
    );

    res.json({ success: true, message: "Bank code updated successfully" });
  } catch (err) {
    console.error("UPDATE BANK CODE ERROR:", err);
    res.status(500).json({ message: "Failed to update bank code" });
  }
});

app.delete("/api/bank-codes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute("DELETE FROM bank_codes WHERE id = ?", [id]);
    res.json({ success: true, message: "Bank code deleted successfully" });
  } catch (err) {
    console.error("DELETE BANK CODE ERROR:", err);
    res.status(500).json({ message: "Failed to delete bank code" });
  }
});

// ===================== FRONTEND STATIC FILES =====================

const distPath = path.join(__dirname, "..", "..", "dist");

app.use(express.static(distPath));

app.get(/^\/(?!api).*/, (req, res, next) => {
  const indexPath = path.join(distPath, "index.html");

  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    next();
  }
});

// ===================== SERVER START =====================


const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});