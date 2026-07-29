const path = require("path");
const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { extractRowsFromXlsx, parseCsvRows } = require("./StatementImportService");
const ValidationService = require("./beginningBalanceValidationService");
const GLBeginningBalanceService = require("./GLBeginningBalanceService");

const TEMPLATE_VERSION = "1.0";

const GL_FIELD_ALIASES = {
  accountCode: ["account code", "acct code", "code"],
  accountTitle: ["account title", "account name", "title"],
  balanceDate: ["beginning balance date", "balance date", "date"],
  debit: ["debit"],
  credit: ["credit"],
  referenceNo: ["reference number", "reference no", "reference"],
  description: ["description", "particulars"],
  department: ["department", "dept"],
  project: ["project"],
  remarks: ["remarks", "notes"],
};

// AR and AP share the exact same column shape - the only difference is
// which party type / COA validation flag a row must resolve against
// (see MODULE_CONFIG below), so one alias table covers both.
const PARTY_FIELD_ALIASES = {
  partyCode: ["customer code", "supplier code", "party code", "code"],
  partyName: ["customer name", "supplier name", "party name", "name"],
  accountCode: ["account code", "acct code"],
  documentNumber: ["document number", "document no", "doc number", "doc no", "invoice no"],
  balanceDate: ["beginning balance date", "balance date"],
  documentDate: ["document date", "doc date"],
  dueDate: ["due date"],
  referenceNo: ["reference number", "reference no", "reference"],
  originalAmount: ["original amount", "amount"],
  paidAmount: ["paid amount"],
  balanceAmount: ["balance amount"],
};

function normalizeHeaderKey(header) {
  return String(header || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveColumnMapping(headers, aliases) {
  const normalized = headers.map(normalizeHeaderKey);
  const mapping = {};

  for (const field of Object.keys(aliases)) {
    const idx = normalized.findIndex((h) => aliases[field].includes(h));
    if (idx !== -1) mapping[field] = idx;
  }

  return mapping;
}

async function extractRows(buffer, filename) {
  const ext = path.extname(filename || "").toLowerCase();

  if (ext === ".csv") {
    const records = parseCsvRows(buffer);
    return { headers: records[0] || [], dataRows: records.slice(1) };
  }

  return extractRowsFromXlsx(buffer);
}

function rowValuesToObject(rowValues, mapping) {
  const obj = {};
  for (const field of Object.keys(mapping)) {
    obj[field] = rowValues[mapping[field]];
  }
  return obj;
}

async function buildGLContext() {
  const [accounts] = await pool.execute("SELECT id, code, title FROM chart_of_accounts");
  const accountsByCode = new Map();
  for (const a of accounts) {
    accountsByCode.set(ValidationService.normalizeCode(a.code), a);
  }
  return { accountsByCode };
}

// AR/AP context: parties from general_libraries (by party_type), accounts
// restricted to those carrying the AR CODE / AP CODE validation flag -
// the same flags already used elsewhere in this app (coa_validations),
// more precise than the manual entry page's "title contains receivable/
// payable" heuristic, which is left untouched for the manual page itself.
async function buildPartyContext(partyType, coaValidationFlag) {
  const [parties] = await pool.execute(
    "SELECT id, code, name FROM general_libraries WHERE party_type = ?",
    [partyType]
  );
  const partiesByCode = new Map();
  for (const p of parties) {
    partiesByCode.set(ValidationService.normalizeCode(p.code), p);
  }

  const [accounts] = await pool.execute(
    `SELECT ca.id, ca.code, ca.title
     FROM chart_of_accounts ca
     JOIN coa_validations cv ON cv.coa_id = ca.id
     WHERE cv.validation_name = ?`,
    [coaValidationFlag]
  );
  const accountsByCode = new Map();
  for (const a of accounts) {
    accountsByCode.set(ValidationService.normalizeCode(a.code), a);
  }

  return { partiesByCode, accountsByCode };
}

// Detects rows that would collide with an EXISTING (already-committed) DB
// record - distinct from findInFileDuplicates, which only looks within the
// uploaded file itself.
async function findExistingGLDuplicates(resolvedRows) {
  const [existing] = await pool.execute(
    `SELECT l.account_code AS accountCode, DATE_FORMAT(h.balance_date, '%Y-%m-%d') AS balanceDate
     FROM gl_beginning_balance_lines l
     JOIN gl_beginning_balance_headers h ON h.id = l.header_id`
  );

  const existingKeys = new Set(
    existing.map((r) => `${ValidationService.normalizeCode(r.accountCode)}|${r.balanceDate}`)
  );

  return resolvedRows.map(
    (r) => r && existingKeys.has(`${ValidationService.normalizeCode(r.accountCode)}|${r.balanceDate}`)
  );
}

// AR/AP "already exists" = same Document Number already recorded under a
// header of the SAME balance type (AR numbers and AP numbers are separate
// numbering domains, matching normal accounting convention). Rows with no
// Document Number are never flagged as existing-duplicates - uniqueness
// only applies "where required" per the rule, i.e. when actually provided.
async function findExistingARAPDuplicates(resolvedRows, balanceType) {
  const [existing] = await pool.execute(
    `SELECT l.invoice_no AS documentNumber
     FROM arap_beginning_balance_lines l
     JOIN arap_beginning_balance_headers h ON h.id = l.header_id
     WHERE h.balance_type = ? AND l.invoice_no IS NOT NULL AND l.invoice_no != ''`,
    [balanceType]
  );

  const existingDocNumbers = new Set(existing.map((r) => String(r.documentNumber).trim().toLowerCase()));

  return resolvedRows.map((r) => {
    if (!r || !r.documentNumber) return false;
    return existingDocNumbers.has(String(r.documentNumber).trim().toLowerCase());
  });
}

const MODULE_CONFIG = {
  gl: {
    fieldAliases: GL_FIELD_ALIASES,
    requiredColumns: ["accountCode", "balanceDate"],
    validate: ValidationService.validateGLRow,
    buildContext: buildGLContext,
    duplicateKeyFn: (r) => (r.accountCode && r.balanceDate ? `${r.accountCode}|${r.balanceDate}` : null),
    duplicateLabel: "Account Code / Date",
    duplicateExistingMessage: "A beginning balance for this Account Code and Date already exists in the system.",
    duplicateInFileMessage: "This Account Code and Date combination appears more than once in the uploaded file.",
    findExistingDuplicates: findExistingGLDuplicates,
    hasBalanceCheck: true,
  },
  ar: {
    fieldAliases: PARTY_FIELD_ALIASES,
    requiredColumns: ["partyCode", "accountCode", "balanceDate", "dueDate", "originalAmount"],
    validate: ValidationService.validateARRow,
    buildContext: () => buildPartyContext("CUSTOMER", "AR CODE"),
    duplicateKeyFn: (r) => (r.documentNumber ? r.documentNumber.toLowerCase() : null),
    duplicateLabel: "Document Number",
    duplicateExistingMessage: "An AR beginning balance with this Document Number already exists in the system.",
    duplicateInFileMessage: "This Document Number appears more than once in the uploaded file.",
    findExistingDuplicates: (rows) => findExistingARAPDuplicates(rows, "AR"),
    hasBalanceCheck: false,
  },
  ap: {
    fieldAliases: PARTY_FIELD_ALIASES,
    requiredColumns: ["partyCode", "accountCode", "balanceDate", "dueDate", "originalAmount"],
    validate: ValidationService.validateAPRow,
    buildContext: () => buildPartyContext("SUPPLIER", "AP CODE"),
    duplicateKeyFn: (r) => (r.documentNumber ? r.documentNumber.toLowerCase() : null),
    duplicateLabel: "Document Number",
    duplicateExistingMessage: "An AP beginning balance with this Document Number already exists in the system.",
    duplicateInFileMessage: "This Document Number appears more than once in the uploaded file.",
    findExistingDuplicates: (rows) => findExistingARAPDuplicates(rows, "AP"),
    hasBalanceCheck: false,
  },
};

async function validateAndScoreRows(module, dataRows, mapping) {
  const cfg = MODULE_CONFIG[module];
  const context = await cfg.buildContext();

  const parsedRows = dataRows.map((rowValues) => rowValuesToObject(rowValues, mapping));

  const inFileDuplicateRowIdx = ValidationService.findInFileDuplicates(parsedRows, cfg.duplicateKeyFn);

  const results = parsedRows.map((row) => cfg.validate(row, context));
  const existingDuplicateFlags = await cfg.findExistingDuplicates(results.map((r) => r.resolved));

  return results.map((result, idx) => {
    const errors = [...result.errors];
    const warnings = [...result.warnings];

    const isInFileDuplicate = inFileDuplicateRowIdx.has(idx);
    const isExistingDuplicate = existingDuplicateFlags[idx];

    let status = "VALID";
    if (errors.length > 0) {
      status = "INVALID";
    } else if (isInFileDuplicate || isExistingDuplicate) {
      status = "DUPLICATE";
      warnings.push({
        column: cfg.duplicateLabel,
        value: cfg.duplicateKeyFn(result.resolved) || "",
        message: isExistingDuplicate ? cfg.duplicateExistingMessage : cfg.duplicateInFileMessage,
      });
    } else if (warnings.length > 0) {
      status = "WARNING";
    }

    return {
      rowNumber: idx + 2, // +1 header row, +1 for 1-indexing
      status,
      errors,
      warnings,
      // Store the field-mapped object, not the raw positional cell array -
      // commit re-validates by feeding this back into the same validator.
      raw: parsedRows[idx],
      resolved: result.resolved,
    };
  });
}

async function previewImport({ module, buffer, filename, duplicateMode, user }) {
  const cfg = MODULE_CONFIG[module];
  if (!cfg) {
    throw Object.assign(new Error(`Unsupported module "${module}"`), { statusCode: 400 });
  }

  const { headers, dataRows } = await extractRows(buffer, filename);

  if (headers.length === 0) {
    throw Object.assign(new Error("The file appears to be empty"), { statusCode: 400 });
  }

  const mapping = resolveColumnMapping(headers, cfg.fieldAliases);

  const missingRequired = cfg.requiredColumns.filter((f) => mapping[f] === undefined);
  if (missingRequired.length > 0) {
    throw Object.assign(
      new Error(`Missing required column(s) in the uploaded file: ${missingRequired.join(", ")}`),
      { statusCode: 400, headers }
    );
  }

  const scoredRows = await validateAndScoreRows(module, dataRows, mapping);

  const validRows = scoredRows.filter((r) => r.status === "VALID" || r.status === "WARNING");
  const balanceSummary = cfg.hasBalanceCheck
    ? ValidationService.validateGLBatchBalance(validRows.map((r) => r.resolved))
    : null;

  const summary = {
    totalRows: scoredRows.length,
    validRows: scoredRows.filter((r) => r.status === "VALID").length,
    warningRows: scoredRows.filter((r) => r.status === "WARNING").length,
    invalidRows: scoredRows.filter((r) => r.status === "INVALID").length,
    duplicateRows: scoredRows.filter((r) => r.status === "DUPLICATE").length,
    ...(balanceSummary || {}),
  };

  const conn = await pool.getConnection();
  let batchId;

  try {
    await conn.beginTransaction();

    const [batchResult] = await conn.execute(
      `INSERT INTO import_batches
        (module, template_version, file_name, status, total_rows, valid_rows, invalid_rows,
         warning_rows, total_debit, total_credit, duplicate_mode, created_by, created_by_username)
       VALUES (?, ?, ?, 'PREVIEWED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        module.toUpperCase() + "_BEGINNING_BALANCE",
        TEMPLATE_VERSION,
        filename || null,
        summary.totalRows,
        summary.validRows,
        summary.invalidRows,
        summary.warningRows,
        summary.totalDebit || 0,
        summary.totalCredit || 0,
        duplicateMode || "REJECT",
        user?.id || null,
        user?.username || null,
      ]
    );

    batchId = batchResult.insertId;

    for (const row of scoredRows) {
      await conn.execute(
        `INSERT INTO import_batch_rows (batch_id, row_num, raw_data, resolved_data, status, errors)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          batchId,
          row.rowNumber,
          JSON.stringify(row.raw),
          JSON.stringify(row.resolved),
          row.status,
          JSON.stringify([...row.errors, ...row.warnings]),
        ]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return {
    batchId,
    summary,
    rows: scoredRows.map((r) => ({
      rowNumber: r.rowNumber,
      status: r.status,
      errors: r.errors,
      warnings: r.warnings,
      data: r.resolved,
    })),
  };
}

// AR/AP header-per-date lookup/creation, mirroring GLBeginningBalanceService
// .findOrCreateHeader but scoped by balance_type too. Lines insert with the
// exact same column set the existing manual POST /api/arap-beginning-balances
// handler uses, plus a matching arap_payment_schedules row (schedule dates
// beginning balances need one to appear consistently with manually-entered
// ones in reports/aging that join through it).
async function findOrCreateARAPHeader(conn, { balanceType, balanceDate }) {
  const [existing] = await conn.execute(
    `SELECT id FROM arap_beginning_balance_headers WHERE balance_type = ? AND balance_date = ? LIMIT 1`,
    [balanceType, balanceDate]
  );

  if (existing.length > 0) return existing[0].id;

  const [result] = await conn.execute(
    `INSERT INTO arap_beginning_balance_headers (balance_type, balance_date, currency_code, currency_name, remarks, status)
     VALUES (?, ?, 'PHP', 'PHILIPPINE PESO', ?, 'Posted')`,
    [balanceType, balanceDate, `Imported ${new Date().toISOString().slice(0, 10)}`]
  );

  return result.insertId;
}

async function insertARAPLine(conn, headerId, row, isAR) {
  const amount = row.originalAmount - row.paidAmount;

  const [lineResult] = await conn.execute(
    `INSERT INTO arap_beginning_balance_lines
      (header_id, party_id, party_code, party_name, account_id, account_code, account_title,
       reference_no, invoice_no, document_date, due_date, debit, credit, balance_amount, paid_amount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      headerId,
      row.partyId,
      row.partyCode,
      row.partyName,
      row.accountId,
      row.accountCode,
      row.accountTitle,
      row.referenceNo,
      row.documentNumber,
      row.documentDate,
      row.dueDate,
      isAR ? amount : 0,
      isAR ? 0 : amount,
      row.balanceAmount,
      row.paidAmount || 0,
      row.paidAmount > 0 ? "Partially Paid" : "Unpaid",
    ]
  );

  await conn.execute(
    `INSERT INTO arap_payment_schedules
      (beginning_balance_line_id, schedule_date, amount, paid_amount, balance_amount, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      lineResult.insertId,
      row.dueDate,
      row.balanceAmount,
      0,
      row.balanceAmount,
      "Unpaid",
    ]
  );
}

async function commitImport({ module, batchId, user }) {
  const cfg = MODULE_CONFIG[module];
  if (!cfg) {
    throw Object.assign(new Error(`Unsupported module "${module}"`), { statusCode: 400 });
  }

  const [batchRows] = await pool.execute("SELECT * FROM import_batches WHERE id = ?", [batchId]);
  const batch = batchRows[0];

  if (!batch) {
    throw Object.assign(new Error("Import batch not found"), { statusCode: 404 });
  }
  if (batch.status === "COMMITTED") {
    throw Object.assign(new Error("This import batch has already been committed"), { statusCode: 409 });
  }
  if (batch.template_version !== TEMPLATE_VERSION) {
    throw Object.assign(
      new Error(`This batch was created with template version ${batch.template_version}, which is no longer supported (current: ${TEMPLATE_VERSION}). Please re-download the template and re-upload.`),
      { statusCode: 409 }
    );
  }

  const [storedRows] = await pool.execute(
    "SELECT * FROM import_batch_rows WHERE batch_id = ? ORDER BY row_num ASC",
    [batchId]
  );

  // Re-validate against FRESH context - do not trust preview's stored
  // status, since master data (accounts/parties) may have changed since.
  const context = await cfg.buildContext();

  const revalidated = storedRows.map((stored) => {
    const raw = stored.raw_data; // mysql2 already parses JSON columns
    const result = cfg.validate(raw, context);
    return { rowNum: stored.row_num, errors: result.errors, warnings: result.warnings, resolved: result.resolved };
  });

  const insertable = revalidated.filter((r) => r.errors.length === 0);
  const rejected = revalidated.filter((r) => r.errors.length > 0);

  // Re-check BOTH duplicate sources at commit time, same as preview - an
  // in-file duplicate pair would otherwise both pass "exists in DB?" (since
  // neither is in the DB yet) and both get inserted.
  const inFileDuplicateIdx = ValidationService.findInFileDuplicates(
    insertable.map((r) => r.resolved),
    cfg.duplicateKeyFn
  );
  const existingDuplicateFlags = await cfg.findExistingDuplicates(insertable.map((r) => r.resolved));

  const toInsert = [];
  const skippedDuplicates = [];

  insertable.forEach((r, idx) => {
    if (existingDuplicateFlags[idx] || inFileDuplicateIdx.has(idx)) {
      if (batch.duplicate_mode === "SKIP_EXISTING") {
        skippedDuplicates.push(r);
      } else {
        rejected.push({ ...r, errors: [{ column: cfg.duplicateLabel, value: "", message: "Duplicate row (Reject mode)." }] });
      }
    } else {
      toInsert.push(r);
    }
  });

  if (rejected.length > 0 && batch.duplicate_mode !== "SKIP_EXISTING") {
    // Strict mode: any invalid/rejected row blocks the whole commit rather
    // than silently skipping it - matches "do not silently skip invalid
    // rows unless the user explicitly chooses a valid-rows-only mode."
    throw Object.assign(
      new Error(`${rejected.length} row(s) failed re-validation at commit time and blocked the import. Re-run Preview to see current errors.`),
      { statusCode: 422, rejectedCount: rejected.length }
    );
  }

  if (cfg.hasBalanceCheck) {
    const balance = ValidationService.validateGLBatchBalance(toInsert.map((r) => r.resolved));
    if (!balance.balanced) {
      throw Object.assign(
        new Error(`Total Debit (${balance.totalDebit.toFixed(2)}) and Total Credit (${balance.totalCredit.toFixed(2)}) are not balanced - difference of ${balance.difference.toFixed(2)}.`),
        { statusCode: 422 }
      );
    }
  }

  const conn = await pool.getConnection();
  let imported = 0;

  try {
    await conn.beginTransaction();

    if (module === "gl") {
      const headerCache = new Map();

      for (const row of toInsert) {
        const dateKey = row.resolved.balanceDate;
        if (!headerCache.has(dateKey)) {
          const headerId = await GLBeginningBalanceService.findOrCreateHeader(conn, {
            balanceDate: dateKey,
            title: `Imported ${new Date().toISOString().slice(0, 10)}`,
          });
          headerCache.set(dateKey, headerId);
        }

        await GLBeginningBalanceService.insertLine(conn, headerCache.get(dateKey), {
          accountId: row.resolved.accountId,
          accountCode: row.resolved.accountCode,
          accountTitle: row.resolved.accountTitle,
          projectCode: row.resolved.project,
          deptCode: row.resolved.department,
          debit: row.resolved.debit,
          credit: row.resolved.credit,
          referenceNo: row.resolved.referenceNo,
          remarks: row.resolved.remarks,
        });

        imported++;
      }
    } else {
      const balanceType = module.toUpperCase();
      const isAR = module === "ar";
      const headerCache = new Map();

      for (const row of toInsert) {
        const dateKey = row.resolved.balanceDate;
        if (!headerCache.has(dateKey)) {
          const headerId = await findOrCreateARAPHeader(conn, { balanceType, balanceDate: dateKey });
          headerCache.set(dateKey, headerId);
        }

        await insertARAPLine(conn, headerCache.get(dateKey), row.resolved, isAR);
        imported++;
      }
    }

    await conn.execute(
      `UPDATE import_batches SET status = 'COMMITTED', committed_at = NOW() WHERE id = ?`,
      [batchId]
    );

    await logAudit(conn, {
      module: "BEGINNING_BALANCE_IMPORT",
      entityType: "IMPORT_BATCH",
      entityId: batchId,
      action: "COMMIT",
      description: `${module.toUpperCase()} beginning balance import committed: ${imported} row(s) imported, ${skippedDuplicates.length} skipped as duplicates, from file "${batch.file_name || "unknown"}"`,
      afterData: { imported, skippedDuplicates: skippedDuplicates.length, templateVersion: TEMPLATE_VERSION },
      user,
    });

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return {
    success: true,
    batchId,
    imported,
    skippedDuplicates: skippedDuplicates.length,
  };
}

module.exports = {
  TEMPLATE_VERSION,
  GL_FIELD_ALIASES,
  PARTY_FIELD_ALIASES,
  previewImport,
  commitImport,
};
