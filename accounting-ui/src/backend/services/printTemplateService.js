const pool = require("../db");
const { HttpError } = require("../lib/httpError");

// Phase 2 (Document Print Template Infrastructure). Presentation-only
// configuration storage/resolution for the Invoice/OR print pipeline -
// see documentPdfBuilder.js for where the resolved config actually
// affects rendering. Nothing in this file ever touches an accounting
// value; it only ever reads/writes document_print_templates.config_json,
// which is validated against CONFIG_SCHEMA below before it's ever stored.

const SUPPORTED_MODULE_TYPES = ["invoice", "or"];

const SUPPORTED_VARIANTS = {
  invoice: ["sales_invoice", "service_invoice", "commercial_invoice", "cash_invoice"],
  or: ["official_receipt", "collection_receipt", "acknowledgement_receipt"],
};

// Main line-items table - both modules only ever have these two fields
// available today (transactionPrintDataService.mapLines' "without
// entries" shape is exactly { particulars, amount }) - Phase 2 does not
// invent new per-line data, only lets a template choose which of the
// EXISTING fields to show, under what label, and in what order.
const MAIN_TABLE_COLUMN_WHITELIST = {
  invoice: ["description", "amount"],
  or: ["description", "amount"],
};

// Applied-Invoice breakdown table (OR settlement, built in Phase 1) -
// same five fields getAppliedInvoices() already returns, no new data.
const APPLIED_INVOICE_COLUMN_WHITELIST = ["invoiceNo", "invoiceDate", "description", "invoiceAmount", "amountPaid"];

const SPACING_PRESETS = ["compact", "normal", "relaxed"];
const ALIGNMENT_PRESETS = ["left", "center"];
// Stored and validated now for forward-compatibility with the Phase 3
// Builder, which is where actual section reordering/spacing has real
// visual value - documentPdfBuilder.js does NOT act on these two layout
// fields in this checkpoint (see that file's own comment). This is a
// disclosed scope boundary, not an oversight - see the Phase 2 final
// report's "risks/open design questions" section.
const SECTION_ORDER_WHITELIST = ["header", "meta", "party", "appliedInvoices", "table", "summary"];

function builtInDefaultConfig(moduleType) {
  const isOr = moduleType === "or";
  return {
    header: {
      documentTitle: null,
      subtitle: null,
      showCompanyName: true,
      showCompanyAddress: true,
      showTin: true,
      // No logo/status-badge visual exists in the renderer at all today
      // (Phase 1's own audit confirmed no logo field anywhere in the
      // schema) - stored for forward-compatibility, not yet drawn. Same
      // "don't invent what isn't there" discipline as the BIR compliance
      // footer's empty fields.
      showLogoPlaceholder: false,
      showCopyBadge: true,
      showStatusBadge: false,
    },
    party: {
      sectionLabel: isOr ? "Received From" : "Bill To",
      showName: true,
      showAddress: true,
      showTin: true,
    },
    meta: {
      showTransactionNumber: true,
      showDate: true,
      showCurrency: true,
      showExchangeRate: true,
      showTerms: false,
      showPaymentMethod: isOr,
      showPaymentAccount: isOr,
      showReferenceNumber: true,
    },
    table: {
      columns: [
        { key: "description", label: "Description" },
        { key: "amount", label: "Amount" },
      ],
      appliedInvoiceColumns: isOr
        ? [
            { key: "invoiceNo", label: "Invoice No." },
            { key: "invoiceDate", label: "Date" },
            { key: "description", label: "Description" },
            { key: "invoiceAmount", label: "Invoice Amount" },
            { key: "amountPaid", label: "Amount Paid" },
          ]
        : undefined,
    },
    summary: {
      showEwt: true,
      showTotal: true,
      showAmountInWords: isOr,
      showSystemGeneratedNotice: true,
      showComplianceFooter: true,
      showPageFooter: true,
      showAppliedInvoices: isOr,
    },
    layout: {
      spacingPreset: "normal",
      alignmentPreset: "left",
      sectionOrder: isOr
        ? ["header", "meta", "party", "appliedInvoices", "table", "summary"]
        : ["header", "meta", "party", "table", "summary"],
    },
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") throw new HttpError(400, `${path} must be true or false.`);
}

function assertNullableString(value, path, maxLength = 150) {
  if (value === null || value === undefined) return;
  if (typeof value !== "string") throw new HttpError(400, `${path} must be a string or null.`);
  if (value.length > maxLength) throw new HttpError(400, `${path} must be at most ${maxLength} characters.`);
}

function assertEnum(value, path, allowed) {
  if (!allowed.includes(value)) throw new HttpError(400, `${path} must be one of: ${allowed.join(", ")}.`);
}

function validateColumnArray(columns, path, whitelist) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new HttpError(400, `${path} must be a non-empty array of columns.`);
  }
  const seen = new Set();
  for (const col of columns) {
    if (!isPlainObject(col)) throw new HttpError(400, `Each entry in ${path} must be an object with key/label.`);
    const extraKeys = Object.keys(col).filter((k) => k !== "key" && k !== "label");
    if (extraKeys.length) throw new HttpError(400, `${path} entries only support "key" and "label" (got: ${extraKeys.join(", ")}).`);
    if (!whitelist.includes(col.key)) {
      throw new HttpError(400, `${path} column "${col.key}" is not supported. Allowed: ${whitelist.join(", ")}.`);
    }
    if (seen.has(col.key)) throw new HttpError(400, `${path} lists column "${col.key}" more than once.`);
    seen.add(col.key);
    if (typeof col.label !== "string" || !col.label.trim()) {
      throw new HttpError(400, `${path} column "${col.key}" requires a non-empty label.`);
    }
    if (col.label.length > 60) throw new HttpError(400, `${path} column "${col.key}" label must be at most 60 characters.`);
  }
  return columns.map((c) => ({ key: c.key, label: c.label.trim() }));
}

function validateSectionOrder(order, path) {
  if (!Array.isArray(order) || order.length === 0) {
    throw new HttpError(400, `${path} must be a non-empty array.`);
  }
  const seen = new Set();
  for (const key of order) {
    if (!SECTION_ORDER_WHITELIST.includes(key)) {
      throw new HttpError(400, `${path} contains an unsupported section "${key}". Allowed: ${SECTION_ORDER_WHITELIST.join(", ")}.`);
    }
    if (seen.has(key)) throw new HttpError(400, `${path} lists section "${key}" more than once.`);
    seen.add(key);
  }
  return order;
}

// Merges `input` onto `base` one whitelisted field at a time - anything
// NOT present in input is inherited from base (the module's built-in
// default), and anything present in input is both type/whitelist
// validated AND used verbatim. Unknown top-level or nested keys are
// rejected outright (never silently dropped, never silently accepted) -
// this is the "reject unapproved fields" requirement, not a passthrough.
function mergeAndValidateConfig(moduleType, input) {
  const base = builtInDefaultConfig(moduleType);
  if (input === undefined || input === null) return base;
  if (!isPlainObject(input)) throw new HttpError(400, "config must be an object.");

  const allowedTopKeys = ["header", "party", "meta", "table", "summary", "layout"];
  const extraTop = Object.keys(input).filter((k) => !allowedTopKeys.includes(k));
  if (extraTop.length) throw new HttpError(400, `Unsupported config section(s): ${extraTop.join(", ")}.`);

  const result = JSON.parse(JSON.stringify(base));

  if (input.header !== undefined) {
    if (!isPlainObject(input.header)) throw new HttpError(400, "config.header must be an object.");
    const allowed = ["documentTitle", "subtitle", "showCompanyName", "showCompanyAddress", "showTin", "showLogoPlaceholder", "showCopyBadge", "showStatusBadge"];
    const extra = Object.keys(input.header).filter((k) => !allowed.includes(k));
    if (extra.length) throw new HttpError(400, `Unsupported config.header field(s): ${extra.join(", ")}.`);
    if ("documentTitle" in input.header) { assertNullableString(input.header.documentTitle, "config.header.documentTitle", 80); result.header.documentTitle = input.header.documentTitle ?? null; }
    if ("subtitle" in input.header) { assertNullableString(input.header.subtitle, "config.header.subtitle", 120); result.header.subtitle = input.header.subtitle ?? null; }
    for (const f of ["showCompanyName", "showCompanyAddress", "showTin", "showLogoPlaceholder", "showCopyBadge", "showStatusBadge"]) {
      if (f in input.header) { assertBoolean(input.header[f], `config.header.${f}`); result.header[f] = input.header[f]; }
    }
  }

  if (input.party !== undefined) {
    if (!isPlainObject(input.party)) throw new HttpError(400, "config.party must be an object.");
    const allowed = ["sectionLabel", "showName", "showAddress", "showTin"];
    const extra = Object.keys(input.party).filter((k) => !allowed.includes(k));
    if (extra.length) throw new HttpError(400, `Unsupported config.party field(s): ${extra.join(", ")}.`);
    if ("sectionLabel" in input.party) {
      if (typeof input.party.sectionLabel !== "string" || !input.party.sectionLabel.trim()) {
        throw new HttpError(400, "config.party.sectionLabel must be a non-empty string.");
      }
      assertNullableString(input.party.sectionLabel, "config.party.sectionLabel", 40);
      result.party.sectionLabel = input.party.sectionLabel.trim();
    }
    for (const f of ["showName", "showAddress", "showTin"]) {
      if (f in input.party) { assertBoolean(input.party[f], `config.party.${f}`); result.party[f] = input.party[f]; }
    }
  }

  if (input.meta !== undefined) {
    if (!isPlainObject(input.meta)) throw new HttpError(400, "config.meta must be an object.");
    const allowed = ["showTransactionNumber", "showDate", "showCurrency", "showExchangeRate", "showTerms", "showPaymentMethod", "showPaymentAccount", "showReferenceNumber"];
    const extra = Object.keys(input.meta).filter((k) => !allowed.includes(k));
    if (extra.length) throw new HttpError(400, `Unsupported config.meta field(s): ${extra.join(", ")}.`);
    for (const f of allowed) {
      if (f in input.meta) { assertBoolean(input.meta[f], `config.meta.${f}`); result.meta[f] = input.meta[f]; }
    }
  }

  if (input.table !== undefined) {
    if (!isPlainObject(input.table)) throw new HttpError(400, "config.table must be an object.");
    const allowed = ["columns", "appliedInvoiceColumns"];
    const extra = Object.keys(input.table).filter((k) => !allowed.includes(k));
    if (extra.length) throw new HttpError(400, `Unsupported config.table field(s): ${extra.join(", ")}.`);
    if ("columns" in input.table) {
      result.table.columns = validateColumnArray(input.table.columns, "config.table.columns", MAIN_TABLE_COLUMN_WHITELIST[moduleType]);
    }
    if ("appliedInvoiceColumns" in input.table) {
      if (moduleType !== "or") {
        throw new HttpError(400, "config.table.appliedInvoiceColumns is only supported for the OR module.");
      }
      result.table.appliedInvoiceColumns = validateColumnArray(input.table.appliedInvoiceColumns, "config.table.appliedInvoiceColumns", APPLIED_INVOICE_COLUMN_WHITELIST);
    }
  }

  if (input.summary !== undefined) {
    if (!isPlainObject(input.summary)) throw new HttpError(400, "config.summary must be an object.");
    const allowed = ["showEwt", "showTotal", "showAmountInWords", "showSystemGeneratedNotice", "showComplianceFooter", "showPageFooter", "showAppliedInvoices"];
    const extra = Object.keys(input.summary).filter((k) => !allowed.includes(k));
    if (extra.length) throw new HttpError(400, `Unsupported config.summary field(s): ${extra.join(", ")}.`);
    if ("showAppliedInvoices" in input.summary && moduleType !== "or") {
      throw new HttpError(400, "config.summary.showAppliedInvoices is only supported for the OR module.");
    }
    for (const f of allowed) {
      if (f in input.summary) { assertBoolean(input.summary[f], `config.summary.${f}`); result.summary[f] = input.summary[f]; }
    }
  }

  if (input.layout !== undefined) {
    if (!isPlainObject(input.layout)) throw new HttpError(400, "config.layout must be an object.");
    const allowed = ["spacingPreset", "alignmentPreset", "sectionOrder"];
    const extra = Object.keys(input.layout).filter((k) => !allowed.includes(k));
    if (extra.length) throw new HttpError(400, `Unsupported config.layout field(s): ${extra.join(", ")}.`);
    if ("spacingPreset" in input.layout) { assertEnum(input.layout.spacingPreset, "config.layout.spacingPreset", SPACING_PRESETS); result.layout.spacingPreset = input.layout.spacingPreset; }
    if ("alignmentPreset" in input.layout) { assertEnum(input.layout.alignmentPreset, "config.layout.alignmentPreset", ALIGNMENT_PRESETS); result.layout.alignmentPreset = input.layout.alignmentPreset; }
    if ("sectionOrder" in input.layout) { result.layout.sectionOrder = validateSectionOrder(input.layout.sectionOrder, "config.layout.sectionOrder"); }
  }

  return result;
}

function assertSupportedModuleType(moduleType) {
  if (!SUPPORTED_MODULE_TYPES.includes(moduleType)) {
    throw new HttpError(400, `Unsupported print-template module type: ${moduleType}. Supported: ${SUPPORTED_MODULE_TYPES.join(", ")}.`);
  }
}

function assertSupportedVariant(moduleType, variant) {
  const allowed = SUPPORTED_VARIANTS[moduleType] || [];
  if (!allowed.includes(variant)) {
    throw new HttpError(400, `Unsupported document variant "${variant}" for module "${moduleType}". Allowed: ${allowed.join(", ")}.`);
  }
}

function assertTemplateCode(code) {
  if (typeof code !== "string" || !/^[a-z0-9][a-z0-9_-]{1,58}[a-z0-9]$/.test(code)) {
    throw new HttpError(400, "template_code must be 3-60 characters, lowercase letters/digits/underscore/hyphen only, and cannot start or end with a separator.");
  }
}

function parseConfigColumn(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return value || {};
}

function mapRow(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    moduleType: row.module_type,
    templateCode: row.template_code,
    templateName: row.template_name,
    documentVariant: row.document_variant,
    config: parseConfigColumn(row.config_json),
    isDefault: !!row.is_default,
    isActive: !!row.is_active,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listTemplates({ companyId, moduleType }) {
  const params = [companyId];
  let where = "WHERE company_id = ?";
  if (moduleType) {
    assertSupportedModuleType(moduleType);
    where += " AND module_type = ?";
    params.push(moduleType);
  }
  const [rows] = await pool.execute(
    `SELECT * FROM document_print_templates ${where} ORDER BY module_type ASC, template_name ASC`,
    params
  );
  return rows.map(mapRow);
}

async function getTemplateById(id, companyId) {
  const [rows] = await pool.execute(
    "SELECT * FROM document_print_templates WHERE id = ? AND company_id = ?",
    [id, companyId]
  );
  if (rows.length === 0) throw new HttpError(404, "Print template not found.");
  return mapRow(rows[0]);
}

async function createTemplate(input, userId, companyId) {
  const { moduleType, templateCode, templateName, documentVariant, config, isDefault } = input || {};
  assertSupportedModuleType(moduleType);
  assertSupportedVariant(moduleType, documentVariant);
  assertTemplateCode(templateCode);
  if (typeof templateName !== "string" || !templateName.trim()) {
    throw new HttpError(400, "template_name is required.");
  }
  if (templateName.length > 150) throw new HttpError(400, "template_name must be at most 150 characters.");
  const normalizedConfig = mergeAndValidateConfig(moduleType, config);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (isDefault) {
      await conn.execute(
        "UPDATE document_print_templates SET is_default = 0 WHERE company_id = ? AND module_type = ?",
        [companyId, moduleType]
      );
    }

    let insertId;
    try {
      const [result] = await conn.execute(
        `INSERT INTO document_print_templates
          (company_id, module_type, template_code, template_name, document_variant, config_json, is_default, is_active, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [companyId, moduleType, templateCode, templateName.trim(), documentVariant, JSON.stringify(normalizedConfig), isDefault ? 1 : 0, userId, userId]
      );
      insertId = result.insertId;
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        throw new HttpError(409, `A template with code "${templateCode}" already exists for this module.`);
      }
      throw err;
    }

    await conn.commit();
    return getTemplateById(insertId, companyId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function updateTemplate(id, input, userId, companyId) {
  const existing = await getTemplateById(id, companyId);
  const templateName = input.templateName !== undefined ? input.templateName : existing.templateName;
  const documentVariant = input.documentVariant !== undefined ? input.documentVariant : existing.documentVariant;
  const config = input.config !== undefined ? input.config : existing.config;

  assertSupportedVariant(existing.moduleType, documentVariant);
  if (typeof templateName !== "string" || !templateName.trim()) {
    throw new HttpError(400, "template_name is required.");
  }
  if (templateName.length > 150) throw new HttpError(400, "template_name must be at most 150 characters.");
  // Re-validated from the module's built-in default every time, not
  // merged onto the PRIOR stored config - avoids an unapproved field
  // that slipped in before this validator existed (or before a future
  // whitelist tightening) silently surviving an update indefinitely.
  const normalizedConfig = mergeAndValidateConfig(existing.moduleType, config);

  await pool.execute(
    `UPDATE document_print_templates
     SET template_name = ?, document_variant = ?, config_json = ?, updated_by = ?
     WHERE id = ? AND company_id = ?`,
    [templateName.trim(), documentVariant, JSON.stringify(normalizedConfig), userId, id, companyId]
  );

  return getTemplateById(id, companyId);
}

async function setDefault(id, companyId, userId) {
  const existing = await getTemplateById(id, companyId);
  if (!existing.isActive) {
    throw new HttpError(400, "An inactive template cannot be set as default. Activate it first.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      "UPDATE document_print_templates SET is_default = 0 WHERE company_id = ? AND module_type = ?",
      [companyId, existing.moduleType]
    );
    await conn.execute(
      "UPDATE document_print_templates SET is_default = 1, updated_by = ? WHERE id = ? AND company_id = ?",
      [userId, id, companyId]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getTemplateById(id, companyId);
}

async function setActive(id, isActive, companyId, userId) {
  await getTemplateById(id, companyId); // 404s if not found/cross-company

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Deactivating the current default clears is_default too - a
    // deactivated template must never remain "the" default (section 6's
    // "inactive template cannot become effective unexpectedly" applies
    // just as much to a template that WAS the default when it's turned
    // off, not only to one that starts inactive).
    if (!isActive) {
      await conn.execute(
        "UPDATE document_print_templates SET is_active = 0, is_default = 0, updated_by = ? WHERE id = ? AND company_id = ?",
        [userId, id, companyId]
      );
    } else {
      await conn.execute(
        "UPDATE document_print_templates SET is_active = 1, updated_by = ? WHERE id = ? AND company_id = ?",
        [userId, id, companyId]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getTemplateById(id, companyId);
}

// The print pipeline's single entry point (section 6/9). Resolution
// order, exactly as approved:
//   1. requestedTemplateId, if given AND it resolves to an ACTIVE
//      template belonging to this company+module (a stale/deactivated/
//      cross-company/cross-module id is never silently substituted -
//      it's rejected with a clear 400, so a caller finds out immediately
//      rather than printing the wrong layout unnoticed).
//   2. this company+module's current default template, if one exists
//      and is active.
//   3. the module's built-in config - always available, requires no DB
//      row, and is what documentPdfBuilder.js already draws today. This
//      is the "current production layout" fallback - existing
//      transactions keep printing exactly as before when no template was
//      ever created, with zero migration/backfill needed.
async function resolveEffectiveConfig({ companyId, moduleType, requestedTemplateId }) {
  assertSupportedModuleType(moduleType);

  if (requestedTemplateId) {
    const [rows] = await pool.execute(
      "SELECT * FROM document_print_templates WHERE id = ? AND company_id = ? AND module_type = ?",
      [requestedTemplateId, companyId, moduleType]
    );
    if (rows.length === 0) {
      throw new HttpError(400, "The requested print template was not found for this company/module.");
    }
    if (!rows[0].is_active) {
      throw new HttpError(400, "The requested print template is inactive and cannot be used.");
    }
    const tpl = mapRow(rows[0]);
    return { config: tpl.config, source: "requested", templateId: tpl.id, templateName: tpl.templateName };
  }

  const [defaultRows] = await pool.execute(
    "SELECT * FROM document_print_templates WHERE company_id = ? AND module_type = ? AND is_default = 1 AND is_active = 1 LIMIT 1",
    [companyId, moduleType]
  );
  if (defaultRows.length > 0) {
    const tpl = mapRow(defaultRows[0]);
    return { config: tpl.config, source: "company_default", templateId: tpl.id, templateName: tpl.templateName };
  }

  return { config: builtInDefaultConfig(moduleType), source: "built_in", templateId: null, templateName: null };
}

module.exports = {
  SUPPORTED_MODULE_TYPES,
  SUPPORTED_VARIANTS,
  MAIN_TABLE_COLUMN_WHITELIST,
  APPLIED_INVOICE_COLUMN_WHITELIST,
  builtInDefaultConfig,
  mergeAndValidateConfig,
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  setDefault,
  setActive,
  resolveEffectiveConfig,
};
