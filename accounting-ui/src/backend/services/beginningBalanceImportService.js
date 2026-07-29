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

const REQUIRED_COLUMNS_BY_MODULE = {
  gl: ["accountCode", "balanceDate"],
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

// Detects rows that would collide with an EXISTING (already-committed) DB
// record - distinct from findInFileDuplicates, which only looks within the
// uploaded file itself. For GL, "already exists" = same account + same
// balance date already has a line.
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

async function validateAndScoreRows(module, dataRows, mapping) {
  const context = module === "gl" ? await buildGLContext() : null;
  const validate = module === "gl" ? ValidationService.validateGLRow : null;

  const parsedRows = dataRows.map((rowValues) => rowValuesToObject(rowValues, mapping));

  const inFileDuplicateRowIdx =
    module === "gl"
      ? ValidationService.findInFileDuplicates(
          parsedRows,
          (r) => (r.accountCode && r.balanceDate ? `${r.accountCode}|${r.balanceDate}` : null)
        )
      : new Set();

  const results = parsedRows.map((row) => validate(row, context));
  const existingDuplicateFlags = module === "gl" ? await findExistingGLDuplicates(results.map((r) => r.resolved)) : [];

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
        column: "Account Code / Date",
        value: `${result.resolved.accountCode} / ${result.resolved.balanceDate}`,
        message: isExistingDuplicate
          ? "A beginning balance for this Account Code and Date already exists in the system."
          : "This Account Code and Date combination appears more than once in the uploaded file.",
      });
    } else if (warnings.length > 0) {
      status = "WARNING";
    }

    return {
      rowNumber: idx + 2, // +1 header row, +1 for 1-indexing
      status,
      errors,
      warnings,
      // Store the field-mapped object (accountCode/balanceDate/...), not
      // the raw positional cell array - commit re-validates by feeding
      // this back into validateGLRow, which reads named fields.
      raw: parsedRows[idx],
      resolved: result.resolved,
    };
  });
}

async function previewImport({ module, buffer, filename, duplicateMode, user }) {
  if (!REQUIRED_COLUMNS_BY_MODULE[module]) {
    throw Object.assign(new Error(`Unsupported module "${module}"`), { statusCode: 400 });
  }

  const { headers, dataRows } = await extractRows(buffer, filename);

  if (headers.length === 0) {
    throw Object.assign(new Error("The file appears to be empty"), { statusCode: 400 });
  }

  const aliases = module === "gl" ? GL_FIELD_ALIASES : null;
  const mapping = resolveColumnMapping(headers, aliases);

  const missingRequired = REQUIRED_COLUMNS_BY_MODULE[module].filter((f) => mapping[f] === undefined);
  if (missingRequired.length > 0) {
    throw Object.assign(
      new Error(`Missing required column(s) in the uploaded file: ${missingRequired.join(", ")}`),
      { statusCode: 400, headers }
    );
  }

  const scoredRows = await validateAndScoreRows(module, dataRows, mapping);

  const validRows = scoredRows.filter((r) => r.status === "VALID" || r.status === "WARNING");
  const balanceSummary =
    module === "gl" ? ValidationService.validateGLBatchBalance(validRows.map((r) => r.resolved)) : null;

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

async function commitImport({ module, batchId, user }) {
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
  // status, since master data (accounts) may have changed since preview.
  const context = module === "gl" ? await buildGLContext() : null;
  const validate = module === "gl" ? ValidationService.validateGLRow : null;

  const revalidated = storedRows.map((stored) => {
    // mysql2 auto-parses JSON columns into JS values already - no
    // JSON.parse needed (and calling it on a non-string throws).
    const raw = stored.raw_data;
    const result = validate(raw, context);
    return { rowNum: stored.row_num, errors: result.errors, warnings: result.warnings, resolved: result.resolved };
  });

  const insertable = revalidated.filter((r) => r.errors.length === 0);
  const rejected = revalidated.filter((r) => r.errors.length > 0);

  const existingDuplicateFlags =
    module === "gl" ? await findExistingGLDuplicates(insertable.map((r) => r.resolved)) : [];

  const toInsert = [];
  const skippedDuplicates = [];

  insertable.forEach((r, idx) => {
    if (existingDuplicateFlags[idx]) {
      if (batch.duplicate_mode === "SKIP_EXISTING") {
        skippedDuplicates.push(r);
      } else {
        rejected.push({ ...r, errors: [{ column: "Account Code / Date", value: "", message: "Duplicate of an existing record (Reject mode)." }] });
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

  if (module === "gl") {
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
  previewImport,
  commitImport,
};
