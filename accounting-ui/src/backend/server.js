require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const pool = require("./db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { authenticateToken } = require("./lib/auth");
const { HttpError } = require("./lib/httpError");
const { logAudit, requestMeta } = require("./lib/audit");
const authorizePermission = require("./middleware/authorizePermission");

// 20 attempts per 15 minutes per IP, on top of the per-account lockout
// below - the two are independent layers (one IP hammering many usernames,
// one username being hammered from many IPs).
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts. Please try again later." },
});
const LedgerReportService = require("./services/LedgerReportService");
const { buildXlsxTemplate } = require("./services/TemplateExportService");
const { templateImportUpload, coaImportUpload, handleUpload } = require("./lib/uploadMiddleware");
const COAImportService = require("./services/COAImportService");
const GenLibImportService = require("./services/GenLibImportService");
const GLBeginningBalanceService = require("./services/GLBeginningBalanceService");
const BeginningBalanceCurrencyService = require("./services/beginningBalanceCurrencyService");
const TrialBalanceDifferenceService = require("./services/trialBalanceDifferenceService");
const { computeEwtTaxableBase, computeEwtAmount } = require("./services/ewtCalculationService");
const CurrencyService = require("./services/currencyService");
const { postedOnlySql } = require("./services/reportRecognitionService");
const TransactionCurrencyService = require("./services/transactionCurrencyService");
const AgingReportService = require("./services/agingReportService");
const AccountingPeriodService = require("./services/accountingPeriodService");
const TaxEntryService = require("./services/taxEntryService");
const EwtReportReconciliationService = require("./services/ewtReportReconciliationService");

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


// Checkpoint 3B: payment-status recompute + payment-application logic
// lives in paymentApplicationService.js (extracted so it's directly
// unit-testable against the real DB) - destructured here so every
// existing call site below keeps calling these by the same bare names.
const {
  updateInvoicePaymentStatus,
  updateApvPaymentStatus,
  applyInvoicePayment,
  applyApvPayment,
  applyForeignSettlementToLines,
} = require("./services/paymentApplicationService");

// Checkpoint 3FX (section 26): one audit entry per OR/CV that actually
// realized an FX difference, written on the SAME `conn` as the rest of
// the post so it only survives if the whole atomic transaction commits -
// an audit record for a rolled-back post would be worse than none.
// Per-application detail (source rate/payment rate/source base/payment
// base/FX account) is already fully reconstructable from
// transaction_applications itself (section 9), so this entry summarizes
// rather than repeats it.
async function logFxSettlementAudit(conn, { req, moduleKey, appliedType, appliedId, applications, fxResult }) {
  if (!fxResult || (fxResult.totalGainAmount === 0 && fxResult.totalLossAmount === 0)) return;

  const withFx = applications.filter((a) => a && a.fxDifference !== 0);
  await logAudit(conn, {
    module: moduleKey,
    entityType: appliedType,
    entityId: appliedId,
    action: "FOREIGN_SETTLEMENT_POSTED",
    description:
      `${appliedType} #${appliedId} posted a realized foreign-exchange settlement: ` +
      `Gain ${fxResult.totalGainAmount.toFixed(2)}, Loss ${fxResult.totalLossAmount.toFixed(2)}`,
    afterData: {
      totalGainAmount: fxResult.totalGainAmount,
      totalLossAmount: fxResult.totalLossAmount,
      applications: withFx.map((a) => ({
        sourceType: a.sourceCurrencyCode ? "INV/APV" : null,
        foreignAmountApplied: a.foreignAmountApplied,
        sourceExchangeRate: a.sourceExchangeRate,
        paymentExchangeRate: a.paymentExchangeRate,
        sourceBaseAmount: a.sourceBaseAmount,
        paymentBaseAmount: a.paymentBaseAmount,
        fxDifference: a.fxDifference,
        fxDirection: a.fxDirection,
        fxAccountCode: a.fxAccount?.accountCode || null,
      })),
    },
    user: req.user,
    ...requestMeta(req),
  });
}

// ===================== LOGIN =====================

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

app.post("/api/login", loginRateLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const { ipAddress, userAgent } = requestMeta(req);

    const [rows] = await pool.execute(
      `SELECT id, username, password, role, status, token_version, failed_login_count, locked_until,
         (locked_until IS NOT NULL AND locked_until > NOW()) AS is_locked
       FROM users WHERE username = ?`,
      [username]
    );

    if (rows.length === 0) {
      await logAudit(pool, {
        module: "AUTH", entityType: "LOGIN", action: "LOGIN_FAILURE",
        description: `Login failed for unknown username "${username}"`,
        ipAddress, userAgent,
      });
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const user = rows[0];

    if (user.is_locked) {
      await logAudit(pool, {
        module: "AUTH", entityType: "LOGIN", action: "LOGIN_FAILURE",
        description: `Login blocked for ${user.username} - account locked until ${user.locked_until}`,
        user, ipAddress, userAgent,
      });
      return res.status(403).json({
        success: false,
        message: "Account temporarily locked due to repeated failed attempts. Please try again later.",
      });
    }

    // If your passwords are still plain text, temporarily use:
    // const isMatch = password === user.password;

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      const nextCount = (user.failed_login_count || 0) + 1;
      const lockingNow = nextCount >= MAX_FAILED_LOGIN_ATTEMPTS;

      await pool.execute(
        `UPDATE users SET failed_login_count = ?, locked_until = ${lockingNow ? "DATE_ADD(NOW(), INTERVAL ? MINUTE)" : "locked_until"} WHERE id = ?`,
        lockingNow ? [nextCount, LOCKOUT_MINUTES, user.id] : [nextCount, user.id]
      );

      await logAudit(pool, {
        module: "AUTH", entityType: "LOGIN", action: "LOGIN_FAILURE",
        description: lockingNow
          ? `Login failed for ${user.username} - account locked for ${LOCKOUT_MINUTES} minutes after ${nextCount} failed attempts`
          : `Login failed for ${user.username} (attempt ${nextCount}/${MAX_FAILED_LOGIN_ATTEMPTS})`,
        user, ipAddress, userAgent,
      });

      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    if (user.status && user.status !== "ACTIVE") {
      await logAudit(pool, {
        module: "AUTH", entityType: "LOGIN", action: "LOGIN_FAILURE",
        description: `Login blocked for ${user.username} - account status is ${user.status}`,
        user, ipAddress, userAgent,
      });
      return res.status(403).json({
        success: false,
        message: "This account is not active. Contact your administrator.",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        tv: user.token_version ?? 0,
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    pool.execute(
      "UPDATE users SET last_login_at = NOW(), failed_login_count = 0, locked_until = NULL WHERE id = ?",
      [user.id]
    ).catch((err) => {
      console.error("UPDATE LAST LOGIN ERROR:", err.message);
    });

    await logAudit(pool, {
      module: "AUTH", entityType: "LOGIN", action: "LOGIN_SUCCESS",
      description: `${user.username} logged in`,
      user, ipAddress, userAgent,
    });

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

// ===================== GENERAL LIBRARIES API =====================

app.get("/api/genlib", authenticateToken, authorizePermission("FILESETUP.GENLIB", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
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
      WHERE company_id = ?
      ORDER BY id DESC
    `, [companyId]);

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

app.post("/api/genlib", authenticateToken, authorizePermission("FILESETUP.GENLIB", "CREATE"), async (req, res) => {
  try {
    const item = req.body;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, item.companyId);

    const [result] = await pool.execute(
      `INSERT INTO general_libraries (
        company_id, code, party_type, name, status, start_date,
        address1, address2, address3, attention, position,
        telephone, fax, mobile, tin, email,
        atc_code, ewt_code, category, branch_code, rdo_code,
        notes, is_prospective, is_client
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
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

app.put("/api/genlib/:id", authenticateToken, authorizePermission("FILESETUP.GENLIB", "EDIT"), async (req, res) => {
  try {
    const { id } = req.params;
    const item = req.body;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, item.companyId);

    const [ownerRows] = await pool.execute("SELECT company_id FROM general_libraries WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      return res.status(404).json({ message: "Record not found" });
    }

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
      WHERE id = ? AND company_id = ?`,
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
        companyId,
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

app.delete("/api/genlib/:id", authenticateToken, authorizePermission("FILESETUP.GENLIB", "DELETE"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);

    const [ownerRows] = await pool.execute("SELECT company_id FROM general_libraries WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      return res.status(404).json({ message: "Record not found" });
    }

    await pool.execute("DELETE FROM general_libraries WHERE id = ? AND company_id = ?", [id, companyId]);

    res.json({
      success: true,
      message: "Record deleted successfully",
    });
  } catch (err) {
    console.error("DELETE GENLIB ERROR:", err);
    res.status(500).json({ message: "Failed to delete record" });
  }
});

app.get("/api/genlib/template", authenticateToken, authorizePermission("FILESETUP.GENLIB", "VIEW"), async (req, res) => {
  try {
    const buffer = await buildXlsxTemplate({
      sheetName: "General Libraries",
      columns: [
        { key: "code", header: "Code", width: 14 },
        { key: "type", header: "Type", width: 14 },
        { key: "name", header: "Name", width: 28 },
        { key: "status", header: "Status", width: 12 },
        { key: "startDate", header: "Start Date", width: 14, note: "Format: YYYY-MM-DD" },
        { key: "address1", header: "Address1", width: 22 },
        { key: "address2", header: "Address2", width: 22 },
        { key: "address3", header: "Address3", width: 22 },
        { key: "attention", header: "Attention", width: 18 },
        { key: "position", header: "Position", width: 16 },
        { key: "telephone", header: "Telephone", width: 16 },
        { key: "fax", header: "Fax", width: 16 },
        { key: "mobile", header: "Mobile", width: 16 },
        { key: "tin", header: "TIN", width: 16 },
        { key: "email", header: "Email", width: 22 },
        { key: "atcCode", header: "ATC Code", width: 12 },
        { key: "ewtCode", header: "EWT Code", width: 12 },
        { key: "category", header: "Category", width: 14 },
        { key: "branchCode", header: "Branch Code", width: 14 },
        { key: "rdoCode", header: "RDO Code", width: 12 },
        { key: "notes", header: "Notes", width: 24 },
        { key: "isProspective", header: "Is Prospective", width: 14, note: "YES or NO" },
        { key: "isClient", header: "Is Client", width: 12, note: "YES or NO" },
      ],
      sampleRow: {
        code: "CUST-001",
        type: "CUSTOMER",
        name: "Sample Customer Inc.",
        status: "ACTIVE",
        startDate: "2026-01-01",
        address1: "123 Sample St.",
        category: "REGULAR",
        isProspective: "NO",
        isClient: "YES",
      },
      dropdowns: {
        type: GenLibImportService.PARTY_TYPES,
        status: GenLibImportService.STATUS_OPTIONS,
        category: GenLibImportService.CATEGORY_OPTIONS,
        isProspective: ["YES", "NO"],
        isClient: ["YES", "NO"],
      },
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="General_Libraries_Template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("GENLIB TEMPLATE ERROR:", err);
    res.status(500).json({ message: "Failed to generate template" });
  }
});

app.post(
  "/api/genlib/import",
  authenticateToken,
  authorizePermission("FILESETUP.GENLIB", "CREATE"),
  handleUpload(templateImportUpload.single("file")),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { headers, ready, skipped, warnings, missingRequiredColumns } =
        await GenLibImportService.parseAndValidateRows(req.file.buffer, req.file.originalname);

      if (headers.length === 0) {
        return res.status(400).json({ message: "The file appears to be empty" });
      }

      if (missingRequiredColumns) {
        return res.status(400).json({
          message: "Could not find required Code and Name columns in the file",
          headers,
        });
      }

      const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);
      const imported = await GenLibImportService.insertGenLibRows(ready, companyId);

      res.json({ success: true, imported, skipped, warnings });
    } catch (err) {
      console.error("GENLIB IMPORT ERROR:", err);
      res.status(500).json({ message: "Failed to import general libraries", error: err.message });
    }
  }
);

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

// ===================== COA API =====================

app.get("/api/coa", authenticateToken, authorizePermission("FILESETUP.COA", "VIEW"), async (req, res) => {
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

app.post("/api/coa", authenticateToken, authorizePermission("FILESETUP.COA", "CREATE"), async (req, res) => {
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

app.put("/api/coa/:id", authenticateToken, authorizePermission("FILESETUP.COA", "EDIT"), async (req, res) => {
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

app.delete("/api/coa/:id", authenticateToken, authorizePermission("FILESETUP.COA", "DELETE"), async (req, res) => {
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

app.get("/api/coa/template", authenticateToken, authorizePermission("FILESETUP.COA", "VIEW"), async (req, res) => {
  try {
    const buffer = await buildXlsxTemplate({
      sheetName: "Chart of Accounts",
      columns: [
        { key: "code", header: "Code", width: 14 },
        { key: "date", header: "Date", width: 14, note: "Format: YYYY-MM-DD. Leave blank to default to today." },
        { key: "title", header: "Title", width: 30 },
        { key: "accountClass", header: "Account Class", width: 16 },
        { key: "description", header: "Description", width: 30 },
        {
          key: "validations",
          header: "Validations",
          width: 30,
          note: `Semicolon-separated. Valid values: ${COAImportService.VALIDATION_OPTIONS.join("; ")}`,
        },
        { key: "groups", header: "Group Codes", width: 20, note: "Semicolon-separated group codes (see Group Codes setup)." },
      ],
      sampleRow: {
        code: "1010",
        date: "2026-01-01",
        title: "Cash on Hand",
        accountClass: "ASSET",
        description: "Petty cash fund",
        validations: "BANK / CASH",
        groups: "",
      },
      dropdowns: {
        accountClass: COAImportService.CLASS_OPTIONS,
      },
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="Chart_of_Accounts_Template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("COA TEMPLATE ERROR:", err);
    res.status(500).json({ message: "Failed to generate template" });
  }
});

// Read-only preview: parses + validates the uploaded file (same
// COAImportService.parseAndValidateRows() the real import route uses) but
// never calls insertCOARows - zero database writes happen here. The
// frontend shows this result, and only on explicit user confirmation does
// it resubmit the SAME file to POST /api/coa/import below. Re-parsing on
// confirm (rather than trusting a client-echoed "ready" row list) means
// the import is always re-validated against the database's actual current
// state at write time, not a possibly-stale preview from moments earlier.
app.post(
  "/api/coa/import/preview",
  authenticateToken,
  authorizePermission("FILESETUP.COA", "CREATE"),
  handleUpload(coaImportUpload.single("file")),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { headers, ready, skipped, warnings, missingRequiredColumns } =
        await COAImportService.parseAndValidateRows(req.file.buffer, req.file.originalname);

      if (headers.length === 0) {
        return res.status(400).json({ message: "The file appears to be empty" });
      }

      if (missingRequiredColumns) {
        return res.status(400).json({
          message: "Could not find required Code and Title columns in the file",
          headers,
        });
      }

      res.json({
        success: true,
        totalRows: ready.length + skipped.length,
        readyCount: ready.length,
        skipped,
        warnings,
      });
    } catch (err) {
      console.error("COA IMPORT PREVIEW ERROR:", err);
      res.status(500).json({ message: "Failed to read the file. Please check its format and try again." });
    }
  }
);

app.post(
  "/api/coa/import",
  authenticateToken,
  authorizePermission("FILESETUP.COA", "CREATE"),
  handleUpload(coaImportUpload.single("file")),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { headers, ready, skipped, warnings, missingRequiredColumns } =
        await COAImportService.parseAndValidateRows(req.file.buffer, req.file.originalname);

      if (headers.length === 0) {
        return res.status(400).json({ message: "The file appears to be empty" });
      }

      if (missingRequiredColumns) {
        return res.status(400).json({
          message: "Could not find required Code and Title columns in the file",
          headers,
        });
      }

      let imported;
      try {
        imported = await COAImportService.insertCOARows(ready, syncBankCodeForAccount);
      } catch (insertErr) {
        // insertCOARows rolls back its own single batch transaction before
        // this throw - zero rows from THIS request were committed. Detailed
        // error stays server-side; the user gets an accurate, actionable
        // summary instead of a raw DB/library message.
        console.error("COA IMPORT - BATCH INSERT FAILED, ROLLED BACK:", insertErr);
        return res.status(500).json({
          success: false,
          message: "Import failed and was rolled back. No accounts were imported from this file. Please try again.",
          skipped,
          warnings,
        });
      }

      res.json({ success: true, imported, skipped, warnings });
    } catch (err) {
      console.error("COA IMPORT ERROR:", err);
      res.status(500).json({ message: "Failed to import chart of accounts. Please check the file and try again." });
    }
  }
);

// ===================== INVOICE API =====================

app.get("/api/invoices", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const [rows] = await pool.execute(`
      SELECT
        invoice_headers.id AS id,
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
        invoice_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.foreign_total AS foreignTotal,
        invoice_headers.created_at AS createdAt,
        invoice_headers.updated_at AS updatedAt
      FROM invoice_headers
      LEFT JOIN currencies cur ON cur.id = invoice_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'INV' AND snap.transaction_id = invoice_headers.id
      WHERE invoice_headers.company_id = ?
      ORDER BY invoice_headers.id DESC
    `, [companyId]);

    res.json(rows);
  } catch (err) {
    console.error("GET INVOICE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to load invoice records" });
  }
});

app.get("/api/invoices/unpaid", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const { customerId, customerName } = req.query;

    const params = [companyId];
    let customerFilterInv = "";
    let customerFilterBb = "";

    if (customerId) {
      customerFilterInv = " AND customer_id = ? ";
      customerFilterBb = " AND l.party_id = ? ";
      params.push(customerId);
    } else if (customerName) {
      customerFilterInv = " AND TRIM(LOWER(customer_name)) = TRIM(LOWER(?)) ";
      customerFilterBb = " AND TRIM(LOWER(l.party_name)) = TRIM(LOWER(?)) ";
      params.push(customerName);
    }
    params.push(companyId);
    if (customerId) params.push(customerId);
    else if (customerName) params.push(customerName);

    const [rows] = await pool.execute(
      `
      SELECT
        invoice_headers.id AS id,
        'INV' AS sourceType,
        voucher_no AS voucherNo,
        customer_id AS customerId,
        customer_name AS customerName,
        total_debit AS totalAmount,
        COALESCE(paid_amount, 0) AS paidAmount,
        COALESCE(balance_amount, total_debit, 0) AS balanceAmount,
        invoice_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.exchange_rate AS sourceExchangeRate,
        snap.foreign_total AS foreignOriginalAmount,
        invoice_headers.foreign_paid_amount AS foreignPaidAmount,
        invoice_headers.foreign_balance_amount AS foreignBalanceAmount
      FROM invoice_headers
      LEFT JOIN currencies cur ON cur.id = invoice_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'INV' AND snap.transaction_id = invoice_headers.id
      WHERE invoice_headers.company_id = ?
        AND COALESCE(balance_amount, total_debit, 0) > 0
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
        COALESCE(l.balance_amount, l.debit, 0) AS balanceAmount,
        l.currency_id AS currencyId,
        bbcur.currency_code AS currencyCode,
        bbcur.currency_symbol AS currencySymbol,
        bbsnap.exchange_rate AS sourceExchangeRate,
        l.foreign_original_amount AS foreignOriginalAmount,
        l.foreign_paid_amount AS foreignPaidAmount,
        l.foreign_balance_amount AS foreignBalanceAmount
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
      LEFT JOIN currencies bbcur ON bbcur.id = l.currency_id
      LEFT JOIN transaction_currency_snapshots bbsnap ON bbsnap.transaction_type = 'AR_BEGINNING' AND bbsnap.transaction_id = l.id
      WHERE h.balance_type = 'AR'
        AND h.company_id = ?
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

app.get("/api/invoices/:id", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "VIEW"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

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
        atc_code AS atcCode,
        tax_type AS taxType,
        tax_rate AS taxRate,
        tax_withheld_amount AS taxWithheldAmount,
        taxable_base AS taxableBase,
        currency_id AS currencyId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM invoice_headers
      WHERE id = ? AND company_id = ?`,
      [id, companyId]
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
        gen_name AS genName,
        foreign_debit AS foreignDebit,
        foreign_credit AS foreignCredit
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

    const currencySnapshot = await TransactionCurrencyService.getSnapshot("INV", id);
    const taxEntries = await TaxEntryService.loadTaxEntries("INV", id);

    res.json({
      ...headers[0],
      lines,
      applications,
      currency: currencySnapshot,
      taxEntries,
    });
  } catch (err) {
    console.error("GET INVOICE DETAILS ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to load invoice details" });
  }
});

app.post("/api/invoices", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "CREATE"), async (req, res) => {
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
      atcCode,
      taxWithheldAmount,
      currency,
    } = req.body;

    await conn.beginTransaction();

    const total = Number(totalDebit || 0); // gross in the TRANSACTION currency
    const finalStatus = status || "DRAFT";

    // EWT stays completely unchanged - still operates on the raw
    // transaction-currency lines/gross, exactly as the EWT phase built it.
    const ewt = await resolveTaxWithholding(conn, {
      moduleLabel: "Invoice",
      atcCode,
      lines,
      totalCredit: total,
      clientTaxWithheldAmount: taxWithheldAmount,
      vatKeyword: "output vat",
    });

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    await AccountingPeriodService.assertPeriodOpen({
      companyId, transactionDate, operation: "CREATE", user: req.user,
    }, conn);
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "INV", transactionId: null, currencyPayload: currency,
      lines, grossAmount: total, vatKeyword: "output vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting: String(finalStatus).toUpperCase() === "POSTED",
    });

    // Phase 7C.1: reconciles the submitted EWT journal line (if any)
    // against the authoritative `ewt` result computed above - a brand-new
    // transaction has no existing atc_code, so any non-null atcCode here
    // is by definition a new EWT application and requires a matching
    // line. Throws before any row is written; caught by this route's own
    // catch block below (rollback + statusCode/code-aware response).
    const reconciledEwt = TaxEntryService.reconcileEwtTaxEntry({
      ewt, lines: currencyResult.lines, existingAtcCode: null, expectedSide: "debit", moduleLabel: "Invoice",
    });

    const [result] = await conn.execute(
      `INSERT INTO invoice_headers (
        company_id,
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
        recurrence_frequency,
        atc_code,
        tax_type,
        tax_rate,
        tax_withheld_amount,
        taxable_base,
        currency_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        voucherNo,
        customerId || null,
        customerName || "",
        transactionDate || null,
        dueDate || transactionDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        0,
        currencyResult.baseTotalDebit,
        "Unpaid",
        finalStatus,
        invoiceType === "Recurring" ? "Recurring" : "Standard",
        invoiceType === "Recurring" ? recurrenceFrequency || "Monthly" : null,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        // Stored EWT figures are BASE-currency (BIR remittance/Form 2307
        // reports assume PHP) - the snapshot table below separately keeps
        // the transaction-currency (foreign) EWT for display/audit.
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        currencyResult.currencyId,
      ]
    );

    const invoiceId = result.insertId;

    // Phase 7C: each client line may carry an optional `taxEntry` object
    // (from the Input/Output VAT or EWT popup) - it survives
    // resolveTransactionCurrency() untouched (computeBaseLines() spreads
    // `...line` first) since that function has no reason to know about it.
    // A VAT-type entry's amount is independently re-validated against the
    // ONE centralized helper before it's allowed onto this line - see
    // taxEntryService.js's own comment on why a mismatch is rejected
    // rather than silently corrected, unlike EWT's header-only precedent.
    const taxEntriesToSave = [];

    for (const line of currencyResult.lines) {
      if (line.taxEntry && (line.taxEntry.entryType === "INPUT_VAT" || line.taxEntry.entryType === "OUTPUT_VAT")) {
        TaxEntryService.validateVatTaxEntry(line.taxEntry, line.foreignDebit || line.foreignCredit);
      }

      const [lineResult] = await conn.execute(
        `INSERT INTO invoice_lines (
          invoice_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name,
          foreign_debit,
          foreign_credit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.baseDebit,
          line.baseCredit,
          line.genRef || "",
          line.genName || "",
          line.foreignDebit,
          line.foreignCredit,
        ]
      );

      if (reconciledEwt && line === reconciledEwt.lineRef) {
        // Phase 7C.1: the EWT line's saved metadata comes from the
        // RECONCILED (backend-authoritative) entry, never the client's raw
        // taxEntry - see reconcileEwtTaxEntry()'s own comment for why this
        // is what guarantees header/structured-entry/journal-line
        // agreement by construction.
        taxEntriesToSave.push({
          ...reconciledEwt.entry,
          lineId: lineResult.insertId,
          accountId: line.accountId || null,
        });
      } else if (line.taxEntry) {
        // Phase 7C bug fix (caught via Playwright, see the completion
        // report's "bugs discovered/fixed" item): a RELOADED taxEntry
        // already carries its OWN lineId/accountId fields (from
        // loadTaxEntries()'s own SELECT aliases) - spreading it AFTER
        // these two let that stale, previous-save lineId silently
        // clobber the line that was just actually inserted THIS save.
        // The structural fields (lineId/accountId) must always win over
        // whatever the client echoed back; only the content fields
        // (party/amounts/etc.) come from the client's taxEntry.
        taxEntriesToSave.push({
          ...line.taxEntry,
          lineId: lineResult.insertId,
          accountId: line.accountId || null,
        });
      }
    }

    await TaxEntryService.saveTaxEntries(conn, {
      companyId, transactionType: "INV", transactionId: invoiceId,
      entries: taxEntriesToSave, userId: req.user.id,
    });

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "INV", transactionId: invoiceId,
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: String(finalStatus).toUpperCase() === "POSTED",
    });

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

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to save invoice", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.put("/api/invoices/:id", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "EDIT"), async (req, res) => {
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
      atcCode,
      taxWithheldAmount,
      currency,
    } = req.body;

    await conn.beginTransaction();

    const finalStatus = status || "DRAFT";
    const foreignGross = Number(totalDebit || 0);

    const ewt = await resolveTaxWithholding(conn, {
      moduleLabel: "Invoice",
      atcCode,
      lines,
      totalCredit: foreignGross,
      clientTaxWithheldAmount: taxWithheldAmount,
      vatKeyword: "output vat",
    });

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    // atc_code is fetched alongside the existing ownership/status columns
    // (Phase 7C.1's existingAtcCode - see reconcileEwtTaxEntry's own
    // comment for why comparing against this exact stored value is what
    // exempts an untouched legacy re-save from the new line requirement).
    const [ownerRows] = await conn.execute("SELECT company_id, transaction_date, status, atc_code FROM invoice_headers WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      await conn.rollback();
      return res.status(404).json({ message: "Invoice not found" });
    }
    // Phase 7A.1: Posted accounting history is immutable - this is an
    // accounting-integrity rule, not an RBAC check, so it applies
    // regardless of role (including SUPER_ADMIN) and cannot be bypassed by
    // the client re-submitting status:"Draft" in the payload, since the
    // decision is based on the STORED status, never the incoming one.
    if (String(ownerRows[0].status).toUpperCase() === "POSTED") {
      await conn.rollback();
      return res.status(409).json({ message: "Posted transactions cannot be edited.", code: "TRANSACTION_ALREADY_POSTED" });
    }
    // Both the period being edited out of and the period being moved into
    // must be open (Checkpoint 5 section 13 - date movement is validated
    // at both ends, not just the destination).
    const existingDateISO = AccountingPeriodService.toDateOnly(ownerRows[0].transaction_date);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: existingDateISO, operation: "EDIT", user: req.user }, conn);
    if (transactionDate && transactionDate !== existingDateISO) {
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "EDIT", user: req.user }, conn);
    }
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "INV", transactionId: Number(id), currencyPayload: currency,
      lines, grossAmount: foreignGross, vatKeyword: "output vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting: String(finalStatus).toUpperCase() === "POSTED",
    });

    // Phase 7C.1: see the identical comment in POST /api/invoices above.
    const reconciledEwt = TaxEntryService.reconcileEwtTaxEntry({
      ewt, lines: currencyResult.lines, existingAtcCode: ownerRows[0].atc_code, expectedSide: "debit", moduleLabel: "Invoice",
    });

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
        recurrence_frequency = ?,
        atc_code = ?,
        tax_type = ?,
        tax_rate = ?,
        tax_withheld_amount = ?,
        taxable_base = ?,
        currency_id = ?
      WHERE id = ? AND company_id = ?`,
      [
        voucherNo,
        customerId || null,
        customerName || "",
        transactionDate || null,
        dueDate || transactionDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        invoiceType === "Recurring" ? "Recurring" : "Standard",
        invoiceType === "Recurring" ? recurrenceFrequency || "Monthly" : null,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        currencyResult.currencyId,
        id,
        companyId,
      ]
    );

    await conn.execute("DELETE FROM invoice_lines WHERE invoice_id = ?", [id]);

    // Phase 7C: see the identical comment in POST /api/invoices above.
    const taxEntriesToSave = [];

    for (const line of currencyResult.lines) {
      if (line.taxEntry && (line.taxEntry.entryType === "INPUT_VAT" || line.taxEntry.entryType === "OUTPUT_VAT")) {
        TaxEntryService.validateVatTaxEntry(line.taxEntry, line.foreignDebit || line.foreignCredit);
      }

      const [lineResult] = await conn.execute(
        `INSERT INTO invoice_lines (
          invoice_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name,
          foreign_debit,
          foreign_credit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.baseDebit,
          line.baseCredit,
          line.genRef || "",
          line.genName || "",
          line.foreignDebit,
          line.foreignCredit,
        ]
      );

      if (reconciledEwt && line === reconciledEwt.lineRef) {
        // Phase 7C.1: the EWT line's saved metadata comes from the
        // RECONCILED (backend-authoritative) entry, never the client's raw
        // taxEntry - see reconcileEwtTaxEntry()'s own comment for why this
        // is what guarantees header/structured-entry/journal-line
        // agreement by construction.
        taxEntriesToSave.push({
          ...reconciledEwt.entry,
          lineId: lineResult.insertId,
          accountId: line.accountId || null,
        });
      } else if (line.taxEntry) {
        // Phase 7C bug fix (caught via Playwright, see the completion
        // report's "bugs discovered/fixed" item): a RELOADED taxEntry
        // already carries its OWN lineId/accountId fields (from
        // loadTaxEntries()'s own SELECT aliases) - spreading it AFTER
        // these two let that stale, previous-save lineId silently
        // clobber the line that was just actually inserted THIS save.
        // The structural fields (lineId/accountId) must always win over
        // whatever the client echoed back; only the content fields
        // (party/amounts/etc.) come from the client's taxEntry.
        taxEntriesToSave.push({
          ...line.taxEntry,
          lineId: lineResult.insertId,
          accountId: line.accountId || null,
        });
      }
    }

    await TaxEntryService.saveTaxEntries(conn, {
      companyId, transactionType: "INV", transactionId: Number(id),
      entries: taxEntriesToSave, userId: req.user.id,
    });

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "INV", transactionId: Number(id),
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: String(finalStatus).toUpperCase() === "POSTED",
    });

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

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update invoice", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.delete("/api/invoices/:id", authenticateToken, authorizePermission("TRANSACTIONS.INVOICE", "DELETE"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);

    await conn.beginTransaction();

    const [ownerRows] = await conn.execute("SELECT company_id, transaction_date, status FROM invoice_headers WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      await conn.rollback();
      return res.status(404).json({ message: "Invoice not found" });
    }
    // Phase 7A.1: Posted transactions cannot be deleted - an accounting-
    // integrity rule, applies regardless of role.
    if (String(ownerRows[0].status).toUpperCase() === "POSTED") {
      await conn.rollback();
      return res.status(409).json({ message: "Posted transactions cannot be deleted.", code: "TRANSACTION_ALREADY_POSTED" });
    }
    const delDateISO = AccountingPeriodService.toDateOnly(ownerRows[0].transaction_date);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: delDateISO, operation: "DELETE", user: req.user }, conn);

    await conn.execute(
      `DELETE FROM transaction_applications
       WHERE source_type = 'INV'
         AND source_id = ?`,
      [id]
    );

    await conn.execute("DELETE FROM invoice_headers WHERE id = ? AND company_id = ?", [id, companyId]);

    await conn.commit();

    res.json({
      success: true,
      message: "Invoice deleted successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("DELETE INVOICE ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to delete invoice", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});


// ===================== OFFICIAL RECEIPT API =====================

app.get("/api/or", authenticateToken, authorizePermission("TRANSACTIONS.OR", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const [rows] = await pool.execute(`
      SELECT
        or_headers.id AS id,
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
        DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate,
        or_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.foreign_total AS foreignTotal
      FROM or_headers
      LEFT JOIN currencies cur ON cur.id = or_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'OR' AND snap.transaction_id = or_headers.id
      WHERE or_headers.company_id = ?
      ORDER BY or_headers.id DESC
    `, [companyId]);

    res.json(rows);
  } catch (err) {
    console.error("GET OR ERROR:", err);
    res.status(500).json({ message: "Failed to load OR records" });
  }
});

app.post("/api/or", authenticateToken, authorizePermission("TRANSACTIONS.OR", "CREATE"), async (req, res) => {
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
      atcCode,
      taxWithheldAmount,
      currency,
    } = req.body;

    const finalCustomerId = customerId ?? req.body.partyId ?? null;
    const finalCustomerName = customerName || req.body.partyName || "";
    const finalStatus = status || "Draft";
    const isPosting = String(finalStatus).toUpperCase() === "POSTED";

    const ewt = await resolveTaxWithholding(conn, {
      moduleLabel: "OR",
      atcCode,
      lines,
      totalCredit: Number(totalDebit) || 0,
      clientTaxWithheldAmount: taxWithheldAmount,
      vatKeyword: "output vat",
    });

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    // Locked on the OR's OWN accounting date only - an OR settling an
    // older closed-period Invoice is normal and must remain allowed (the
    // accounting effect happens in the OR's period, not the Invoice's -
    // Checkpoint 5 section 16/17).
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "CREATE", user: req.user }, conn);
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "OR", transactionId: null, currencyPayload: currency,
      lines, grossAmount: Number(totalDebit) || 0, vatKeyword: "output vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting,
    });

    const [result] = await conn.execute(
      `INSERT INTO or_headers(
        company_id,
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
        check_date,
        atc_code,
        tax_type,
        tax_rate,
        tax_withheld_amount,
        taxable_base,
        currency_id
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        companyId,
        voucherNo || "",
        finalCustomerId,
        finalCustomerName,
        transactionDate || null,
        referenceNo || "",
        receiptNo || "",
        description || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        paymentMethod === "Check" ? "Check" : "Cash",
        bankAccountId || null,
        paymentMethod === "Check" ? checkNo || "" : "",
        paymentMethod === "Check" ? checkDate || null : null,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        currencyResult.currencyId,
      ]
    );

    const orId = result.insertId;

    for (const line of currencyResult.lines) {
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
          credit,
          foreign_debit,
          foreign_credit
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          orId,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          line.baseDebit,
          line.baseCredit,
          line.foreignDebit,
          line.foreignCredit,
        ]
      );
    }

    const orApplications = [];
    for (const appItem of invoiceApplications) {
      orApplications.push(
        await applyInvoicePayment(conn, {
          appItem,
          appliedType: "OR",
          appliedId: orId,
          paymentCurrencyCode: currencyResult.currencyCode,
          paymentExchangeRate: currencyResult.rateInfo.exchangeRate,
          baseCurrencyCode: currencyResult.baseCurrencyCode,
          fallbackDate: transactionDate,
          isPosting,
          companyId,
        })
      );
    }
    // Checkpoint 3FX: corrects the auto-filled AR line to each invoice's
    // own historical rate and adds the realized FX gain/loss line(s)
    // needed to keep this OR balanced - a complete no-op when every
    // application settled at its source's own rate (fxDifference all 0).
    const orFxResult = await applyForeignSettlementToLines(conn, {
      headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
      transactionId: orId, applications: orApplications, perspective: "RECEIVABLE",
    });
    await logFxSettlementAudit(conn, {
      req, moduleKey: "TRANSACTIONS.OR", appliedType: "OR", appliedId: orId,
      applications: orApplications, fxResult: orFxResult,
    });

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "OR", transactionId: orId,
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

    await conn.commit();

    res.json({
      success: true,
      id: orId,
      message: "OR saved successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE OR ERROR:", err);

    res.status(err.statusCode || 500).json({
      message: err.message || "Failed to save OR",
      ...(err.statusCode && err.code ? { code: err.code } : {}),
    });
  } finally {
    conn.release();
  }
});

app.get("/api/or/:id", authenticateToken, authorizePermission("TRANSACTIONS.OR", "VIEW"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

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
        DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate,
        atc_code AS atcCode,
        tax_type AS taxType,
        tax_rate AS taxRate,
        tax_withheld_amount AS taxWithheldAmount,
        taxable_base AS taxableBase,
        currency_id AS currencyId
      FROM or_headers
      WHERE id = ? AND company_id = ?`,
      [id, companyId]
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
        gen_name AS genName,
        foreign_debit AS foreignDebit,
        foreign_credit AS foreignCredit
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
        DATE_FORMAT(application_date, '%Y-%m-%d') AS applicationDate,
        source_currency_code AS sourceCurrencyCode,
        payment_currency_code AS paymentCurrencyCode,
        foreign_amount_applied AS foreignAmountApplied,
        source_exchange_rate AS sourceExchangeRate,
        payment_exchange_rate AS paymentExchangeRate,
        source_base_amount AS sourceBaseAmount,
        payment_base_amount AS paymentBaseAmount,
        fx_difference AS fxDifference,
        fx_direction AS fxDirection
      FROM transaction_applications
      WHERE applied_type = 'OR'
        AND applied_id = ?
      ORDER BY id DESC`,
      [id]
    );

    const currencySnapshot = await TransactionCurrencyService.getSnapshot("OR", id);

    res.json({
      ...headers[0],
      lines,
      applications,
      currency: currencySnapshot,
    });
  } catch (err) {
    console.error("GET OR DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load OR details" });
  }
});

app.put("/api/or/:id", authenticateToken, authorizePermission("TRANSACTIONS.OR", "EDIT"), async (req, res) => {
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
      atcCode,
      taxWithheldAmount,
      currency,
    } = req.body;

    const finalStatus = status || "Draft";
    const isPosting = String(finalStatus).toUpperCase() === "POSTED";

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);

    await conn.beginTransaction();

    const [ownerRows] = await conn.execute("SELECT company_id, transaction_date, status FROM or_headers WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      await conn.rollback();
      return res.status(404).json({ message: "OR not found" });
    }
    // Phase 7A.1: a Posted OR cannot be freely edited. This guards OR's OWN
    // record only - it is structurally separate from updateInvoicePaymentStatus(),
    // which other OR/CV routes call as a side effect to keep a SOURCE
    // Invoice's paid_amount/balance_amount/payment_status in sync with
    // settlement applications; that call never goes through this route and
    // is unaffected by this guard.
    if (String(ownerRows[0].status).toUpperCase() === "POSTED") {
      await conn.rollback();
      return res.status(409).json({ message: "Posted transactions cannot be edited.", code: "TRANSACTION_ALREADY_POSTED" });
    }
    const existingDateISO = AccountingPeriodService.toDateOnly(ownerRows[0].transaction_date);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: existingDateISO, operation: "EDIT", user: req.user }, conn);
    if (transactionDate && transactionDate !== existingDateISO) {
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "EDIT", user: req.user }, conn);
    }

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

        // Checkpoint 3D: recompute foreign paid/balance from source of
        // truth (the transaction_applications rows already deleted in STEP
        // 2) rather than reverse-arithmetic on the foreign side - same
        // "recompute, don't decrement" pattern updateInvoicePaymentStatus
        // already uses. No-op for a base-currency beginning balance (no
        // snapshot -> hasForeignCurrency: false).
        const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, {
          transactionType: "AR_BEGINNING",
          transactionId: oldItem.sourceId,
        });
        if (foreignState.hasForeignCurrency) {
          await conn.execute(
            `UPDATE arap_beginning_balance_lines SET foreign_paid_amount = ?, foreign_balance_amount = ? WHERE id = ?`,
            [foreignState.foreignPaidAmount, foreignState.foreignBalanceAmount, oldItem.sourceId]
          );
        }
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
    const ewt = await resolveTaxWithholding(conn, {
      moduleLabel: "OR",
      atcCode,
      lines,
      totalCredit: Number(totalDebit) || 0,
      clientTaxWithheldAmount: taxWithheldAmount,
      vatKeyword: "output vat",
    });

    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "OR", transactionId: Number(id), currencyPayload: currency,
      lines, grossAmount: Number(totalDebit) || 0, vatKeyword: "output vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting,
    });

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
         check_date = ?,
         atc_code = ?,
         tax_type = ?,
         tax_rate = ?,
         tax_withheld_amount = ?,
         taxable_base = ?,
         currency_id = ?
       WHERE id = ? AND company_id = ?`,
      [
        voucherNo || "",
        customerId || null,
        customerName || "",
        transactionDate || null,
        referenceNo || "",
        receiptNo || "",
        description || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        paymentMethod === "Check" ? "Check" : "Cash",
        bankAccountId || null,
        paymentMethod === "Check" ? checkNo || "" : "",
        paymentMethod === "Check" ? checkDate || null : null,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        currencyResult.currencyId,
        id,
        companyId,
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

    for (const line of currencyResult.lines) {
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
           credit,
           foreign_debit,
           foreign_credit
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          line.baseDebit,
          line.baseCredit,
          line.foreignDebit,
          line.foreignCredit,
        ]
      );
    }

    /*
     * STEP 7:
     * Save the edited invoice applications.
     */
    const orApplications = [];
    for (const appItem of invoiceApplications) {
      orApplications.push(
        await applyInvoicePayment(conn, {
          appItem,
          appliedType: "OR",
          appliedId: Number(id),
          paymentCurrencyCode: currencyResult.currencyCode,
          paymentExchangeRate: currencyResult.rateInfo.exchangeRate,
          baseCurrencyCode: currencyResult.baseCurrencyCode,
          fallbackDate: transactionDate,
          isPosting,
          companyId,
        })
      );
    }
    const orFxResult = await applyForeignSettlementToLines(conn, {
      headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id",
      transactionId: Number(id), applications: orApplications, perspective: "RECEIVABLE",
    });
    await logFxSettlementAudit(conn, {
      req, moduleKey: "TRANSACTIONS.OR", appliedType: "OR", appliedId: Number(id),
      applications: orApplications, fxResult: orFxResult,
    });

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "OR", transactionId: Number(id),
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

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

    res.status(err.statusCode || 500).json({
      message: err.message || "Failed to update Official Receipt",
      ...(err.statusCode && err.code ? { code: err.code } : {}),
    });
  } finally {
    conn.release();
  }
});

// ===================== APV API =====================

app.get("/api/apv", authenticateToken, authorizePermission("TRANSACTIONS.APV", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const [rows] = await pool.execute(`
      SELECT
        apv_headers.id AS id,
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
        apv_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.foreign_total AS foreignTotal,
        apv_headers.created_at AS createdAt,
        apv_headers.updated_at AS updatedAt
      FROM apv_headers
      LEFT JOIN currencies cur ON cur.id = apv_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'APV' AND snap.transaction_id = apv_headers.id
      WHERE apv_headers.company_id = ?
      ORDER BY apv_headers.id DESC
    `, [companyId]);

    res.json(rows);
  } catch (err) {
    console.error("GET APV ERROR:", err);
    res.status(500).json({ message: "Failed to load APV records" });
  }
});

app.get("/api/apv/unpaid", authenticateToken, authorizePermission("TRANSACTIONS.APV", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const { supplierId, supplierName } = req.query;

    const params = [companyId];
    let supplierFilterApv = "";
    let supplierFilterBb = "";

    if (supplierId) {
      supplierFilterApv = " AND supplier_id = ? ";
      supplierFilterBb = " AND l.party_id = ? ";
      params.push(supplierId);
    } else if (supplierName) {
      supplierFilterApv = " AND TRIM(LOWER(supplier_name)) = TRIM(LOWER(?)) ";
      supplierFilterBb = " AND TRIM(LOWER(l.party_name)) = TRIM(LOWER(?)) ";
      params.push(supplierName);
    }
    params.push(companyId);
    if (supplierId) params.push(supplierId);
    else if (supplierName) params.push(supplierName);

    const [rows] = await pool.execute(
      `
      SELECT
        apv_headers.id AS id,
        'APV' AS sourceType,
        voucher_no AS voucherNo,
        supplier_id AS supplierId,
        supplier_name AS supplierName,
        total_credit AS totalAmount,
        COALESCE(paid_amount, 0) AS paidAmount,
        COALESCE(balance_amount, total_credit, 0) AS balanceAmount,
        apv_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.exchange_rate AS sourceExchangeRate,
        snap.foreign_total AS foreignOriginalAmount,
        apv_headers.foreign_paid_amount AS foreignPaidAmount,
        apv_headers.foreign_balance_amount AS foreignBalanceAmount
      FROM apv_headers
      LEFT JOIN currencies cur ON cur.id = apv_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'APV' AND snap.transaction_id = apv_headers.id
      WHERE apv_headers.company_id = ?
        AND COALESCE(balance_amount, total_credit, 0) > 0
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
        COALESCE(l.balance_amount, l.credit, 0) AS balanceAmount,
        l.currency_id AS currencyId,
        bbcur.currency_code AS currencyCode,
        bbcur.currency_symbol AS currencySymbol,
        bbsnap.exchange_rate AS sourceExchangeRate,
        l.foreign_original_amount AS foreignOriginalAmount,
        l.foreign_paid_amount AS foreignPaidAmount,
        l.foreign_balance_amount AS foreignBalanceAmount
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
      LEFT JOIN currencies bbcur ON bbcur.id = l.currency_id
      LEFT JOIN transaction_currency_snapshots bbsnap ON bbsnap.transaction_type = 'AP_BEGINNING' AND bbsnap.transaction_id = l.id
      WHERE h.balance_type = 'AP'
        AND h.company_id = ?
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

app.get("/api/apv/:id", authenticateToken, authorizePermission("TRANSACTIONS.APV", "VIEW"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

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
        taxable_base AS taxableBase,
        payee_tin AS payeeTin,
        currency_id AS currencyId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM apv_headers
      WHERE id = ? AND company_id = ?`,
      [id, companyId]
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
        gen_name AS genName,
        foreign_debit AS foreignDebit,
        foreign_credit AS foreignCredit
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

    const currencySnapshot = await TransactionCurrencyService.getSnapshot("APV", id);
    const taxEntries = await TaxEntryService.loadTaxEntries("APV", id);

    res.json({
      ...headers[0],
      lines,
      applications,
      currency: currencySnapshot,
      taxEntries,
    });
  } catch (err) {
    console.error("GET APV DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load APV details" });
  }
});

// The backend is the final authority on withholding tax figures - it never
// trusts the client-submitted atcCode's rate/type or the client-submitted
// taxWithheldAmount. It looks up the ATC code's authoritative rate/type
// from ewt_library, independently derives the VAT-exclusive taxable base
// from the submitted journal lines (see ewtCalculationService), and only
// keeps the client's amount if it agrees with the backend recalculation
// within a one-centavo rounding tolerance - otherwise it silently corrects
// to the backend-computed value (rather than rejecting the save) and logs
// the discrepancy for follow-up.
//
// vatKeyword follows the same direction used to auto-detect the VAT account
// on the frontend: "output vat" for INV/OR (we're the seller charging VAT),
// "input vat" for APV/CV/PO (we're the buyer paying VAT).
async function resolveTaxWithholding(conn, { moduleLabel, atcCode, lines, totalCredit, clientTaxWithheldAmount, vatKeyword }) {
  if (!atcCode) {
    return { atcCode: null, taxType: null, taxRate: null, taxableBase: null, taxWithheldAmount: null };
  }

  const [ewtRows] = await conn.execute(
    "SELECT atc_code AS atcCode, tax_type AS taxType, rate FROM ewt_library WHERE atc_code = ? LIMIT 1",
    [atcCode]
  );
  if (!ewtRows.length) {
    // Unknown/stale ATC code - don't invent a rate; store no withholding.
    return { atcCode: null, taxType: null, taxRate: null, taxableBase: null, taxWithheldAmount: null };
  }

  const { taxType, rate } = ewtRows[0];
  const taxableBase = computeEwtTaxableBase({ grossAmount: totalCredit, lines, vatKeyword });
  const backendAmount = computeEwtAmount({ taxableBase, ewtRate: rate });

  const clientAmount = Number(clientTaxWithheldAmount) || 0;
  const finalAmount =
    Math.abs(clientAmount - backendAmount) <= 0.01 ? clientAmount : backendAmount;

  if (Math.abs(clientAmount - backendAmount) > 0.01) {
    console.warn(
      `${moduleLabel} EWT mismatch for ATC ${atcCode}: client sent ${clientAmount}, backend computed ${backendAmount} ` +
      `(base ${taxableBase} x ${rate}%). Using backend-computed value.`
    );
  }

  return { atcCode, taxType, taxRate: rate, taxableBase, taxWithheldAmount: finalAmount };
}

async function resolveApvTaxWithholding(conn, { atcCode, lines, totalCredit, clientTaxWithheldAmount }) {
  return resolveTaxWithholding(conn, {
    moduleLabel: "APV",
    atcCode,
    lines,
    totalCredit,
    clientTaxWithheldAmount,
    vatKeyword: "input vat",
  });
}

app.post("/api/apv", authenticateToken, authorizePermission("TRANSACTIONS.APV", "CREATE"), async (req, res) => {
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
      taxWithheldAmount,
      payeeTin,
      currency,
    } = req.body;

    await conn.beginTransaction();

    const finalStatus = status || "DRAFT";
    const foreignGross = Number(totalCredit || 0);

    const ewt = await resolveApvTaxWithholding(conn, {
      atcCode,
      lines,
      totalCredit: foreignGross,
      clientTaxWithheldAmount: taxWithheldAmount,
    });

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "CREATE", user: req.user }, conn);
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "APV", transactionId: null, currencyPayload: currency,
      lines, grossAmount: foreignGross, vatKeyword: "input vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting: String(finalStatus).toUpperCase() === "POSTED",
    });

    // Phase 7C.1: see the identical comment in POST /api/invoices above -
    // APV is "outbound" (credit side; a Withholding Tax Payable liability).
    const reconciledEwt = TaxEntryService.reconcileEwtTaxEntry({
      ewt, lines: currencyResult.lines, existingAtcCode: null, expectedSide: "credit", moduleLabel: "APV",
    });

    const [result] = await conn.execute(
      `INSERT INTO apv_headers (
        company_id,
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
        taxable_base,
        payee_tin,
        currency_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        voucherNo,
        supplierId || null,
        supplierName || "",
        transactionDate || null,
        dueDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        0,
        currencyResult.baseTotalCredit,
        "Unpaid",
        finalStatus,
        sourcePoId || null,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        payeeTin || null,
        currencyResult.currencyId,
      ]
    );

    const apvId = result.insertId;

    if (sourcePoId) {
      await conn.execute(
        "UPDATE purchase_order_headers SET status = 'Converted' WHERE id = ?",
        [sourcePoId]
      );
    }

    const taxEntriesToSave = [];

    for (const line of currencyResult.lines) {
      if (line.taxEntry && line.taxEntry.entryType === "INPUT_VAT") {
        TaxEntryService.validateVatTaxEntry(line.taxEntry, line.foreignDebit || line.foreignCredit);
      }

      const [lineResult] = await conn.execute(
        `INSERT INTO apv_lines (
          apv_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name,
          foreign_debit,
          foreign_credit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          apvId,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.baseDebit,
          line.baseCredit,
          line.genRef || "",
          line.genName || "",
          line.foreignDebit,
          line.foreignCredit,
        ]
      );

      if (reconciledEwt && line === reconciledEwt.lineRef) {
        // Phase 7C.1: the EWT line's saved metadata comes from the
        // RECONCILED (backend-authoritative) entry, never the client's raw
        // taxEntry - see reconcileEwtTaxEntry()'s own comment for why this
        // is what guarantees header/structured-entry/journal-line
        // agreement by construction.
        taxEntriesToSave.push({
          ...reconciledEwt.entry,
          lineId: lineResult.insertId,
          accountId: line.accountId || null,
        });
      } else if (line.taxEntry) {
        // Phase 7C bug fix (caught via Playwright, see the completion
        // report's "bugs discovered/fixed" item): a RELOADED taxEntry
        // already carries its OWN lineId/accountId fields (from
        // loadTaxEntries()'s own SELECT aliases) - spreading it AFTER
        // these two let that stale, previous-save lineId silently
        // clobber the line that was just actually inserted THIS save.
        // The structural fields (lineId/accountId) must always win over
        // whatever the client echoed back; only the content fields
        // (party/amounts/etc.) come from the client's taxEntry.
        taxEntriesToSave.push({
          ...line.taxEntry,
          lineId: lineResult.insertId,
          accountId: line.accountId || null,
        });
      }
    }

    await TaxEntryService.saveTaxEntries(conn, {
      companyId, transactionType: "APV", transactionId: apvId,
      entries: taxEntriesToSave, userId: req.user.id,
    });

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "APV", transactionId: apvId,
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: String(finalStatus).toUpperCase() === "POSTED",
    });

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

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to save APV", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.put("/api/apv/:id", authenticateToken, authorizePermission("TRANSACTIONS.APV", "EDIT"), async (req, res) => {
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
      taxWithheldAmount,
      payeeTin,
      currency,
    } = req.body;

    await conn.beginTransaction();

    const finalStatus = status || "DRAFT";
    const foreignGross = Number(totalCredit || 0);

    // Recomputed on every explicit edit, same as on create - this is an
    // "edit where allowed" per the corrected-logic policy, not a background
    // bulk correction of historical rows (that's the separate, read-only
    // Phase 4 audit). A transaction nobody opens/re-saves is never touched.
    const ewt = await resolveApvTaxWithholding(conn, {
      atcCode,
      lines,
      totalCredit: foreignGross,
      clientTaxWithheldAmount: taxWithheldAmount,
    });

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    // atc_code fetched alongside for Phase 7C.1's existingAtcCode - see the
    // identical comment in PUT /api/invoices/:id above.
    const [ownerRows] = await conn.execute("SELECT company_id, transaction_date, status, atc_code FROM apv_headers WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      await conn.rollback();
      return res.status(404).json({ message: "APV not found" });
    }
    // Phase 7A.1: Posted transactions cannot be freely edited.
    if (String(ownerRows[0].status).toUpperCase() === "POSTED") {
      await conn.rollback();
      return res.status(409).json({ message: "Posted transactions cannot be edited.", code: "TRANSACTION_ALREADY_POSTED" });
    }
    const existingDateISO = AccountingPeriodService.toDateOnly(ownerRows[0].transaction_date);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: existingDateISO, operation: "EDIT", user: req.user }, conn);
    if (transactionDate && transactionDate !== existingDateISO) {
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "EDIT", user: req.user }, conn);
    }
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "APV", transactionId: Number(id), currencyPayload: currency,
      lines, grossAmount: foreignGross, vatKeyword: "input vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting: String(finalStatus).toUpperCase() === "POSTED",
    });

    // Phase 7C.1: see the identical comment in POST /api/invoices above.
    const reconciledEwt = TaxEntryService.reconcileEwtTaxEntry({
      ewt, lines: currencyResult.lines, existingAtcCode: ownerRows[0].atc_code, expectedSide: "credit", moduleLabel: "APV",
    });

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
        taxable_base = ?,
        payee_tin = ?,
        currency_id = ?
      WHERE id = ? AND company_id = ?`,
      [
        voucherNo,
        supplierId || null,
        supplierName || "",
        transactionDate || null,
        dueDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        payeeTin || null,
        currencyResult.currencyId,
        id,
        companyId,
      ]
    );

    await conn.execute("DELETE FROM apv_lines WHERE apv_id = ?", [id]);

    const taxEntriesToSave = [];

    for (const line of currencyResult.lines) {
      if (line.taxEntry && line.taxEntry.entryType === "INPUT_VAT") {
        TaxEntryService.validateVatTaxEntry(line.taxEntry, line.foreignDebit || line.foreignCredit);
      }

      const [lineResult] = await conn.execute(
        `INSERT INTO apv_lines (
          apv_id,
          account_id,
          account_code,
          account_title,
          particulars,
          debit,
          credit,
          gen_ref,
          gen_name,
          foreign_debit,
          foreign_credit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.baseDebit,
          line.baseCredit,
          line.genRef || "",
          line.genName || "",
          line.foreignDebit,
          line.foreignCredit,
        ]
      );

      if (reconciledEwt && line === reconciledEwt.lineRef) {
        // Phase 7C.1: the EWT line's saved metadata comes from the
        // RECONCILED (backend-authoritative) entry, never the client's raw
        // taxEntry - see reconcileEwtTaxEntry()'s own comment for why this
        // is what guarantees header/structured-entry/journal-line
        // agreement by construction.
        taxEntriesToSave.push({
          ...reconciledEwt.entry,
          lineId: lineResult.insertId,
          accountId: line.accountId || null,
        });
      } else if (line.taxEntry) {
        // Phase 7C bug fix (caught via Playwright, see the completion
        // report's "bugs discovered/fixed" item): a RELOADED taxEntry
        // already carries its OWN lineId/accountId fields (from
        // loadTaxEntries()'s own SELECT aliases) - spreading it AFTER
        // these two let that stale, previous-save lineId silently
        // clobber the line that was just actually inserted THIS save.
        // The structural fields (lineId/accountId) must always win over
        // whatever the client echoed back; only the content fields
        // (party/amounts/etc.) come from the client's taxEntry.
        taxEntriesToSave.push({
          ...line.taxEntry,
          lineId: lineResult.insertId,
          accountId: line.accountId || null,
        });
      }
    }

    await TaxEntryService.saveTaxEntries(conn, {
      companyId, transactionType: "APV", transactionId: Number(id),
      entries: taxEntriesToSave, userId: req.user.id,
    });

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "APV", transactionId: Number(id),
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: String(finalStatus).toUpperCase() === "POSTED",
    });

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

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update APV", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.delete("/api/apv/:id", authenticateToken, authorizePermission("TRANSACTIONS.APV", "DELETE"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);

    await conn.beginTransaction();

    const [ownerRows] = await conn.execute("SELECT company_id, transaction_date, status FROM apv_headers WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      await conn.rollback();
      return res.status(404).json({ message: "APV not found" });
    }
    // Phase 7A.1: Posted transactions cannot be deleted.
    if (String(ownerRows[0].status).toUpperCase() === "POSTED") {
      await conn.rollback();
      return res.status(409).json({ message: "Posted transactions cannot be deleted.", code: "TRANSACTION_ALREADY_POSTED" });
    }
    const delDateISO = AccountingPeriodService.toDateOnly(ownerRows[0].transaction_date);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: delDateISO, operation: "DELETE", user: req.user }, conn);

    await conn.execute(
      `DELETE FROM transaction_applications
       WHERE source_type = 'APV'
         AND source_id = ?`,
      [id]
    );

    await conn.execute("DELETE FROM apv_headers WHERE id = ? AND company_id = ?", [id, companyId]);

    await conn.commit();

    res.json({
      success: true,
      message: "APV deleted successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("DELETE APV ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to delete APV", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

// ===================== PURCHASE ORDER API =====================

app.get("/api/purchase-orders", authenticateToken, authorizePermission("TRANSACTIONS.PURCHASE_ORDER", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const [rows] = await pool.execute(`
      SELECT
        purchase_order_headers.id AS id,
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
        purchase_order_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.foreign_total AS foreignTotal,
        purchase_order_headers.created_at AS createdAt,
        purchase_order_headers.updated_at AS updatedAt
      FROM purchase_order_headers
      LEFT JOIN currencies cur ON cur.id = purchase_order_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'PO' AND snap.transaction_id = purchase_order_headers.id
      WHERE purchase_order_headers.company_id = ?
      ORDER BY purchase_order_headers.id DESC
    `, [companyId]);

    res.json(rows);
  } catch (err) {
    console.error("GET PURCHASE ORDER ERROR:", err);
    res.status(500).json({ message: "Failed to load Purchase Order records" });
  }
});

app.get("/api/purchase-orders/open", authenticateToken, authorizePermission("TRANSACTIONS.PURCHASE_ORDER", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const { supplierId, supplierName } = req.query;

    const params = [companyId];
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
        AND company_id = ?
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

app.get("/api/purchase-orders/:id", authenticateToken, authorizePermission("TRANSACTIONS.PURCHASE_ORDER", "VIEW"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

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
        atc_code AS atcCode,
        tax_type AS taxType,
        tax_rate AS taxRate,
        tax_withheld_amount AS taxWithheldAmount,
        taxable_base AS taxableBase,
        payee_tin AS payeeTin,
        currency_id AS currencyId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM purchase_order_headers
      WHERE id = ? AND company_id = ?`,
      [id, companyId]
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
        gen_name AS genName,
        foreign_debit AS foreignDebit,
        foreign_credit AS foreignCredit
      FROM purchase_order_lines
      WHERE po_id = ?
      ORDER BY id ASC`,
      [id]
    );

    const currencySnapshot = await TransactionCurrencyService.getSnapshot("PO", id);

    res.json({
      ...headers[0],
      lines,
      currency: currencySnapshot,
    });
  } catch (err) {
    console.error("GET PURCHASE ORDER DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load Purchase Order details" });
  }
});

app.post("/api/purchase-orders", authenticateToken, authorizePermission("TRANSACTIONS.PURCHASE_ORDER", "CREATE"), async (req, res) => {
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
      totalCredit,
      status,
      lines,
      atcCode,
      taxWithheldAmount,
      payeeTin,
      currency,
    } = req.body;

    const finalStatus = status === "Draft" ? "Draft" : "Open";
    // PO never posts to GL (confirmed non-GL - absent from every ledger/
    // trial-balance union). Its own commitment boundary is Draft -> Open,
    // the PO equivalent of Invoice/APV's Draft -> Posted, so the currency
    // locks there instead of on a "Posted" status that PO doesn't have.
    const isPosting = finalStatus === "Open";
    const foreignGross = Number(totalCredit || 0);

    const ewt = await resolveTaxWithholding(conn, {
      moduleLabel: "PO",
      atcCode,
      lines,
      totalCredit: foreignGross,
      clientTaxWithheldAmount: taxWithheldAmount,
      vatKeyword: "input vat",
    });

    await conn.beginTransaction();

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    // PO never affects the ledger (see above), so this is a backdating/
    // audit-trail consistency control rather than a ledger-protection one
    // (Checkpoint 5 section 24 - documented decision, not an oversight).
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "CREATE", user: req.user }, conn);
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "PO", transactionId: null, currencyPayload: currency,
      lines, grossAmount: foreignGross, vatKeyword: "input vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting,
    });

    const [result] = await conn.execute(
      `INSERT INTO purchase_order_headers (
        company_id,
        voucher_no,
        supplier_id,
        supplier_name,
        transaction_date,
        reference_no,
        description,
        remarks,
        total_debit,
        total_credit,
        status,
        atc_code,
        tax_type,
        tax_rate,
        tax_withheld_amount,
        taxable_base,
        payee_tin,
        currency_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companyId,
        voucherNo,
        supplierId || null,
        supplierName || "",
        transactionDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        payeeTin || null,
        currencyResult.currencyId,
      ]
    );

    const poId = result.insertId;

    for (const line of currencyResult.lines) {
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
          gen_name,
          foreign_debit,
          foreign_credit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          poId,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.baseDebit,
          line.baseCredit,
          line.genRef || "",
          line.genName || "",
          line.foreignDebit,
          line.foreignCredit,
        ]
      );
    }

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "PO", transactionId: poId,
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

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

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to save Purchase Order", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.put("/api/purchase-orders/:id", authenticateToken, authorizePermission("TRANSACTIONS.PURCHASE_ORDER", "EDIT"), async (req, res) => {
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
      totalCredit,
      status,
      lines,
      atcCode,
      taxWithheldAmount,
      payeeTin,
      currency,
    } = req.body;

    const finalStatus = status || "Open";
    const isPosting = finalStatus !== "Draft";
    const foreignGross = Number(totalCredit || 0);

    const ewt = await resolveTaxWithholding(conn, {
      moduleLabel: "PO",
      atcCode,
      lines,
      totalCredit: foreignGross,
      clientTaxWithheldAmount: taxWithheldAmount,
      vatKeyword: "input vat",
    });

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);

    await conn.beginTransaction();

    const [ownerRows] = await conn.execute("SELECT company_id, transaction_date FROM purchase_order_headers WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      await conn.rollback();
      return res.status(404).json({ message: "Purchase Order not found" });
    }
    const existingDateISO = AccountingPeriodService.toDateOnly(ownerRows[0].transaction_date);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: existingDateISO, operation: "EDIT", user: req.user }, conn);
    if (transactionDate && transactionDate !== existingDateISO) {
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "EDIT", user: req.user }, conn);
    }

    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "PO", transactionId: Number(id), currencyPayload: currency,
      lines, grossAmount: foreignGross, vatKeyword: "input vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting,
    });

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
        status = ?,
        atc_code = ?,
        tax_type = ?,
        tax_rate = ?,
        tax_withheld_amount = ?,
        taxable_base = ?,
        payee_tin = ?,
        currency_id = ?
      WHERE id = ? AND company_id = ?`,
      [
        voucherNo,
        supplierId || null,
        supplierName || "",
        transactionDate || null,
        referenceNo || "",
        description || "",
        remarks || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        payeeTin || null,
        currencyResult.currencyId,
        id,
        companyId,
      ]
    );

    await conn.execute("DELETE FROM purchase_order_lines WHERE po_id = ?", [id]);

    for (const line of currencyResult.lines) {
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
          gen_name,
          foreign_debit,
          foreign_credit
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          line.accountId || null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.baseDebit,
          line.baseCredit,
          line.genRef || "",
          line.genName || "",
          line.foreignDebit,
          line.foreignCredit,
        ]
      );
    }

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "PO", transactionId: Number(id),
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

    await conn.commit();

    res.json({
      success: true,
      message: "Purchase Order updated successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE PURCHASE ORDER ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update Purchase Order", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.delete("/api/purchase-orders/:id", authenticateToken, authorizePermission("TRANSACTIONS.PURCHASE_ORDER", "DELETE"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);

    const [ownerRows] = await pool.execute("SELECT company_id, transaction_date FROM purchase_order_headers WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      return res.status(404).json({ message: "Purchase Order not found" });
    }
    const delDateISO = AccountingPeriodService.toDateOnly(ownerRows[0].transaction_date);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: delDateISO, operation: "DELETE", user: req.user });

    await pool.execute("DELETE FROM purchase_order_headers WHERE id = ? AND company_id = ?", [id, companyId]);

    res.json({
      success: true,
      message: "Purchase Order deleted successfully",
    });
  } catch (err) {
    console.error("DELETE PURCHASE ORDER ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to delete Purchase Order", ...(err.statusCode && err.code ? { code: err.code } : {}) });
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

app.get("/api/quotations", authenticateToken, authorizePermission("TRANSACTIONS.QUOTATION", "VIEW"), async (req, res) => {
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

app.get("/api/quotations/:id", authenticateToken, authorizePermission("TRANSACTIONS.QUOTATION", "VIEW"), async (req, res) => {
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

app.post("/api/quotations", authenticateToken, authorizePermission("TRANSACTIONS.QUOTATION", "CREATE"), async (req, res) => {
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

app.put("/api/quotations/:id", authenticateToken, authorizePermission("TRANSACTIONS.QUOTATION", "EDIT"), async (req, res) => {
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

app.delete("/api/quotations/:id", authenticateToken, authorizePermission("TRANSACTIONS.QUOTATION", "DELETE"), async (req, res) => {
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

app.post("/api/quotations/:id/convert-to-invoice", authenticateToken, authorizePermission("TRANSACTIONS.QUOTATION", "EDIT"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body?.companyId);

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
        company_id,
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
      ) VALUES (?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, 'Unpaid', 'Draft', ?)`,
      [
        companyId,
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

app.get("/api/posting/pending", authenticateToken, authorizePermission("POSTING", "VIEW"), async (req, res) => {
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

// transactionType is only set for modules wired to the currency snapshot
// table (Invoice, APV, OR, CV as of Checkpoint 3B) - bulk-posting a module
// without one is unaffected, exactly as before. isPaymentDoc marks OR/CV
// specifically, since only they can carry a rate-mismatched application
// (section 23/24) that must block this bulk path exactly like the
// per-transaction Save/Post path already does.
const AR_POST_TARGETS = [
  { table: "invoice_headers", status: "Posted", transactionType: "INV" },
  { table: "or_headers", status: "Posted", transactionType: "OR", isPaymentDoc: true },
];

const AP_POST_TARGETS = [
  { table: "apv_headers", status: "Posted", transactionType: "APV" },
  { table: "cv_headers", status: "Posted", transactionType: "CV", isPaymentDoc: true },
  { table: "purchase_order_headers", status: "Open" },
];

app.post("/api/posting/post", authenticateToken, authorizePermission("POSTING", "POST"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { scope } = req.body;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);

    const targets =
      scope === "ar"
        ? AR_POST_TARGETS
        : scope === "ap"
        ? AP_POST_TARGETS
        : [...AR_POST_TARGETS, ...AP_POST_TARGETS];

    await conn.beginTransaction();

    let postedCount = 0;
    let blockedCount = 0;
    let periodBlockedCount = 0;

    for (const target of targets) {
      // Rate locking (section 10) needs to know WHICH rows are about to
      // transition, which a bare UPDATE...WHERE doesn't report - captured
      // before the update so exactly those transactions' snapshots (not
      // every unlocked snapshot of this type) get locked. Also carries
      // transaction_date now (Checkpoint 5 section 27) so closed-period
      // drafts can be excluded from the batch the same way FX-mismatched
      // rows already are below - bulk posting must never become a bypass
      // for the per-transaction period check.
      let draftRows = [];
      const [rawDraftRows] = await conn.execute(
        `SELECT id, transaction_date AS transactionDate FROM ${target.table} WHERE UPPER(status) = 'DRAFT' AND company_id = ?`,
        [companyId]
      );
      draftRows = rawDraftRows;
      let draftIds = draftRows.map((r) => r.id);

      const distinctDates = [...new Set(draftRows.map((r) => AccountingPeriodService.toDateOnly(r.transactionDate)))];
      const openDates = new Set();
      for (const dateStr of distinctDates) {
        try {
          await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: dateStr, operation: "BULK_POST", user: req.user }, conn);
          openDates.add(dateStr);
        } catch (periodErr) {
          if (!(periodErr.statusCode === 409 && periodErr.code && periodErr.code.startsWith("ACCOUNTING_PERIOD"))) throw periodErr;
        }
      }
      const periodBlockedIds = draftRows
        .filter((r) => !openDates.has(AccountingPeriodService.toDateOnly(r.transactionDate)))
        .map((r) => r.id);
      periodBlockedCount += periodBlockedIds.length;
      draftIds = draftIds.filter((id) => !periodBlockedIds.includes(id));

      // Section 23/24: a Draft OR/CV may carry a payment application saved
      // at a different rate than its source document (allowed to save,
      // never allowed to post - the per-transaction Save/Post path already
      // enforces this; bulk posting must not become a bypass for it).
      // Those specific rows are excluded from this bulk transition and
      // reported back rather than silently posted unbalanced.
      let blockedIds = [];
      if (target.isPaymentDoc && draftIds.length) {
        const [mismatchRows] = await conn.query(
          `SELECT DISTINCT applied_id AS id FROM transaction_applications
           WHERE applied_type = ? AND applied_id IN (?) AND ABS(COALESCE(fx_difference, 0)) > 0.01`,
          [target.transactionType, draftIds]
        );
        blockedIds = mismatchRows.map((r) => r.id);
        draftIds = draftIds.filter((did) => !blockedIds.includes(did));
        blockedCount += blockedIds.length;
      }

      const [result] = draftIds.length
        ? await conn.query(`UPDATE ${target.table} SET status = ? WHERE id IN (?) AND company_id = ?`, [target.status, draftIds, companyId])
        : [{ affectedRows: 0 }];

      postedCount += result.affectedRows;

      if (target.transactionType && draftIds.length) {
        await conn.query(
          "UPDATE transaction_currency_snapshots SET rate_locked = 1 WHERE transaction_type = ? AND transaction_id IN (?)",
          [target.transactionType, draftIds]
        );
      }
    }

    await conn.commit();

    const notes = [];
    if (blockedCount) notes.push(`${blockedCount} were skipped because their payment rate differs from their source document's rate (realized FX gain/loss accounting is not yet implemented) - post those individually to see the details.`);
    if (periodBlockedCount) notes.push(`${periodBlockedCount} were skipped because their accounting period is closed.`);

    res.json({
      success: true,
      message: notes.length
        ? `${postedCount} transaction(s) posted successfully. ${notes.join(" ")}`
        : `${postedCount} transaction(s) posted successfully`,
      postedCount,
      blockedCount,
      periodBlockedCount,
    });
  } catch (err) {
    await conn.rollback();
    console.error("BULK POSTING ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to post transactions", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

// ===================== PAYMENT APPLICATION API =====================

app.post("/api/apply-payment", authenticateToken, authorizePermission("POSTING", "POST"), async (req, res) => {
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

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.body.companyId);

    await conn.beginTransaction();

    // Locked on the PAYMENT's date, not the source APV's - settling an
    // older closed-period APV from a currently-open period is normal
    // (Checkpoint 5 section 16/17).
    await AccountingPeriodService.assertPeriodOpen({
      companyId, transactionDate: applicationDate || new Date().toISOString().slice(0, 10),
      operation: "POST", user: req.user,
    }, conn);

    const [apvRows] = await conn.execute(
      `SELECT
        id,
        total_credit AS totalAmount,
        COALESCE(paid_amount, 0) AS paidAmount,
        COALESCE(balance_amount, total_credit) AS balanceAmount
      FROM apv_headers
      WHERE id = ? AND company_id = ?`,
      [sourceId, companyId]
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
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to apply payment.", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

// ===================== CV API =====================

app.get("/api/cv", authenticateToken, authorizePermission("TRANSACTIONS.CV", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const [rows] = await pool.execute(`
      SELECT
        cv_headers.id AS id,
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
        DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate,
        cv_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.foreign_total AS foreignTotal
      FROM cv_headers
      LEFT JOIN currencies cur ON cur.id = cv_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'CV' AND snap.transaction_id = cv_headers.id
      WHERE cv_headers.company_id = ?
      ORDER BY cv_headers.id DESC
    `, [companyId]);

    res.json(rows);
  } catch (err) {
    console.error("GET CV ERROR:", err);
    res.status(500).json({ message: "Failed to load CV records" });
  }
});

app.post("/api/cv", authenticateToken, authorizePermission("TRANSACTIONS.CV", "CREATE"), async (req, res) => {
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
      atcCode,
      taxWithheldAmount,
      payeeTin,
      currency,
    } = req.body;

    const finalPayeeId = payeeId ?? req.body.supplierId ?? null;
    const finalPayeeName = payeeName || req.body.supplierName || "";
    const finalStatus = status || "Draft";
    const isPosting = String(finalStatus).toUpperCase() === "POSTED";

    const ewt = await resolveTaxWithholding(conn, {
      moduleLabel: "CV",
      atcCode,
      lines,
      totalCredit: Number(totalCredit) || 0,
      clientTaxWithheldAmount: taxWithheldAmount,
      vatKeyword: "input vat",
    });

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "CREATE", user: req.user }, conn);
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "CV", transactionId: null, currencyPayload: currency,
      lines, grossAmount: Number(totalCredit) || 0, vatKeyword: "input vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting,
    });

    const [result] = await conn.execute(
      `INSERT INTO cv_headers(
        company_id,
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
        check_date,
        atc_code,
        tax_type,
        tax_rate,
        tax_withheld_amount,
        taxable_base,
        payee_tin,
        currency_id
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        companyId,
        voucherNo || "",
        finalPayeeId,
        finalPayeeName,
        transactionDate || null,
        referenceNo || "",
        checkNo || "",
        description || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        paymentMethod === "Cash" ? "Cash" : "Check",
        bankAccountId || null,
        paymentMethod !== "Cash" ? checkDate || null : null,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        payeeTin || null,
        currencyResult.currencyId,
      ]
    );

    const cvId = result.insertId;

    for (const line of currencyResult.lines) {
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
          credit,
          foreign_debit,
          foreign_credit
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          cvId,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          line.baseDebit,
          line.baseCredit,
          line.foreignDebit,
          line.foreignCredit,
        ]
      );
    }

    const cvApplications = [];
    for (const appItem of apvApplications) {
      cvApplications.push(
        await applyApvPayment(conn, {
          appItem,
          appliedType: "CV",
          appliedId: cvId,
          paymentCurrencyCode: currencyResult.currencyCode,
          paymentExchangeRate: currencyResult.rateInfo.exchangeRate,
          baseCurrencyCode: currencyResult.baseCurrencyCode,
          fallbackDate: transactionDate,
          isPosting,
          companyId,
        })
      );
    }
    const cvFxResult = await applyForeignSettlementToLines(conn, {
      headerTable: "cv_headers", lineTable: "cv_lines", lineIdCol: "cv_id",
      transactionId: cvId, applications: cvApplications, perspective: "PAYABLE",
    });
    await logFxSettlementAudit(conn, {
      req, moduleKey: "TRANSACTIONS.CV", appliedType: "CV", appliedId: cvId,
      applications: cvApplications, fxResult: cvFxResult,
    });

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "CV", transactionId: cvId,
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

    await conn.commit();

    res.json({
      success: true,
      id: cvId,
      message: "CV saved successfully",
    });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE CV ERROR:", err);

    res.status(err.statusCode || 500).json({
      message: err.message || "Failed to save CV",
      ...(err.statusCode && err.code ? { code: err.code } : {}),
    });
  } finally {
    conn.release();
  }
});

app.get("/api/cv/:id", authenticateToken, authorizePermission("TRANSACTIONS.CV", "VIEW"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

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
        DATE_FORMAT(check_date, '%Y-%m-%d') AS checkDate,
        atc_code AS atcCode,
        tax_type AS taxType,
        tax_rate AS taxRate,
        tax_withheld_amount AS taxWithheldAmount,
        taxable_base AS taxableBase,
        payee_tin AS payeeTin,
        currency_id AS currencyId
      FROM cv_headers
      WHERE id = ? AND company_id = ?`,
      [id, companyId]
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
        gen_name AS genName,
        foreign_debit AS foreignDebit,
        foreign_credit AS foreignCredit
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
        DATE_FORMAT(application_date, '%Y-%m-%d') AS applicationDate,
        source_currency_code AS sourceCurrencyCode,
        payment_currency_code AS paymentCurrencyCode,
        foreign_amount_applied AS foreignAmountApplied,
        source_exchange_rate AS sourceExchangeRate,
        payment_exchange_rate AS paymentExchangeRate,
        source_base_amount AS sourceBaseAmount,
        payment_base_amount AS paymentBaseAmount,
        fx_difference AS fxDifference,
        fx_direction AS fxDirection
      FROM transaction_applications
      WHERE applied_type = 'CV'
        AND applied_id = ?
      ORDER BY id DESC`,
      [id]
    );

    const currencySnapshot = await TransactionCurrencyService.getSnapshot("CV", id);

    res.json({
      ...headers[0],
      lines,
      applications,
      currency: currencySnapshot,
    });
  } catch (err) {
    console.error("GET CV DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load CV details" });
  }
});

app.put("/api/cv/:id", authenticateToken, authorizePermission("TRANSACTIONS.CV", "EDIT"), async (req, res) => {
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
      atcCode,
      taxWithheldAmount,
      payeeTin,
      currency,
    } = req.body;

    const finalPayeeId = payeeId ?? req.body.supplierId ?? null;
    const finalPayeeName = payeeName || req.body.supplierName || "";
    const finalStatus = status || "Draft";
    const isPosting = String(finalStatus).toUpperCase() === "POSTED";

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);

    await conn.beginTransaction();

    const [ownerRows] = await conn.execute("SELECT company_id, transaction_date, status FROM cv_headers WHERE id = ?", [id]);
    if (!ownerRows.length || ownerRows[0].company_id !== companyId) {
      await conn.rollback();
      return res.status(404).json({ message: "CV not found" });
    }
    // Phase 7A.1: a Posted CV cannot be freely edited (see the matching OR
    // comment above - the settlement side-effect on a source APV is a
    // separate call path, unaffected by this guard).
    if (String(ownerRows[0].status).toUpperCase() === "POSTED") {
      await conn.rollback();
      return res.status(409).json({ message: "Posted transactions cannot be edited.", code: "TRANSACTION_ALREADY_POSTED" });
    }
    const existingDateISO = AccountingPeriodService.toDateOnly(ownerRows[0].transaction_date);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: existingDateISO, operation: "EDIT", user: req.user }, conn);
    if (transactionDate && transactionDate !== existingDateISO) {
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "EDIT", user: req.user }, conn);
    }

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

        const foreignState = await TransactionCurrencyService.getForeignPaymentState(conn, {
          transactionType: "AP_BEGINNING",
          transactionId: oldItem.sourceId,
        });
        if (foreignState.hasForeignCurrency) {
          await conn.execute(
            `UPDATE arap_beginning_balance_lines SET foreign_paid_amount = ?, foreign_balance_amount = ? WHERE id = ?`,
            [foreignState.foreignPaidAmount, foreignState.foreignBalanceAmount, oldItem.sourceId]
          );
        }
      }
    }

    for (const oldItem of oldApplications) {
      if (oldItem.sourceType === "APV") {
        await updateApvPaymentStatus(conn, oldItem.sourceId);
      }
    }

    const ewt = await resolveTaxWithholding(conn, {
      moduleLabel: "CV",
      atcCode,
      lines,
      totalCredit: Number(totalCredit) || 0,
      clientTaxWithheldAmount: taxWithheldAmount,
      vatKeyword: "input vat",
    });

    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "CV", transactionId: Number(id), currencyPayload: currency,
      lines, grossAmount: Number(totalCredit) || 0, vatKeyword: "input vat", taxWithheldAmount: ewt.taxWithheldAmount,
      isPosting,
    });

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
         check_date = ?,
         atc_code = ?,
         tax_type = ?,
         tax_rate = ?,
         tax_withheld_amount = ?,
         taxable_base = ?,
         payee_tin = ?,
         currency_id = ?
       WHERE id = ? AND company_id = ?`,
      [
        voucherNo || "",
        finalPayeeId,
        finalPayeeName,
        transactionDate || null,
        referenceNo || "",
        checkNo || "",
        description || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        paymentMethod === "Cash" ? "Cash" : "Check",
        bankAccountId || null,
        paymentMethod !== "Cash" ? checkDate || null : null,
        ewt.atcCode,
        ewt.taxType,
        ewt.taxRate,
        ewt.atcCode ? currencyResult.baseTotals.baseEwt : null,
        ewt.atcCode ? currencyResult.baseTotals.baseSubtotal : null,
        payeeTin || null,
        currencyResult.currencyId,
        id,
        companyId,
      ]
    );

    await conn.execute("DELETE FROM cv_lines WHERE cv_id = ?", [id]);

    for (const line of currencyResult.lines) {
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
          credit,
          foreign_debit,
          foreign_credit
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          line.baseDebit,
          line.baseCredit,
          line.foreignDebit,
          line.foreignCredit,
        ]
      );
    }

    const cvApplications = [];
    for (const appItem of apvApplications) {
      cvApplications.push(
        await applyApvPayment(conn, {
          appItem,
          appliedType: "CV",
          appliedId: Number(id),
          paymentCurrencyCode: currencyResult.currencyCode,
          paymentExchangeRate: currencyResult.rateInfo.exchangeRate,
          baseCurrencyCode: currencyResult.baseCurrencyCode,
          fallbackDate: transactionDate,
          isPosting,
          companyId,
        })
      );
    }
    const cvFxResult = await applyForeignSettlementToLines(conn, {
      headerTable: "cv_headers", lineTable: "cv_lines", lineIdCol: "cv_id",
      transactionId: Number(id), applications: cvApplications, perspective: "PAYABLE",
    });
    await logFxSettlementAudit(conn, {
      req, moduleKey: "TRANSACTIONS.CV", appliedType: "CV", appliedId: Number(id),
      applications: cvApplications, fxResult: cvFxResult,
    });

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "CV", transactionId: Number(id),
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

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

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update CV", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

// ===================== JV (JOURNAL VOUCHER) API =====================
// The frontend has no dedicated "post" action - Draft/Posted is embedded in the
// same create/update payload (handleSave(status) in TransactionFormLayout.jsx),
// so these routes follow that same shape rather than adding a separate endpoint.

app.get("/api/jv", authenticateToken, authorizePermission("TRANSACTIONS.JV", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const [rows] = await pool.execute(`
      SELECT
        jv_headers.id AS id,
        voucher_no AS voucherNo,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        prepared_for AS preparedFor,
        description,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status,
        jv_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.foreign_total AS foreignTotal
      FROM jv_headers
      LEFT JOIN currencies cur ON cur.id = jv_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'JV' AND snap.transaction_id = jv_headers.id
      WHERE jv_headers.company_id = ?
      ORDER BY jv_headers.id DESC
    `, [companyId]);

    res.json(rows);
  } catch (err) {
    console.error("GET JV ERROR:", err);
    res.status(500).json({ message: "Failed to load JV records" });
  }
});

app.post("/api/jv", authenticateToken, authorizePermission("TRANSACTIONS.JV", "CREATE"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      voucherNo,
      supplierName,
      customerName,
      transactionDate,
      referenceNo,
      description,
      remarks,
      status,
      lines = [],
      currency,
    } = req.body;

    const preparedFor = req.body.preparedFor || supplierName || customerName || "";
    const finalStatus = status || "Draft";
    const userId = req.user?.id || null;
    const isPosting = finalStatus === "Posted";

    // Backend authority (section 30/31): the gross total comes from summing
    // the submitted lines, never the client-computed totalDebit/totalCredit.
    const grossAmount = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);

    await conn.beginTransaction();

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "CREATE", user: req.user }, conn);
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "JV", transactionId: null, currencyPayload: currency,
      lines, grossAmount, vatKeyword: "vat", taxWithheldAmount: 0, isPosting,
    });

    const [result] = await conn.execute(
      `INSERT INTO jv_headers(
        company_id,
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
        posted_at,
        currency_id
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        companyId,
        voucherNo || "",
        transactionDate || null,
        referenceNo || "",
        preparedFor,
        description || "",
        remarks || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        userId,
        isPosting ? userId : null,
        isPosting ? new Date() : null,
        currencyResult.currencyId,
      ]
    );

    const jvId = result.insertId;

    for (const line of currencyResult.lines) {
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
          credit,
          foreign_debit,
          foreign_credit
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          jvId,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          line.baseDebit,
          line.baseCredit,
          line.foreignDebit,
          line.foreignCredit,
        ]
      );
    }

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "JV", transactionId: jvId,
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

    await logAudit(conn, {
      module: "JV",
      entityType: "JV",
      entityId: jvId,
      action: isPosting ? "POST" : "CREATE",
      description:
        isPosting
          ? `JV ${voucherNo} created and posted`
          : `JV ${voucherNo} created (${finalStatus})`,
      afterData: {
        voucherNo, preparedFor, transactionDate, status: finalStatus,
        totalDebit: currencyResult.baseTotalDebit, totalCredit: currencyResult.baseTotalCredit,
        currencyCode: currencyResult.currencyCode,
      },
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

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to save JV", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.get("/api/jv/:id", authenticateToken, authorizePermission("TRANSACTIONS.JV", "VIEW"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

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
        status,
        currency_id AS currencyId
      FROM jv_headers
      WHERE id = ? AND company_id = ?`,
      [id, companyId]
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
        gen_name AS genName,
        foreign_debit AS foreignDebit,
        foreign_credit AS foreignCredit
      FROM jv_lines
      WHERE jv_id = ?
      ORDER BY id ASC`,
      [id]
    );

    const currencySnapshot = await TransactionCurrencyService.getSnapshot("JV", id);

    res.json({
      ...headers[0],
      lines,
      currency: currencySnapshot,
    });
  } catch (err) {
    console.error("GET JV DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load JV details" });
  }
});

app.put("/api/jv/:id", authenticateToken, authorizePermission("TRANSACTIONS.JV", "EDIT"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;

    const {
      voucherNo,
      supplierName,
      customerName,
      transactionDate,
      referenceNo,
      description,
      remarks,
      status,
      lines = [],
      currency,
    } = req.body;

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);

    const [existing] = await conn.execute(
      "SELECT status, posted_by, posted_at, company_id AS companyId, transaction_date AS transactionDate FROM jv_headers WHERE id = ?",
      [id]
    );

    if (existing.length === 0 || existing[0].companyId !== companyId) {
      return res.status(404).json({ message: "JV not found" });
    }

    const preparedFor = req.body.preparedFor || supplierName || customerName || "";
    const finalStatus = status || "Draft";
    const userId = req.user?.id || null;
    const wasAlreadyPosted = existing[0].status === "Posted";
    // Phase 7A.1: Posted transactions cannot be freely edited - an
    // accounting-integrity rule based on the STORED status (wasAlreadyPosted
    // above), never the incoming payload's status, so a client cannot
    // "unpost" a transaction by submitting status:"Draft".
    if (wasAlreadyPosted) {
      return res.status(409).json({ message: "Posted transactions cannot be edited.", code: "TRANSACTION_ALREADY_POSTED" });
    }
    const isPosting = finalStatus === "Posted";

    // Preserve the original posted_by/posted_at if it was already Posted and stays
    // Posted through this edit - only set them fresh on the Draft->Posted transition.
    const nextPostedBy =
      isPosting ? (wasAlreadyPosted ? existing[0].posted_by : userId) : null;
    const nextPostedAt =
      isPosting ? (wasAlreadyPosted ? existing[0].posted_at : new Date()) : null;

    const grossAmount = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);

    await conn.beginTransaction();

    const existingDateISO = AccountingPeriodService.toDateOnly(existing[0].transactionDate);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: existingDateISO, operation: "EDIT", user: req.user }, conn);
    if (transactionDate && transactionDate !== existingDateISO) {
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "EDIT", user: req.user }, conn);
    }

    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "JV", transactionId: Number(id), currencyPayload: currency,
      lines, grossAmount, vatKeyword: "vat", taxWithheldAmount: 0, isPosting,
    });

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
        posted_at = ?,
        currency_id = ?
      WHERE id = ? AND company_id = ?`,
      [
        voucherNo || "",
        transactionDate || null,
        referenceNo || "",
        preparedFor,
        description || "",
        remarks || "",
        currencyResult.baseTotalDebit,
        currencyResult.baseTotalCredit,
        finalStatus,
        nextPostedBy,
        nextPostedAt,
        currencyResult.currencyId,
        id,
        companyId,
      ]
    );

    await conn.execute("DELETE FROM jv_lines WHERE jv_id = ?", [id]);

    for (const line of currencyResult.lines) {
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
          credit,
          foreign_debit,
          foreign_credit
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          line.accountId ?? null,
          line.accountCode || "",
          line.accountTitle || "",
          line.particulars || "",
          line.genRef || "",
          line.genName || "",
          line.baseDebit,
          line.baseCredit,
          line.foreignDebit,
          line.foreignCredit,
        ]
      );
    }

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "JV", transactionId: Number(id),
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

    const isPostingNow = isPosting && !wasAlreadyPosted;

    await logAudit(conn, {
      module: "JV",
      entityType: "JV",
      entityId: Number(id),
      action: isPostingNow ? "POST" : "UPDATE",
      description: isPostingNow
        ? `JV ${voucherNo} posted`
        : `JV ${voucherNo} updated (${finalStatus})`,
      beforeData: existing[0],
      afterData: {
        voucherNo, preparedFor, transactionDate, status: finalStatus,
        totalDebit: currencyResult.baseTotalDebit, totalCredit: currencyResult.baseTotalCredit,
        currencyCode: currencyResult.currencyCode,
      },
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

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update JV", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.delete("/api/jv/:id", authenticateToken, authorizePermission("TRANSACTIONS.JV", "DELETE"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);

    const [existing] = await conn.execute(
      "SELECT voucher_no, status, company_id AS companyId, transaction_date AS transactionDate FROM jv_headers WHERE id = ?",
      [id]
    );

    if (existing.length === 0 || existing[0].companyId !== companyId) {
      return res.status(404).json({ message: "JV not found" });
    }
    // Phase 7A.1: Posted transactions cannot be deleted.
    if (existing[0].status === "Posted") {
      return res.status(409).json({ message: "Posted transactions cannot be deleted.", code: "TRANSACTION_ALREADY_POSTED" });
    }

    await conn.beginTransaction();

    const delDateISO = AccountingPeriodService.toDateOnly(existing[0].transactionDate);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: delDateISO, operation: "DELETE", user: req.user }, conn);

    await conn.execute("DELETE FROM jv_headers WHERE id = ? AND company_id = ?", [id, companyId]);

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
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to delete JV", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

// ===================== PETTY CASH VOUCHER API =====================
// Checkpoint 6: previously fell through TransactionFormLayout's default
// endpoint and was silently saved into apv_headers/apv_lines - see the
// Checkpoint 6 completion report. Shaped like JV (immediate GL entry, no
// AP-aging concept) plus payee_id/payee_name matching CV's convention.
//
// Balance validation (Step 17: SUM(debit) = SUM(credit) before commit) is
// NOT re-implemented here - TransactionCurrencyService.resolveTransactionCurrency()
// (called below, same as every other module) already throws "Transaction
// lines are not balanced in the transaction currency." via its own
// finalizeWithRate(), unconditionally, for every save (Draft or Posted).
// An earlier version of this file added a second, redundant check here
// that assumed balance was only enforced at posting - discovered wrong
// during Checkpoint 6's own test-writing, removed in favor of relying on
// the one enforcement point that already existed.

app.get("/api/petty-cash", authenticateToken, authorizePermission("TRANSACTIONS.PETTY_CASH", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const [rows] = await pool.execute(`
      SELECT
        petty_cash_headers.id AS id,
        voucher_no AS voucherNo,
        payee_id AS payeeId,
        payee_name AS payeeName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo,
        description,
        total_debit AS totalDebit,
        total_credit AS totalCredit,
        status,
        petty_cash_headers.currency_id AS currencyId,
        cur.currency_code AS currencyCode,
        cur.currency_symbol AS currencySymbol,
        snap.foreign_total AS foreignTotal
      FROM petty_cash_headers
      LEFT JOIN currencies cur ON cur.id = petty_cash_headers.currency_id
      LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = 'PETTY_CASH' AND snap.transaction_id = petty_cash_headers.id
      WHERE petty_cash_headers.company_id = ?
      ORDER BY petty_cash_headers.id DESC
    `, [companyId]);

    res.json(rows);
  } catch (err) {
    console.error("GET PETTY CASH ERROR:", err);
    res.status(500).json({ message: "Failed to load Petty Cash records" });
  }
});

app.post("/api/petty-cash", authenticateToken, authorizePermission("TRANSACTIONS.PETTY_CASH", "CREATE"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      voucherNo,
      payeeId,
      payeeName,
      transactionDate,
      referenceNo,
      description,
      remarks,
      status,
      lines = [],
      currency,
    } = req.body;

    const finalStatus = status || "Draft";
    const userId = req.user?.id || null;
    const isPosting = finalStatus === "Posted";

    const grossAmount = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);

    await conn.beginTransaction();

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "CREATE", user: req.user }, conn);
    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "PETTY_CASH", transactionId: null, currencyPayload: currency,
      lines, grossAmount, vatKeyword: "vat", taxWithheldAmount: 0, isPosting,
    });


    const [result] = await conn.execute(
      `INSERT INTO petty_cash_headers(
        company_id, voucher_no, payee_id, payee_name, transaction_date, reference_no,
        description, remarks, total_debit, total_credit, status, created_by, posted_by, posted_at, currency_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        companyId, voucherNo || "", payeeId ?? null, payeeName || "", transactionDate || null, referenceNo || "",
        description || "", remarks || "", currencyResult.baseTotalDebit, currencyResult.baseTotalCredit, finalStatus,
        userId, isPosting ? userId : null, isPosting ? new Date() : null, currencyResult.currencyId,
      ]
    );

    const pettyCashId = result.insertId;

    for (const line of currencyResult.lines) {
      await conn.execute(
        `INSERT INTO petty_cash_lines(
          petty_cash_id, account_id, account_code, account_title, particulars, gen_ref, gen_name,
          debit, credit, foreign_debit, foreign_credit
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          pettyCashId, line.accountId ?? null, line.accountCode || "", line.accountTitle || "", line.particulars || "",
          line.genRef || "", line.genName || "", line.baseDebit, line.baseCredit, line.foreignDebit, line.foreignCredit,
        ]
      );
    }

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "PETTY_CASH", transactionId: pettyCashId,
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

    await logAudit(conn, {
      module: "PETTY_CASH",
      entityType: "PETTY_CASH",
      entityId: pettyCashId,
      action: isPosting ? "POST" : "CREATE",
      description: isPosting ? `Petty Cash Voucher ${voucherNo} created and posted` : `Petty Cash Voucher ${voucherNo} created (${finalStatus})`,
      afterData: {
        voucherNo, payeeName, transactionDate, status: finalStatus,
        totalDebit: currencyResult.baseTotalDebit, totalCredit: currencyResult.baseTotalCredit,
        currencyCode: currencyResult.currencyCode,
      },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, id: pettyCashId, message: "Petty Cash Voucher saved successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("CREATE PETTY CASH ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Petty Cash voucher number already exists" });
    }

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to save Petty Cash Voucher", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.get("/api/petty-cash/:id", authenticateToken, authorizePermission("TRANSACTIONS.PETTY_CASH", "VIEW"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const [headers] = await pool.execute(
      `SELECT
        id, voucher_no AS voucherNo, payee_id AS payeeId, payee_name AS payeeName,
        DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
        reference_no AS referenceNo, description, remarks,
        total_debit AS totalDebit, total_credit AS totalCredit, status, currency_id AS currencyId
      FROM petty_cash_headers
      WHERE id = ? AND company_id = ?`,
      [id, companyId]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "Petty Cash Voucher not found" });
    }

    const [lines] = await pool.execute(
      `SELECT
        id, petty_cash_id AS pettyCashId, account_id AS accountId, account_code AS accountCode,
        account_title AS accountTitle, particulars, debit, credit, gen_ref AS genRef, gen_name AS genName,
        foreign_debit AS foreignDebit, foreign_credit AS foreignCredit
      FROM petty_cash_lines
      WHERE petty_cash_id = ?
      ORDER BY id ASC`,
      [id]
    );

    const currencySnapshot = await TransactionCurrencyService.getSnapshot("PETTY_CASH", id);

    res.json({ ...headers[0], lines, currency: currencySnapshot });
  } catch (err) {
    console.error("GET PETTY CASH DETAILS ERROR:", err);
    res.status(500).json({ message: "Failed to load Petty Cash Voucher details" });
  }
});

app.put("/api/petty-cash/:id", authenticateToken, authorizePermission("TRANSACTIONS.PETTY_CASH", "EDIT"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { voucherNo, payeeId, payeeName, transactionDate, referenceNo, description, remarks, status, lines = [], currency } = req.body;

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);

    const [existing] = await conn.execute(
      "SELECT status, posted_by, posted_at, company_id AS companyId, transaction_date AS transactionDate FROM petty_cash_headers WHERE id = ?",
      [id]
    );

    if (existing.length === 0 || existing[0].companyId !== companyId) {
      return res.status(404).json({ message: "Petty Cash Voucher not found" });
    }

    const finalStatus = status || "Draft";
    const userId = req.user?.id || null;
    const wasAlreadyPosted = existing[0].status === "Posted";
    // Phase 7A.1: Posted transactions cannot be freely edited.
    if (wasAlreadyPosted) {
      return res.status(409).json({ message: "Posted transactions cannot be edited.", code: "TRANSACTION_ALREADY_POSTED" });
    }
    const isPosting = finalStatus === "Posted";
    const nextPostedBy = isPosting ? (wasAlreadyPosted ? existing[0].posted_by : userId) : null;
    const nextPostedAt = isPosting ? (wasAlreadyPosted ? existing[0].posted_at : new Date()) : null;

    const grossAmount = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);

    await conn.beginTransaction();

    const existingDateISO = AccountingPeriodService.toDateOnly(existing[0].transactionDate);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: existingDateISO, operation: "EDIT", user: req.user }, conn);
    if (transactionDate && transactionDate !== existingDateISO) {
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "EDIT", user: req.user }, conn);
    }

    const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
      user: req.user, companyId, transactionType: "PETTY_CASH", transactionId: Number(id), currencyPayload: currency,
      lines, grossAmount, vatKeyword: "vat", taxWithheldAmount: 0, isPosting,
    });


    await conn.execute(
      `UPDATE petty_cash_headers SET
        voucher_no = ?, payee_id = ?, payee_name = ?, transaction_date = ?, reference_no = ?,
        description = ?, remarks = ?, total_debit = ?, total_credit = ?, status = ?,
        posted_by = ?, posted_at = ?, currency_id = ?
      WHERE id = ? AND company_id = ?`,
      [
        voucherNo || "", payeeId ?? null, payeeName || "", transactionDate || null, referenceNo || "",
        description || "", remarks || "", currencyResult.baseTotalDebit, currencyResult.baseTotalCredit, finalStatus,
        nextPostedBy, nextPostedAt, currencyResult.currencyId, id, companyId,
      ]
    );

    await conn.execute("DELETE FROM petty_cash_lines WHERE petty_cash_id = ?", [id]);

    for (const line of currencyResult.lines) {
      await conn.execute(
        `INSERT INTO petty_cash_lines(
          petty_cash_id, account_id, account_code, account_title, particulars, gen_ref, gen_name,
          debit, credit, foreign_debit, foreign_credit
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, line.accountId ?? null, line.accountCode || "", line.accountTitle || "", line.particulars || "",
          line.genRef || "", line.genName || "", line.baseDebit, line.baseCredit, line.foreignDebit, line.foreignCredit,
        ]
      );
    }

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId, transactionType: "PETTY_CASH", transactionId: Number(id),
      currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
      rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
      userId: req.user.id, lockNow: isPosting,
    });

    const isPostingNow = isPosting && !wasAlreadyPosted;

    await logAudit(conn, {
      module: "PETTY_CASH",
      entityType: "PETTY_CASH",
      entityId: Number(id),
      action: isPostingNow ? "POST" : "UPDATE",
      description: isPostingNow ? `Petty Cash Voucher ${voucherNo} posted` : `Petty Cash Voucher ${voucherNo} updated (${finalStatus})`,
      beforeData: existing[0],
      afterData: {
        voucherNo, payeeName, transactionDate, status: finalStatus,
        totalDebit: currencyResult.baseTotalDebit, totalCredit: currencyResult.baseTotalCredit,
        currencyCode: currencyResult.currencyCode,
      },
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, message: "Petty Cash Voucher updated successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("UPDATE PETTY CASH ERROR:", err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Petty Cash voucher number already exists" });
    }

    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update Petty Cash Voucher", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.delete("/api/petty-cash/:id", authenticateToken, authorizePermission("TRANSACTIONS.PETTY_CASH", "DELETE"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);

    const [existing] = await conn.execute(
      "SELECT voucher_no, status, company_id AS companyId, transaction_date AS transactionDate FROM petty_cash_headers WHERE id = ?",
      [id]
    );

    if (existing.length === 0 || existing[0].companyId !== companyId) {
      return res.status(404).json({ message: "Petty Cash Voucher not found" });
    }
    // Phase 7A.1: Posted transactions cannot be deleted.
    if (existing[0].status === "Posted") {
      return res.status(409).json({ message: "Posted transactions cannot be deleted.", code: "TRANSACTION_ALREADY_POSTED" });
    }

    await conn.beginTransaction();

    const delDateISO = AccountingPeriodService.toDateOnly(existing[0].transactionDate);
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: delDateISO, operation: "DELETE", user: req.user }, conn);

    await conn.execute("DELETE FROM petty_cash_headers WHERE id = ? AND company_id = ?", [id, companyId]);

    await logAudit(conn, {
      module: "PETTY_CASH",
      entityType: "PETTY_CASH",
      entityId: Number(id),
      action: "DELETE",
      description: `Petty Cash Voucher ${existing[0].voucher_no} deleted`,
      beforeData: existing[0],
      user: req.user,
    });

    await conn.commit();

    res.json({ success: true, message: "Petty Cash Voucher deleted successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("DELETE PETTY CASH ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to delete Petty Cash Voucher", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

// ===================== DEBIT MEMO / CREDIT MEMO API =====================
// Checkpoint 6: previously fell through TransactionFormLayout's default
// endpoint and was silently saved into apv_headers/apv_lines - see the
// Checkpoint 6 completion report. One shared memo_headers/memo_lines
// table pair (structurally identical, only accounting direction
// differs), registered as two separate URL namespaces so a Debit Memo
// request can never create or read a Credit Memo row or vice versa -
// memoType is a server-side constant per route, never client-controlled,
// and every query filters on it in addition to company_id.
//
// The actual GL entries stay fully user-driven (debit/credit lines
// entered directly), consistent with every other module here - only
// OR/CV's settlement wizard auto-posts, and that's out of scope for
// Memo per the approved Checkpoint 6 design. source_type/source_id is an
// optional, non-mutating reference to the Invoice/APV a memo relates to.

function registerMemoRoutes(memoType, urlPrefix, permissionModule, label) {
  app.get(`/api/${urlPrefix}`, authenticateToken, authorizePermission(permissionModule, "VIEW"), async (req, res) => {
    try {
      const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
      const [rows] = await pool.execute(`
        SELECT
          memo_headers.id AS id,
          voucher_no AS voucherNo,
          party_id AS partyId,
          party_name AS partyName,
          party_type AS partyType,
          DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
          reference_no AS referenceNo,
          description,
          total_debit AS totalDebit,
          total_credit AS totalCredit,
          status,
          source_type AS sourceType,
          source_id AS sourceId,
          memo_headers.currency_id AS currencyId,
          cur.currency_code AS currencyCode,
          cur.currency_symbol AS currencySymbol,
          snap.foreign_total AS foreignTotal
        FROM memo_headers
        LEFT JOIN currencies cur ON cur.id = memo_headers.currency_id
        LEFT JOIN transaction_currency_snapshots snap ON snap.transaction_type = ? AND snap.transaction_id = memo_headers.id
        WHERE memo_headers.company_id = ? AND memo_headers.memo_type = ?
        ORDER BY memo_headers.id DESC
      `, [`MEMO_${memoType}`, companyId, memoType]);

      res.json(rows);
    } catch (err) {
      console.error(`GET ${label} ERROR:`, err);
      res.status(500).json({ message: `Failed to load ${label} records` });
    }
  });

  app.post(`/api/${urlPrefix}`, authenticateToken, authorizePermission(permissionModule, "CREATE"), async (req, res) => {
    const conn = await pool.getConnection();

    try {
      const {
        voucherNo, partyId, partyName, partyType, transactionDate, referenceNo, description, remarks,
        status, lines = [], currency, sourceType, sourceId,
      } = req.body;

      const finalStatus = status || "Draft";
      const userId = req.user?.id || null;
      const isPosting = finalStatus === "Posted";
      const finalSourceType = sourceType === "INVOICE" || sourceType === "APV" ? sourceType : null;
      const finalSourceId = finalSourceType ? (Number(sourceId) || null) : null;

      const grossAmount = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);

      await conn.beginTransaction();

      const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "CREATE", user: req.user }, conn);

      // A source Invoice/APV, if given, must belong to the same company -
      // this is a documentation-only reference (Step 8: never overwrites
      // the source document), but it must still respect company isolation.
      if (finalSourceType && finalSourceId) {
        const sourceTable = finalSourceType === "INVOICE" ? "invoice_headers" : "apv_headers";
        const [sourceRows] = await conn.execute(`SELECT company_id AS companyId FROM ${sourceTable} WHERE id = ?`, [finalSourceId]);
        if (!sourceRows.length || sourceRows[0].companyId !== companyId) {
          throw new HttpError(404, `Source ${finalSourceType.toLowerCase()} not found.`);
        }
      }

      const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
        user: req.user, companyId, transactionType: `MEMO_${memoType}`, transactionId: null, currencyPayload: currency,
        lines, grossAmount, vatKeyword: "vat", taxWithheldAmount: 0, isPosting,
      });


      const [result] = await conn.execute(
        `INSERT INTO memo_headers(
          company_id, voucher_no, memo_type, party_id, party_name, party_type, transaction_date, reference_no,
          description, remarks, total_debit, total_credit, status, source_type, source_id, created_by, posted_by, posted_at, currency_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          companyId, voucherNo || "", memoType, partyId ?? null, partyName || "", partyType || null,
          transactionDate || null, referenceNo || "", description || "", remarks || "",
          currencyResult.baseTotalDebit, currencyResult.baseTotalCredit, finalStatus,
          finalSourceType, finalSourceId, userId, isPosting ? userId : null, isPosting ? new Date() : null, currencyResult.currencyId,
        ]
      );

      const memoId = result.insertId;

      for (const line of currencyResult.lines) {
        await conn.execute(
          `INSERT INTO memo_lines(
            memo_id, account_id, account_code, account_title, particulars, gen_ref, gen_name,
            debit, credit, foreign_debit, foreign_credit
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [
            memoId, line.accountId ?? null, line.accountCode || "", line.accountTitle || "", line.particulars || "",
            line.genRef || "", line.genName || "", line.baseDebit, line.baseCredit, line.foreignDebit, line.foreignCredit,
          ]
        );
      }

      await TransactionCurrencyService.saveSnapshot(conn, {
        companyId, transactionType: `MEMO_${memoType}`, transactionId: memoId,
        currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
        baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
        rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
        userId: req.user.id, lockNow: isPosting,
      });

      await logAudit(conn, {
        module: `MEMO_${memoType}`,
        entityType: `MEMO_${memoType}`,
        entityId: memoId,
        action: isPosting ? "POST" : "CREATE",
        description: isPosting ? `${label} ${voucherNo} created and posted` : `${label} ${voucherNo} created (${finalStatus})`,
        afterData: {
          voucherNo, partyName, transactionDate, status: finalStatus,
          totalDebit: currencyResult.baseTotalDebit, totalCredit: currencyResult.baseTotalCredit,
          currencyCode: currencyResult.currencyCode, sourceType: finalSourceType, sourceId: finalSourceId,
        },
        user: req.user,
      });

      await conn.commit();

      res.json({ success: true, id: memoId, message: `${label} saved successfully` });
    } catch (err) {
      await conn.rollback();
      console.error(`CREATE ${label} ERROR:`, err);

      if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: `${label} number already exists` });
      }

      res.status(err.statusCode || 500).json({ message: err.message || `Failed to save ${label}`, ...(err.statusCode && err.code ? { code: err.code } : {}) });
    } finally {
      conn.release();
    }
  });

  app.get(`/api/${urlPrefix}/:id`, authenticateToken, authorizePermission(permissionModule, "VIEW"), async (req, res) => {
    try {
      const { id } = req.params;
      const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

      const [headers] = await pool.execute(
        `SELECT
          id, voucher_no AS voucherNo, party_id AS partyId, party_name AS partyName, party_type AS partyType,
          DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transactionDate,
          reference_no AS referenceNo, description, remarks,
          total_debit AS totalDebit, total_credit AS totalCredit, status,
          source_type AS sourceType, source_id AS sourceId, currency_id AS currencyId
        FROM memo_headers
        WHERE id = ? AND company_id = ? AND memo_type = ?`,
        [id, companyId, memoType]
      );

      if (headers.length === 0) {
        return res.status(404).json({ message: `${label} not found` });
      }

      const [lines] = await pool.execute(
        `SELECT
          id, memo_id AS memoId, account_id AS accountId, account_code AS accountCode,
          account_title AS accountTitle, particulars, debit, credit, gen_ref AS genRef, gen_name AS genName,
          foreign_debit AS foreignDebit, foreign_credit AS foreignCredit
        FROM memo_lines
        WHERE memo_id = ?
        ORDER BY id ASC`,
        [id]
      );

      const currencySnapshot = await TransactionCurrencyService.getSnapshot(`MEMO_${memoType}`, id);

      res.json({ ...headers[0], lines, currency: currencySnapshot });
    } catch (err) {
      console.error(`GET ${label} DETAILS ERROR:`, err);
      res.status(500).json({ message: `Failed to load ${label} details` });
    }
  });

  app.put(`/api/${urlPrefix}/:id`, authenticateToken, authorizePermission(permissionModule, "EDIT"), async (req, res) => {
    const conn = await pool.getConnection();

    try {
      const { id } = req.params;
      const {
        voucherNo, partyId, partyName, partyType, transactionDate, referenceNo, description, remarks,
        status, lines = [], currency, sourceType, sourceId,
      } = req.body;

      const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, currency?.companyId);

      const [existing] = await conn.execute(
        "SELECT status, posted_by, posted_at, company_id AS companyId, transaction_date AS transactionDate FROM memo_headers WHERE id = ? AND memo_type = ?",
        [id, memoType]
      );

      if (existing.length === 0 || existing[0].companyId !== companyId) {
        return res.status(404).json({ message: `${label} not found` });
      }

      const finalStatus = status || "Draft";
      const userId = req.user?.id || null;
      const wasAlreadyPosted = existing[0].status === "Posted";
      // Phase 7A.1: Posted transactions cannot be freely edited.
      if (wasAlreadyPosted) {
        return res.status(409).json({ message: "Posted transactions cannot be edited.", code: "TRANSACTION_ALREADY_POSTED" });
      }
      const isPosting = finalStatus === "Posted";
      const nextPostedBy = isPosting ? (wasAlreadyPosted ? existing[0].posted_by : userId) : null;
      const nextPostedAt = isPosting ? (wasAlreadyPosted ? existing[0].posted_at : new Date()) : null;
      const finalSourceType = sourceType === "INVOICE" || sourceType === "APV" ? sourceType : null;
      const finalSourceId = finalSourceType ? (Number(sourceId) || null) : null;

      const grossAmount = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);

      await conn.beginTransaction();

      const existingDateISO = AccountingPeriodService.toDateOnly(existing[0].transactionDate);
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: existingDateISO, operation: "EDIT", user: req.user }, conn);
      if (transactionDate && transactionDate !== existingDateISO) {
        await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate, operation: "EDIT", user: req.user }, conn);
      }

      if (finalSourceType && finalSourceId) {
        const sourceTable = finalSourceType === "INVOICE" ? "invoice_headers" : "apv_headers";
        const [sourceRows] = await conn.execute(`SELECT company_id AS companyId FROM ${sourceTable} WHERE id = ?`, [finalSourceId]);
        if (!sourceRows.length || sourceRows[0].companyId !== companyId) {
          throw new HttpError(404, `Source ${finalSourceType.toLowerCase()} not found.`);
        }
      }

      const currencyResult = await TransactionCurrencyService.resolveTransactionCurrency({
        user: req.user, companyId, transactionType: `MEMO_${memoType}`, transactionId: Number(id), currencyPayload: currency,
        lines, grossAmount, vatKeyword: "vat", taxWithheldAmount: 0, isPosting,
      });


      await conn.execute(
        `UPDATE memo_headers SET
          voucher_no = ?, party_id = ?, party_name = ?, party_type = ?, transaction_date = ?, reference_no = ?,
          description = ?, remarks = ?, total_debit = ?, total_credit = ?, status = ?,
          source_type = ?, source_id = ?, posted_by = ?, posted_at = ?, currency_id = ?
        WHERE id = ? AND company_id = ? AND memo_type = ?`,
        [
          voucherNo || "", partyId ?? null, partyName || "", partyType || null, transactionDate || null, referenceNo || "",
          description || "", remarks || "", currencyResult.baseTotalDebit, currencyResult.baseTotalCredit, finalStatus,
          finalSourceType, finalSourceId, nextPostedBy, nextPostedAt, currencyResult.currencyId, id, companyId, memoType,
        ]
      );

      await conn.execute("DELETE FROM memo_lines WHERE memo_id = ?", [id]);

      for (const line of currencyResult.lines) {
        await conn.execute(
          `INSERT INTO memo_lines(
            memo_id, account_id, account_code, account_title, particulars, gen_ref, gen_name,
            debit, credit, foreign_debit, foreign_credit
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id, line.accountId ?? null, line.accountCode || "", line.accountTitle || "", line.particulars || "",
            line.genRef || "", line.genName || "", line.baseDebit, line.baseCredit, line.foreignDebit, line.foreignCredit,
          ]
        );
      }

      await TransactionCurrencyService.saveSnapshot(conn, {
        companyId, transactionType: `MEMO_${memoType}`, transactionId: Number(id),
        currencyId: currencyResult.currencyId, currencyCode: currencyResult.currencyCode,
        baseCurrencyId: currencyResult.baseCurrencyId, baseCurrencyCode: currencyResult.baseCurrencyCode,
        rateInfo: currencyResult.rateInfo, foreignTotals: currencyResult.foreignTotals, baseTotals: currencyResult.baseTotals,
        userId: req.user.id, lockNow: isPosting,
      });

      const isPostingNow = isPosting && !wasAlreadyPosted;

      await logAudit(conn, {
        module: `MEMO_${memoType}`,
        entityType: `MEMO_${memoType}`,
        entityId: Number(id),
        action: isPostingNow ? "POST" : "UPDATE",
        description: isPostingNow ? `${label} ${voucherNo} posted` : `${label} ${voucherNo} updated (${finalStatus})`,
        beforeData: existing[0],
        afterData: {
          voucherNo, partyName, transactionDate, status: finalStatus,
          totalDebit: currencyResult.baseTotalDebit, totalCredit: currencyResult.baseTotalCredit,
          currencyCode: currencyResult.currencyCode, sourceType: finalSourceType, sourceId: finalSourceId,
        },
        user: req.user,
      });

      await conn.commit();

      res.json({ success: true, message: `${label} updated successfully` });
    } catch (err) {
      await conn.rollback();
      console.error(`UPDATE ${label} ERROR:`, err);

      if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ message: `${label} number already exists` });
      }

      res.status(err.statusCode || 500).json({ message: err.message || `Failed to update ${label}`, ...(err.statusCode && err.code ? { code: err.code } : {}) });
    } finally {
      conn.release();
    }
  });

  app.delete(`/api/${urlPrefix}/:id`, authenticateToken, authorizePermission(permissionModule, "DELETE"), async (req, res) => {
    const conn = await pool.getConnection();

    try {
      const { id } = req.params;
      const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);

      const [existing] = await conn.execute(
        "SELECT voucher_no, status, company_id AS companyId, transaction_date AS transactionDate FROM memo_headers WHERE id = ? AND memo_type = ?",
        [id, memoType]
      );

      if (existing.length === 0 || existing[0].companyId !== companyId) {
        return res.status(404).json({ message: `${label} not found` });
      }
      // Phase 7A.1: Posted transactions cannot be deleted.
      if (existing[0].status === "Posted") {
        return res.status(409).json({ message: "Posted transactions cannot be deleted.", code: "TRANSACTION_ALREADY_POSTED" });
      }

      await conn.beginTransaction();

      const delDateISO = AccountingPeriodService.toDateOnly(existing[0].transactionDate);
      await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: delDateISO, operation: "DELETE", user: req.user }, conn);

      await conn.execute("DELETE FROM memo_headers WHERE id = ? AND company_id = ? AND memo_type = ?", [id, companyId, memoType]);

      await logAudit(conn, {
        module: `MEMO_${memoType}`,
        entityType: `MEMO_${memoType}`,
        entityId: Number(id),
        action: "DELETE",
        description: `${label} ${existing[0].voucher_no} deleted`,
        beforeData: existing[0],
        user: req.user,
      });

      await conn.commit();

      res.json({ success: true, message: `${label} deleted successfully` });
    } catch (err) {
      await conn.rollback();
      console.error(`DELETE ${label} ERROR:`, err);
      res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : `Failed to delete ${label}`, ...(err.statusCode && err.code ? { code: err.code } : {}) });
    } finally {
      conn.release();
    }
  });
}

registerMemoRoutes("DEBIT", "debit-memos", "TRANSACTIONS.DEBIT_CREDIT_MEMO", "Debit Memo");
registerMemoRoutes("CREDIT", "credit-memos", "TRANSACTIONS.DEBIT_CREDIT_MEMO", "Credit Memo");

// ===================== AUDIT LOG API =====================

app.get("/api/audit-logs", authenticateToken, authorizePermission("ADMIN.AUDIT_LOGS", "VIEW"), async (req, res) => {
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
// Extracted into services/controllers/routes (see backend/routes/bankRecon.routes.js).
app.use("/api/bank-recon", require("./routes/bankRecon.routes"));
app.use("/api/ai/bank-recon", require("./routes/aiRecon.routes"));
app.use("/api/beginning-balances", require("./routes/beginningBalanceImport.routes"));
app.use("/api/reports/trial-balance-checker", require("./routes/trialBalanceChecker.routes"));
app.use("/api", require("./routes/roles.routes"));
app.use("/api/invitations", require("./routes/invitations.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/access-restrictions", require("./routes/accessRestrictions.routes"));
app.use("/api/permission-templates", require("./routes/templates.routes"));
app.use("/api/print", require("./routes/transactionPrint.routes"));
app.use("/api/print-templates", require("./routes/printTemplate.routes"));
app.use("/api/recurring-transactions", require("./routes/recurringTransactions.routes"));
app.use("/api/fx-revaluation", require("./routes/fxRevaluation.routes"));
app.use("/api/currencies", require("./routes/currency.routes"));
app.use("/api/exchange-rates", require("./routes/exchangeRate.routes"));
app.use("/api/accounting-periods", require("./routes/accountingPeriods.routes"));

// ===================== ACCOUNT GROUP CODES API =====================

app.get("/api/group-codes", authenticateToken, authorizePermission("FILESETUP.GROUP_CODES", "VIEW"), async (req, res) => {
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

app.post("/api/group-codes", authenticateToken, authorizePermission("FILESETUP.GROUP_CODES", "CONFIGURE"), async (req, res) => {
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

app.put("/api/group-codes/:id", authenticateToken, authorizePermission("FILESETUP.GROUP_CODES", "CONFIGURE"), async (req, res) => {
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

app.delete("/api/group-codes/:id", authenticateToken, authorizePermission("FILESETUP.GROUP_CODES", "CONFIGURE"), async (req, res) => {
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

app.get("/api/arap-beginning-balances/:type", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "VIEW"), async (req, res) => {
  try {
    const { type } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

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
        l.currency_id AS currencyId,
        l.foreign_original_amount AS foreignOriginalAmount,
        l.foreign_paid_amount AS foreignPaidAmount,
        l.foreign_balance_amount AS foreignBalanceAmount,
        DATE_FORMAT(s.schedule_date, '%Y-%m-%d') AS scheduleDate
      FROM arap_beginning_balance_lines l
      JOIN arap_beginning_balance_headers h ON h.id = l.header_id
      LEFT JOIN arap_payment_schedules s ON s.beginning_balance_line_id = l.id
      WHERE h.balance_type = ? AND h.company_id = ?
      ORDER BY l.id DESC
      `,
      [type, companyId]
    );

    const linesWithCurrency = rows.filter((r) => r.currencyId);
    const snapshotsByLineId = new Map();
    if (linesWithCurrency.length) {
      const txnType = type === "AR" ? "AR_BEGINNING" : "AP_BEGINNING";
      for (const row of linesWithCurrency) {
        const snap = await TransactionCurrencyService.getSnapshot(txnType, row.id);
        if (snap) snapshotsByLineId.set(row.id, snap);
      }
    }

    res.json(
      rows.map((r) => ({
        ...r,
        currency: snapshotsByLineId.get(r.id) || null,
      }))
    );
  } catch (err) {
    console.error("GET ARAP BB ERROR:", err);
    res.status(500).json({ message: "Failed to load AR/AP beginning balances" });
  }
});

app.post("/api/arap-beginning-balances", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "CREATE"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const {
      balanceType,
      balanceDate,
      currencyCode,
      currencyName,
      remarks,
      line,
      companyId: requestedCompanyId,
    } = req.body;

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, requestedCompanyId);
    const txnType = balanceType === "AP" ? "AP_BEGINNING" : "AR_BEGINNING";

    await conn.beginTransaction();

    // Beginning Balances always insert as immediately-effective ('Posted')
    // - Checkpoint 5 section 21 blocks create/edit/delete/import once the
    // relevant opening period is closed.
    await AccountingPeriodService.assertPeriodOpen({ companyId, transactionDate: balanceDate, operation: "CREATE", user: req.user }, conn);

    const currencyResult = await BeginningBalanceCurrencyService.resolveLineCurrency({
      user: req.user,
      companyId,
      transactionType: txnType,
      transactionId: null,
      currencyPayload: line.currencyId
        ? { currencyId: line.currencyId, isManualRate: line.isManualRate, exchangeRate: line.exchangeRate, rateDate: line.rateDate, overrideReason: line.overrideReason }
        : null,
      rateDate: line.rateDate || balanceDate,
    });

    const converted = BeginningBalanceCurrencyService.convertLineAmount({
      debit: line.debit,
      credit: line.credit,
      exchangeRate: currencyResult.rateInfo.exchangeRate,
    });
    const foreignOriginal = converted.foreignDebit || converted.foreignCredit;

    const [headerResult] = await conn.execute(
      `
      INSERT INTO arap_beginning_balance_headers
      (company_id, balance_type, balance_date, currency_code, currency_name, remarks, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        companyId,
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
        status,
        currency_id,
        foreign_original_amount,
        foreign_paid_amount,
        foreign_balance_amount
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        converted.baseDebit,
        converted.baseCredit,
        TransactionCurrencyService.roundMoney(converted.baseDebit || converted.baseCredit),
        0,
        "Unpaid",
        currencyResult.currencyId,
        foreignOriginal,
        0,
        foreignOriginal,
      ]
    );

    const lineId = lineResult.insertId;

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId,
      transactionType: txnType,
      transactionId: lineId,
      currencyId: currencyResult.currencyId,
      currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrency.id,
      baseCurrencyCode: currencyResult.baseCurrency.currencyCode,
      rateInfo: currencyResult.rateInfo,
      foreignTotals: { foreignSubtotal: 0, foreignTax: 0, foreignEwt: 0, foreignTotal: foreignOriginal },
      baseTotals: { baseSubtotal: 0, baseTax: 0, baseEwt: 0, baseTotal: TransactionCurrencyService.roundMoney(converted.baseDebit || converted.baseCredit) },
      userId: req.user.id,
      lockNow: true,
    });

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
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to save AR/AP beginning balance", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.put("/api/arap-beginning-balances", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "EDIT"), async (req, res) => {
  const conn = await pool.getConnection();

  try {
    const { line, companyId: requestedCompanyId } = req.body;

    const [existingRows] = await conn.execute(
      `SELECT l.id, l.foreign_paid_amount AS foreignPaidAmount, h.balance_type AS balanceType, h.balance_date AS balanceDate, h.company_id AS companyId
       FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id
       WHERE l.id = ?`,
      [line.id]
    );
    if (!existingRows.length) {
      return res.status(404).json({ message: "Beginning balance line not found" });
    }
    const existing = existingRows[0];
    const txnType = existing.balanceType === "AP" ? "AP_BEGINNING" : "AR_BEGINNING";
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, requestedCompanyId);
    if (existing.companyId !== companyId) {
      return res.status(404).json({ message: "Beginning balance line not found" });
    }

    await conn.beginTransaction();

    await AccountingPeriodService.assertPeriodOpen({
      companyId, transactionDate: AccountingPeriodService.toDateOnly(existing.balanceDate),
      operation: "EDIT", user: req.user,
    }, conn);

    const currencyResult = await BeginningBalanceCurrencyService.resolveLineCurrency({
      user: req.user,
      companyId,
      transactionType: txnType,
      transactionId: line.id,
      currencyPayload: line.currencyId
        ? { currencyId: line.currencyId, isManualRate: line.isManualRate, exchangeRate: line.exchangeRate, rateDate: line.rateDate, overrideReason: line.overrideReason }
        : null,
      rateDate: line.rateDate || (existing.balanceDate instanceof Date ? existing.balanceDate.toISOString().slice(0, 10) : existing.balanceDate),
    });

    const converted = BeginningBalanceCurrencyService.convertLineAmount({
      debit: line.debit,
      credit: line.credit,
      exchangeRate: currencyResult.rateInfo.exchangeRate,
    });
    const foreignOriginal = converted.foreignDebit || converted.foreignCredit;
    const existingForeignPaid = Number(existing.foreignPaidAmount) || 0;
    const foreignBalance = TransactionCurrencyService.roundMoney(Math.max(foreignOriginal - existingForeignPaid, 0));

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
        balance_amount = ?,
        currency_id = ?,
        foreign_original_amount = ?,
        foreign_balance_amount = ?
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
        converted.baseDebit,
        converted.baseCredit,
        Number(line.balanceAmount) || 0,
        currencyResult.currencyId,
        foreignOriginal,
        foreignBalance,
        line.id,
      ]
    );

    await TransactionCurrencyService.saveSnapshot(conn, {
      companyId,
      transactionType: txnType,
      transactionId: line.id,
      currencyId: currencyResult.currencyId,
      currencyCode: currencyResult.currencyCode,
      baseCurrencyId: currencyResult.baseCurrency.id,
      baseCurrencyCode: currencyResult.baseCurrency.currencyCode,
      rateInfo: currencyResult.rateInfo,
      foreignTotals: { foreignSubtotal: 0, foreignTax: 0, foreignEwt: 0, foreignTotal: foreignOriginal },
      baseTotals: { baseSubtotal: 0, baseTax: 0, baseEwt: 0, baseTotal: TransactionCurrencyService.roundMoney(converted.baseDebit || converted.baseCredit) },
      userId: req.user.id,
      lockNow: true,
    });

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
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to update AR/AP beginning balance", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  } finally {
    conn.release();
  }
});

app.delete("/api/arap-beginning-balances/:id", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "DELETE"), async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId || req.body?.companyId);

    const [ownerRows] = await pool.execute(
      `SELECT h.company_id AS companyId, h.balance_date AS balanceDate FROM arap_beginning_balance_lines l JOIN arap_beginning_balance_headers h ON h.id = l.header_id WHERE l.id = ?`,
      [id]
    );
    if (!ownerRows.length || ownerRows[0].companyId !== companyId) {
      return res.status(404).json({ message: "Beginning balance line not found" });
    }
    await AccountingPeriodService.assertPeriodOpen({
      companyId, transactionDate: AccountingPeriodService.toDateOnly(ownerRows[0].balanceDate),
      operation: "DELETE", user: req.user,
    });

    await pool.execute(
      `DELETE FROM arap_beginning_balance_lines WHERE id = ?`,
      [id]
    );

    res.json({ success: true, message: "Beginning balance removed successfully" });
  } catch (err) {
    console.error("DELETE ARAP BB ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to remove beginning balance", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  }
});

// GL beginning balances previously had no backend at all - the manual
// entry page only console.logged. These make it real, and are also what
// the GL import commit path (services/beginningBalanceImportService.js)
// calls into via GLBeginningBalanceService directly.
app.get("/api/gl-beginning-balances", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "VIEW"), async (req, res) => {
  try {
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const data = await GLBeginningBalanceService.listGLBeginningBalances(companyId);
    res.json(data);
  } catch (err) {
    console.error("LIST GL BB ERROR:", err);
    res.status(500).json({ message: "Failed to load GL beginning balances" });
  }
});

app.post("/api/gl-beginning-balances", authenticateToken, authorizePermission("FILESETUP.BEGINNING_BALANCES", "CREATE"), async (req, res) => {
  try {
    const { header, rows } = req.body;

    if (!header || !header.date) {
      return res.status(400).json({ message: "Beginning balance date is required" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: "At least one line is required" });
    }

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, header.companyId);
    const { headerId } = await GLBeginningBalanceService.createGLBeginningBalance({ header, rows, user: req.user, companyId });
    res.json({ success: true, message: "GL beginning balance saved successfully", headerId });
  } catch (err) {
    console.error("SAVE GL BB ERROR:", err);
    res.status(err.statusCode || 500).json({ message: err.message || "Failed to save GL beginning balance", ...(err.statusCode && err.code ? { code: err.code } : {}) });
  }
});


// ====================== TRIAL BALANCE REPORT =================

app.get("/api/reports/trial-balance", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { from, to } = req.query;
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const rows = await TrialBalanceDifferenceService.getTrialBalanceRows({ from, to, companyId });
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

app.get("/api/reports/account-analysis", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { from, to, accountCode } = req.query;

    if (!accountCode) {
      return res.status(400).json({ message: "Account code is required" });
    }

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const params = [
      accountCode,
      from,
      to,
      companyId,

      accountCode,
      from,
      to,
      companyId,

      accountCode,
      from,
      to,
      companyId,

      accountCode,
      from,
      to,
      companyId,

      accountCode,
      from,
      to,
      companyId,

      accountCode,
      from,
      to,
      companyId,
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
          AND h.company_id = ?
          AND ${postedOnlySql("h")}

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
          AND h.company_id = ?
          AND ${postedOnlySql("h")}

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
          AND h.company_id = ?
          AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.id,
          DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
          'JV' AS source_type,
          h.voucher_no AS reference_no,
          h.id AS transaction_id,
          l.account_code,
          l.account_title,
          COALESCE(l.particulars, h.description, '') AS particulars,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit,
          4 AS sort_order
        FROM jv_lines l
        JOIN jv_headers h ON h.id = l.jv_id
        WHERE l.account_code = ?
          AND h.transaction_date BETWEEN ? AND ?
          AND h.company_id = ?
          AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.id,
          DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
          'PETTY CASH' AS source_type,
          h.voucher_no AS reference_no,
          h.id AS transaction_id,
          l.account_code,
          l.account_title,
          COALESCE(l.particulars, h.description, '') AS particulars,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit,
          5 AS sort_order
        FROM petty_cash_lines l
        JOIN petty_cash_headers h ON h.id = l.petty_cash_id
        WHERE l.account_code = ?
          AND h.transaction_date BETWEEN ? AND ?
          AND h.company_id = ?
          AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.id,
          DATE_FORMAT(h.transaction_date, '%Y-%m-%d') AS transaction_date,
          CONCAT(h.memo_type, ' MEMO') AS source_type,
          h.voucher_no AS reference_no,
          h.id AS transaction_id,
          l.account_code,
          l.account_title,
          COALESCE(l.particulars, h.description, '') AS particulars,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit,
          6 AS sort_order
        FROM memo_lines l
        JOIN memo_headers h ON h.id = l.memo_id
        WHERE l.account_code = ?
          AND h.transaction_date BETWEEN ? AND ?
          AND h.company_id = ?
          AND ${postedOnlySql("h")}
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

// ====================== GENERAL LEDGER REPORT ======================
// Same engine the Cash Flow Statement below reuses (LedgerReportService),
// just without the account filter - every account with activity in range.

app.get("/api/reports/general-ledger", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { from, to, accountCode } = req.query;

    if (!from || !to) {
      return res.status(400).json({ message: "from and to dates are required" });
    }

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);
    const accountCodes = accountCode ? [accountCode] : null;

    const [rows, beginningBalances] = await Promise.all([
      LedgerReportService.getLedgerRows({ from, to, accountCodes, companyId }),
      LedgerReportService.getBeginningBalances({ before: from, accountCodes, companyId }),
    ]);

    res.json(
      rows.map((row) => ({
        ...row,
        beginning_balance: beginningBalances[row.account_code] || 0,
      }))
    );
  } catch (err) {
    console.error("GENERAL LEDGER REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate general ledger",
      error: err.message,
    });
  }
});

// ====================== CASH FLOW STATEMENT (Cash Receipts & Disbursements) ==
// Reuses LedgerReportService, scoped to accounts flagged BANK / CASH via
// bank_codes (the same table Bank Reconciliation relies on, kept in sync
// with COA's "BANK / CASH" validation by syncBankCodeForAccount).

app.get("/api/reports/cash-flow-statement", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ message: "from and to dates are required" });
    }

    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const [bankAccounts] = await pool.execute(
      `SELECT coa_code, account_name, bank_name FROM bank_codes WHERE status = 'ACTIVE' AND coa_code IS NOT NULL AND coa_code != ''`
    );

    const accountCodes = bankAccounts.map((b) => b.coa_code);

    if (accountCodes.length === 0) {
      return res.json({ accounts: [], totalBeginningBalance: 0, totalEndingBalance: 0 });
    }

    const [rows, beginningBalances] = await Promise.all([
      LedgerReportService.getLedgerRows({ from, to, accountCodes, companyId }),
      LedgerReportService.getBeginningBalances({ before: from, accountCodes, companyId }),
    ]);

    const byAccount = new Map();
    for (const code of accountCodes) {
      const label = bankAccounts.find((b) => b.coa_code === code);
      byAccount.set(code, {
        accountCode: code,
        accountTitle: (label && (label.account_name || label.bank_name)) || code,
        beginningBalance: beginningBalances[code] || 0,
        rows: [],
        endingBalance: beginningBalances[code] || 0,
      });
    }

    for (const row of rows) {
      const acct = byAccount.get(row.account_code);
      if (!acct) continue;
      acct.rows.push(row);
      acct.endingBalance = acct.beginningBalance + Number(row.running_balance || 0);
    }

    const accounts = Array.from(byAccount.values());
    const totalBeginningBalance = accounts.reduce((sum, a) => sum + a.beginningBalance, 0);
    const totalEndingBalance = accounts.reduce((sum, a) => sum + a.endingBalance, 0);

    res.json({ accounts, totalBeginningBalance, totalEndingBalance });
  } catch (err) {
    console.error("CASH FLOW STATEMENT REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate cash flow statement",
      error: err.message,
    });
  }
});

// ====================== OUTPUT VAT REPORT =================

app.get("/api/reports/output-vat", authenticateToken, authorizePermission("REPORTS.BIR_COMPLIANCE", "VIEW"), async (req, res) => {
  try {
    const { from, to, accountCode } = req.query;

    if (!accountCode) {
      return res.status(400).json({ message: "Account code is required" });
    }

    // Checkpoint 7F: this query previously had NO company_id filter at all on
    // either UNION branch (found during the Checkpoint 7 pre-deployment
    // review) - the same class of cross-company leak Checkpoint 6A fixed for
    // Income Statement. Resolved the same established way every other report
    // in this file does. Also found: no Posted-only predicate existed here,
    // unlike every other financial report (Checkpoint 6B's postedOnlySql) -
    // Draft invoices/ORs were leaking into a report that must reflect only
    // financially-recognized transactions. Both are fixed together since the
    // second is a clear, pre-existing violation of the already-approved
    // Posted-only policy, not a scope expansion.
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const params = [accountCode, from, to, companyId, accountCode, from, to, companyId];

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
          AND h.company_id = ?
          AND ${postedOnlySql("h")}

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
          AND h.company_id = ?
          AND ${postedOnlySql("h")}
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

app.get("/api/reports/income-statement", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { from, to } = req.query;
    // Checkpoint 6A: this query previously had NO company_id filter at all
    // on any of its 6 UNION branches - every company's revenue/expense data
    // was combined into one report regardless of who was logged in. Fixed
    // by resolving the caller's company the same way every other report
    // does and requiring company_id = ? on each branch. chart_of_accounts/
    // coa_groups/account_group_codes are intentionally NOT company-filtered
    // - they're a single shared catalog across companies (see
    // checkpoint4h_company_isolation_migration.sql's explicit exclusion),
    // same as every other report in this file already treats them.
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const params = [
      from, to, companyId,
      from, to, companyId,
      from, to, companyId,
      from, to, companyId,
      from, to, companyId,
      from, to, companyId,
    ];

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
        WHERE h.transaction_date BETWEEN ? AND ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM cv_lines l
        JOIN cv_headers h ON h.id = l.cv_id
        WHERE h.transaction_date BETWEEN ? AND ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

          SELECT
  l.account_code,
  COALESCE(l.othrdebit, 0) AS debit,
  COALESCE(l.othrcredit, 0) AS credit
FROM gl_beginning_balance_lines l
JOIN gl_beginning_balance_headers h ON h.id = l.header_id
WHERE h.balance_date BETWEEN ? AND ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_date BETWEEN ? AND ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM petty_cash_lines l
        JOIN petty_cash_headers h ON h.id = l.petty_cash_id
        WHERE h.transaction_date BETWEEN ? AND ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM memo_lines l
        JOIN memo_headers h ON h.id = l.memo_id
        WHERE h.transaction_date BETWEEN ? AND ? AND h.company_id = ? AND ${postedOnlySql("h")}
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

app.get("/api/reports/balance-sheet", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { to } = req.query;
    // Checkpoint 6A: same fix as Income Statement above - this query had no
    // company_id filter on any branch at all. chart_of_accounts/coa_groups/
    // account_group_codes remain unfiltered by design (shared catalog).
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const params = [
      to, companyId,
      to, companyId,
      to, companyId,
      to, companyId,
      to, companyId,
      to, companyId,
    ];

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
        WHERE h.transaction_date <= ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM cv_lines l
        JOIN cv_headers h ON h.id = l.cv_id
        WHERE h.transaction_date <= ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
  l.account_code,
  COALESCE(l.othrdebit, 0) AS debit,
  COALESCE(l.othrcredit, 0) AS credit
FROM gl_beginning_balance_lines l
JOIN gl_beginning_balance_headers h ON h.id = l.header_id
WHERE h.balance_date <= ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_date <= ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM petty_cash_lines l
        JOIN petty_cash_headers h ON h.id = l.petty_cash_id
        WHERE h.transaction_date <= ? AND h.company_id = ? AND ${postedOnlySql("h")}

        UNION ALL

        SELECT
          l.account_code,
          COALESCE(l.debit, 0) AS debit,
          COALESCE(l.credit, 0) AS credit
        FROM memo_lines l
        JOIN memo_headers h ON h.id = l.memo_id
        WHERE h.transaction_date <= ? AND h.company_id = ? AND ${postedOnlySql("h")}
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
app.get("/api/reports/aging", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
  try {
    const { type = "AP", asOf } = req.query;
    const reportType = String(type).toUpperCase();
    const reportDate = asOf || new Date().toISOString().split("T")[0];
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

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
          AND company_id = ?
        `,
        [reportDate, companyId]
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
        AND h.company_id = ?
        AND COALESCE(
          l.balance_amount,
          CASE WHEN h.balance_type = 'AR' THEN l.debit ELSE l.credit END,
          0
        ) > 0
        AND COALESCE(l.status, 'Unpaid') != 'Paid'
      `,
      [reportDate, reportType, companyId]
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
app.get("/api/reports/ap-aging", authenticateToken, authorizePermission("REPORTS.AP", "VIEW"), async (req, res) => {
  try {
    const { asOf, currency, partyId, status } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const rows = await AgingReportService.getAgingRows("AP", {
      companyId,
      asOfDate: reportDate,
      currencyCode: currency,
      partyId,
      status,
    });
    const bucketTotals = AgingReportService.getBucketTotals(rows);

    res.json({ asOfDate: reportDate, rows, bucketTotals });
  } catch (err) {
    console.error("AP AGING REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate AP aging report",
      error: err.message,
    });
  }
});

app.get("/api/reports/ap-aging-summary", authenticateToken, authorizePermission("REPORTS.AP", "VIEW"), async (req, res) => {
  try {
    const { asOf, currency, partyId, status } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const rows = await AgingReportService.getAgingRows("AP", {
      companyId,
      asOfDate: reportDate,
      currencyCode: currency,
      partyId,
      status,
    });
    const parties = AgingReportService.getSummaryByParty(rows);

    res.json({ asOfDate: reportDate, parties });
  } catch (err) {
    console.error("AP AGING SUMMARY REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate AP aging summary report",
      error: err.message,
    });
  }
});


// ====================== AR AGING REPORT ======================
app.get("/api/reports/ar-aging", authenticateToken, authorizePermission("REPORTS.AR", "VIEW"), async (req, res) => {
  try {
    const { asOf, currency, partyId, status } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const rows = await AgingReportService.getAgingRows("AR", {
      companyId,
      asOfDate: reportDate,
      currencyCode: currency,
      partyId,
      status,
    });
    const bucketTotals = AgingReportService.getBucketTotals(rows);

    res.json({ asOfDate: reportDate, rows, bucketTotals });
  } catch (err) {
    console.error("AR AGING REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate AR aging report",
      error: err.message,
    });
  }
});

app.get("/api/reports/ar-aging-summary", authenticateToken, authorizePermission("REPORTS.AR", "VIEW"), async (req, res) => {
  try {
    const { asOf, currency, partyId, status } = req.query;
    const reportDate = asOf || new Date().toISOString().slice(0, 10);
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const rows = await AgingReportService.getAgingRows("AR", {
      companyId,
      asOfDate: reportDate,
      currencyCode: currency,
      partyId,
      status,
    });
    const parties = AgingReportService.getSummaryByParty(rows);

    res.json({ asOfDate: reportDate, parties });
  } catch (err) {
    console.error("AR AGING SUMMARY REPORT ERROR:", err.message);
    res.status(500).json({
      message: "Failed to generate AR aging summary report",
      error: err.message,
    });
  }
});

// ====================== SUBSIDIARY LEDGER REPORT ======================

app.get("/api/reports/subsidiary-ledger", authenticateToken, authorizePermission("LEDGER.SUBSIDIARY_LEDGER", "VIEW"), async (req, res) => {
  try {
    const { type, partyId, from, to } = req.query;

    if (!type || !["AR", "AP"].includes(type)) {
      return res.status(400).json({ message: "type must be AR or AP" });
    }

    if (!partyId) {
      return res.status(400).json({ message: "partyId is required" });
    }

    // Checkpoint 6A: this query previously had NO company_id filter at all -
    // any authenticated user could pass another company's partyId and read
    // that company's real invoice/OR/CV/APV/beginning-balance data. Fixed
    // the same way every other report in this file resolves and enforces
    // company scope, plus an explicit party-ownership check (same pattern
    // used elsewhere for general_libraries records) so a cross-company
    // partyId is rejected outright rather than just returning an empty set.
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const [partyRows] = await pool.execute("SELECT company_id FROM general_libraries WHERE id = ?", [partyId]);
    if (!partyRows.length || partyRows[0].company_id !== companyId) {
      return res.status(404).json({ message: "Party not found" });
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
        WHERE customer_id = ? AND transaction_date BETWEEN ? AND ? AND company_id = ? AND ${postedOnlySql()}

        UNION ALL

        SELECT
          id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
          'OR' AS source_type, voucher_no AS reference_no, id AS transaction_id,
          COALESCE(description, '') AS particulars,
          0 AS debit, COALESCE(total_debit, 0) AS credit, 2 AS sort_order
        FROM or_headers
        WHERE customer_id = ? AND transaction_date BETWEEN ? AND ? AND company_id = ? AND ${postedOnlySql()}

        UNION ALL

        SELECT
          l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
          'AR BEGINNING' AS source_type, l.reference_no, NULL AS transaction_id,
          COALESCE(l.party_name, '') AS particulars,
          COALESCE(l.debit, 0) AS debit, 0 AS credit, 0 AS sort_order
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_type = ? AND l.party_id = ? AND h.balance_date BETWEEN ? AND ? AND h.company_id = ? AND ${postedOnlySql("h")}
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
        WHERE payee_id = ? AND transaction_date BETWEEN ? AND ? AND company_id = ? AND ${postedOnlySql()}

        UNION ALL

        SELECT
          id, DATE_FORMAT(transaction_date, '%Y-%m-%d') AS transaction_date,
          'APV' AS source_type, voucher_no AS reference_no, id AS transaction_id,
          COALESCE(description, '') AS particulars,
          0 AS debit, COALESCE(total_credit, 0) AS credit, 1 AS sort_order
        FROM apv_headers
        WHERE supplier_id = ? AND transaction_date BETWEEN ? AND ? AND company_id = ? AND ${postedOnlySql()}

        UNION ALL

        SELECT
          l.id, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS transaction_date,
          'AP BEGINNING' AS source_type, l.reference_no, NULL AS transaction_id,
          COALESCE(l.party_name, '') AS particulars,
          0 AS debit, COALESCE(l.credit, 0) AS credit, 0 AS sort_order
        FROM arap_beginning_balance_lines l
        JOIN arap_beginning_balance_headers h ON h.id = l.header_id
        WHERE h.balance_type = ? AND l.party_id = ? AND h.balance_date BETWEEN ? AND ? AND h.company_id = ? AND ${postedOnlySql("h")}
      ) sl
      ORDER BY transaction_date, sort_order, id
      `;

    const queryParams =
      type === "AR"
        ? [partyId, from, to, companyId, partyId, from, to, companyId, "AR", partyId, from, to, companyId]
        : [partyId, from, to, companyId, partyId, from, to, companyId, "AP", partyId, from, to, companyId];

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

app.get("/api/fixed-assets", authenticateToken, authorizePermission("FILESETUP.FIXED_ASSETS", "VIEW"), async (req, res) => {
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

app.post("/api/fixed-assets", authenticateToken, authorizePermission("FILESETUP.FIXED_ASSETS", "CREATE"), async (req, res) => {
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

app.put("/api/fixed-assets/:id", authenticateToken, authorizePermission("FILESETUP.FIXED_ASSETS", "EDIT"), async (req, res) => {
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

app.delete("/api/fixed-assets/:id", authenticateToken, authorizePermission("FILESETUP.FIXED_ASSETS", "DELETE"), async (req, res) => {
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

app.get("/api/reports/fixed-asset-register", authenticateToken, authorizePermission("REPORTS.FIXED_ASSETS", "VIEW"), async (req, res) => {
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

app.get("/api/prepaid-accounts", authenticateToken, authorizePermission("FILESETUP.PREPAID_ACCOUNTS", "VIEW"), async (req, res) => {
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

app.post("/api/prepaid-accounts", authenticateToken, authorizePermission("FILESETUP.PREPAID_ACCOUNTS", "CREATE"), async (req, res) => {
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

app.put("/api/prepaid-accounts/:id", authenticateToken, authorizePermission("FILESETUP.PREPAID_ACCOUNTS", "EDIT"), async (req, res) => {
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

app.delete("/api/prepaid-accounts/:id", authenticateToken, authorizePermission("FILESETUP.PREPAID_ACCOUNTS", "DELETE"), async (req, res) => {
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

app.get("/api/reports/prepaid-list", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
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

app.get("/api/reports/lapsed-prepayments", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
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

app.get("/api/reports/prepayment-lapsing", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
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

app.get("/api/reports/prepaid-subsidiary", authenticateToken, authorizePermission("REPORTS.FINANCIAL", "VIEW"), async (req, res) => {
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

app.get("/api/ewt-library", authenticateToken, authorizePermission("FILESETUP.TAX_SETUP", "VIEW"), async (req, res) => {
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

app.post("/api/ewt-library", authenticateToken, authorizePermission("FILESETUP.TAX_SETUP", "CONFIGURE"), async (req, res) => {
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

app.put("/api/ewt-library/:id", authenticateToken, authorizePermission("FILESETUP.TAX_SETUP", "CONFIGURE"), async (req, res) => {
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

app.delete("/api/ewt-library/:id", authenticateToken, authorizePermission("FILESETUP.TAX_SETUP", "CONFIGURE"), async (req, res) => {
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

app.get("/api/reports/alphalist", authenticateToken, authorizePermission("REPORTS.BIR_COMPLIANCE", "VIEW"), async (req, res) => {
  try {
    const { taxType, month } = req.query;

    if (!taxType || !["EWT", "FINAL"].includes(taxType)) {
      return res.status(400).json({ message: "taxType must be EWT or FINAL" });
    }

    if (!month) {
      return res.status(400).json({ message: "month (YYYY-MM) is required" });
    }

    // Phase 7D.1 bug fix: this query previously had NO company_id filter
    // at all - a cross-company data leak matching the exact class of bug
    // Checkpoint 6A fixed for the income statement report, just missed
    // here. Discovered and fixed while already touching this exact query
    // for the EWT double-count fix below (see
    // ewtReportReconciliationService.js for the full authority-rule
    // reasoning) - not something Phase 7D.1 originally set out to look
    // for, but directly in the blast radius of what it's already editing.
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const fromDate = `${month}-01`;
    const toDate = `${month}-31`; // inclusive upper bound - a real calendar date compare, not a strict day count

    // The APV-accrual-vs-CV-remittance double-count risk is architecturally
    // identical for EWT and FINAL tax (both flow through the same
    // apv_headers/cv_headers.tax_type/tax_withheld_amount columns) - the
    // same reconciliation applies uniformly to whichever taxType was
    // requested, not just EWT.
    const allEvents = await EwtReportReconciliationService.resolveReportableEwtEvents({ companyId, taxType });
    const events = EwtReportReconciliationService.filterEventsByDateRange(allEvents, fromDate, toDate);

    const grouped = new Map();
    for (const e of events) {
      const key = [e.partyName, e.tin, e.atcCode, e.taxRate].join("|");
      if (!grouped.has(key)) {
        grouped.set(key, { payeeName: e.partyName, tin: e.tin, atcCode: e.atcCode, taxRate: e.taxRate, transactionCount: 0, grossAmount: 0, taxWithheld: 0 });
      }
      const g = grouped.get(key);
      g.transactionCount += 1;
      g.grossAmount = EwtReportReconciliationService.roundMoney(g.grossAmount + Number(e.grossAmount || 0));
      g.taxWithheld = EwtReportReconciliationService.roundMoney(g.taxWithheld + Number(e.taxWithheld || 0));
    }

    const rows = [...grouped.values()].sort((a, b) => a.payeeName.localeCompare(b.payeeName));

    res.json(rows);
  } catch (err) {
    console.error("ALPHALIST REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate alphalist report", error: err.message });
  }
});

// ===================== COMPANY PROFILE API =====================

app.get("/api/company-profile", authenticateToken, authorizePermission("FILESETUP.COMPANY_SETUP", "VIEW"), async (req, res) => {
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

app.put("/api/company-profile", authenticateToken, authorizePermission("FILESETUP.COMPANY_SETUP", "CONFIGURE"), async (req, res) => {
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

app.get("/api/reports/2307", authenticateToken, authorizePermission("REPORTS.BIR_COMPLIANCE", "VIEW"), async (req, res) => {
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

    // Phase 7D.1 bug fix: this route (and its general_libraries payee
    // lookup) previously had NO company_id scoping at all - the same
    // cross-company leak fixed in /api/reports/alphalist above, found
    // while touching this exact query for the EWT double-count fix.
    const companyId = await CurrencyService.resolveCompanyIdForWrite(req.user, req.query.companyId);

    const [payeeRows] = await pool.execute(
      `SELECT name, tin, address1, address2, address3, atc_code AS atcCode
       FROM general_libraries WHERE id = ? AND company_id = ?`,
      [supplierId, companyId]
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

    // Phase 7D.1: same reconciliation as /api/reports/alphalist (CV
    // supersedes APV when it safely, unambiguously settles exactly that
    // one APV and independently recorded its own EWT - see
    // ewtReportReconciliationService.js). PO stays excluded (converts
    // into APV) and Invoice/OR stay excluded (that EWT is the customer's,
    // not ours) - both preserved exactly as the original comment
    // documented, unchanged by this fix. CV's party column is payee_id,
    // but it references the same general_libraries row as APV's
    // supplier_id - both are `partyId` on the reconciled events below.
    const quarterStart = `${year}-${String(firstMonth).padStart(2, "0")}-01`;
    const quarterEnd = `${year}-${String(thirdMonth).padStart(2, "0")}-31`;

    const allEvents = await EwtReportReconciliationService.resolveReportableEwtEvents({ companyId, taxType: "EWT" });
    const events = EwtReportReconciliationService.filterEventsByDateRange(allEvents, quarterStart, quarterEnd)
      .filter((e) => String(e.partyId) === String(supplierId));

    const grouped = new Map();
    for (const e of events) {
      if (!grouped.has(e.atcCode)) {
        grouped.set(e.atcCode, { atcCode: e.atcCode, month1Amount: 0, month2Amount: 0, month3Amount: 0, totalAmount: 0, totalTaxWithheld: 0 });
      }
      const g = grouped.get(e.atcCode);
      const eventMonth = Number(e.transactionDate.slice(5, 7));
      const gross = Number(e.grossAmount || 0);
      if (eventMonth === firstMonth) g.month1Amount = EwtReportReconciliationService.roundMoney(g.month1Amount + gross);
      else if (eventMonth === secondMonth) g.month2Amount = EwtReportReconciliationService.roundMoney(g.month2Amount + gross);
      else if (eventMonth === thirdMonth) g.month3Amount = EwtReportReconciliationService.roundMoney(g.month3Amount + gross);
      g.totalAmount = EwtReportReconciliationService.roundMoney(g.totalAmount + gross);
      g.totalTaxWithheld = EwtReportReconciliationService.roundMoney(g.totalTaxWithheld + Number(e.taxWithheld || 0));
    }

    const lines = [...grouped.values()].sort((a, b) => (a.atcCode || "").localeCompare(b.atcCode || ""));

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

// ===================== EWT HISTORICAL AUDIT (Phase 4) =====================
// Read-only. Re-derives what taxable_base/tax_withheld_amount SHOULD be for
// every stored EWT record from its current lines, using the exact same
// resolveTaxWithholding formula the save path now enforces, and flags any
// row whose stored values disagree beyond the one-centavo tolerance -
// almost always a record saved before this fix (the old gross-based bug)
// or with taxable_base still NULL (saved before that column existed).
// Nothing is written back; this is a review tool, not a migration.
const EWT_AUDIT_MODULES = [
  { module: "apv", headerTable: "apv_headers", lineTable: "apv_lines", lineIdCol: "apv_id", grossCol: "total_credit", vatKeyword: "input vat" },
  { module: "cv", headerTable: "cv_headers", lineTable: "cv_lines", lineIdCol: "cv_id", grossCol: "total_credit", vatKeyword: "input vat" },
  { module: "po", headerTable: "purchase_order_headers", lineTable: "purchase_order_lines", lineIdCol: "po_id", grossCol: "total_credit", vatKeyword: "input vat" },
  { module: "invoice", headerTable: "invoice_headers", lineTable: "invoice_lines", lineIdCol: "invoice_id", grossCol: "total_debit", vatKeyword: "output vat" },
  { module: "or", headerTable: "or_headers", lineTable: "or_lines", lineIdCol: "or_id", grossCol: "total_debit", vatKeyword: "output vat" },
];

app.get("/api/reports/ewt-audit", authenticateToken, authorizePermission("REPORTS.BIR_COMPLIANCE", "VIEW"), async (req, res) => {
  try {
    const flagged = [];
    let totalChecked = 0;

    for (const cfg of EWT_AUDIT_MODULES) {
      const [rows] = await pool.execute(
        `SELECT id, voucher_no AS voucherNo, ${cfg.grossCol} AS grossAmount, atc_code AS atcCode,
                tax_rate AS taxRate, tax_withheld_amount AS taxWithheldAmount, taxable_base AS taxableBase
         FROM ${cfg.headerTable}
         WHERE atc_code IS NOT NULL`
      );

      for (const row of rows) {
        totalChecked++;
        const [lineRows] = await pool.execute(
          `SELECT account_title AS accountTitle, debit, credit FROM ${cfg.lineTable} WHERE ${cfg.lineIdCol} = ?`,
          [row.id]
        );

        const computedBase = computeEwtTaxableBase({ grossAmount: row.grossAmount, lines: lineRows, vatKeyword: cfg.vatKeyword });
        const computedAmount = computeEwtAmount({ taxableBase: computedBase, ewtRate: row.taxRate });
        const storedAmount = Number(row.taxWithheldAmount) || 0;
        const storedBase = row.taxableBase != null ? Number(row.taxableBase) : null;

        const amountMismatch = Math.abs(storedAmount - computedAmount) > 0.01;
        const baseMismatch = storedBase === null || Math.abs(storedBase - computedBase) > 0.01;

        if (amountMismatch || baseMismatch) {
          flagged.push({
            module: cfg.module,
            id: row.id,
            voucherNo: row.voucherNo,
            atcCode: row.atcCode,
            taxRate: row.taxRate,
            grossAmount: Number(row.grossAmount),
            storedTaxableBase: storedBase,
            computedTaxableBase: computedBase,
            storedTaxWithheldAmount: storedAmount,
            computedTaxWithheldAmount: computedAmount,
            reason: !storedBase ? "taxable_base not recorded (pre-dates audit column)" : "stored amount does not match recomputed amount",
          });
        }
      }
    }

    res.json({ generatedAt: new Date().toISOString(), totalChecked, flaggedCount: flagged.length, flagged });
  } catch (err) {
    console.error("EWT AUDIT REPORT ERROR:", err.message);
    res.status(500).json({ message: "Failed to generate EWT audit report", error: err.message });
  }
});

// ===================== BANK CODES API =====================

app.get("/api/bank-codes", authenticateToken, authorizePermission("FILESETUP.BANK_CODES", "VIEW"), async (req, res) => {
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

app.post("/api/bank-codes/sync", authenticateToken, authorizePermission("FILESETUP.BANK_CODES", "CONFIGURE"), async (req, res) => {
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

app.post("/api/bank-codes", authenticateToken, authorizePermission("FILESETUP.BANK_CODES", "CONFIGURE"), async (req, res) => {
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

app.put("/api/bank-codes/:id", authenticateToken, authorizePermission("FILESETUP.BANK_CODES", "CONFIGURE"), async (req, res) => {
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

app.delete("/api/bank-codes/:id", authenticateToken, authorizePermission("FILESETUP.BANK_CODES", "CONFIGURE"), async (req, res) => {
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

// Checkpoint 4I: makes the app importable by Supertest (or anything else)
// without opening a production listener or starting the scheduler cron -
// require.main === module is true only when this file is executed
// directly (exactly what `npm start` / `node src/backend/server.js` does),
// false when require()'d by a test file. Production startup is otherwise
// byte-identical to before this change.
module.exports = app;

const PORT = process.env.PORT || 8080;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    require("./jobs/recurringSchedulerJob").start();
  });
}