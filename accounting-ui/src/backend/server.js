require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const pool = require("./db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

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
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        status = ?
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
        status
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
        status
      )
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
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
        status
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
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]
    );

    const apvId = result.insertId;

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
        status = ?
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
        status
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
        status
      )
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
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
        status
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

    if (from && to) {
      dateFilterAPV = "WHERE h.transaction_date BETWEEN ? AND ?";
      dateFilterCV = "WHERE h.transaction_date BETWEEN ? AND ?";
      dateFilterARAP = "WHERE h.balance_date BETWEEN ? AND ?";
      params.push(from, to, from, to, from, to);
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
      ORDER BY l.party_name ASC, l.due_date ASC
      `,
      [reportDate]
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

// ===================== SERVER START =====================


const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});