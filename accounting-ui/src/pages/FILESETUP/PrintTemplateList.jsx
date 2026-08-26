import { useEffect, useMemo, useState } from "react";
import usePermissions from "../../hooks/usePermissions";
import "./FileSetupPages.css";
import "./PrintTemplateList.css";

const API_BASE = import.meta.env.VITE_API_URL || "";
const MODULE_KEY = "PRINT.DOCUMENT_TEMPLATES";

// Phase 3A scope only - every field here maps 1:1 to a Phase 2 config field
// that documentPdfBuilder.js actually reads today (see printTemplateService.js's
// CONFIG_SCHEMA). Section reordering, style presets, and column configuration
// are validated by the backend already but not rendered yet - deliberately
// left out of this checkpoint (Phase 3C/3D), not omitted by oversight.
const MODULE_META = {
  invoice: {
    title: "Invoice Templates",
    singularNoun: "Invoice",
    subtitle: "Configure how Invoice documents are printed. Accounting values are never editable here - only presentation.",
    variants: [
      { value: "sales_invoice", label: "Sales Invoice" },
      { value: "service_invoice", label: "Service Invoice" },
      { value: "commercial_invoice", label: "Commercial Invoice" },
      { value: "cash_invoice", label: "Cash Invoice" },
    ],
    defaultPartyLabel: "Bill To",
  },
  or: {
    title: "OR Templates",
    singularNoun: "Official Receipt",
    subtitle: "Configure how Official Receipt documents are printed. Accounting values are never editable here - only presentation.",
    variants: [
      { value: "official_receipt", label: "Official Receipt" },
      { value: "collection_receipt", label: "Collection Receipt" },
      { value: "acknowledgement_receipt", label: "Acknowledgement Receipt" },
    ],
    defaultPartyLabel: "Received From",
  },
};

// Matches printTemplateService.js's assertTemplateCode exactly, so the
// client rejects an invalid code before ever reaching the server - the
// backend remains the authoritative check either way.
const TEMPLATE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,58}[a-z0-9]$/;

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function emptyMainForm(moduleType) {
  return {
    templateName: "",
    templateCode: "",
    documentVariant: MODULE_META[moduleType].variants[0].value,
  };
}

function emptyConfigForm(moduleType) {
  return {
    documentTitle: "",
    subtitle: "",
    showCompanyName: true,
    showCompanyAddress: true,
    showTin: true,
    showCopyBadge: true,
    partySectionLabel: MODULE_META[moduleType].defaultPartyLabel,
    showPartyName: true,
    showPartyAddress: true,
    showPartyTin: true,
    showTransactionNumber: true,
    showDate: true,
    showCurrency: true,
    showExchangeRate: true,
    showReferenceNumber: true,
    showPaymentMethod: true,
    showPaymentAccount: true,
    showEwt: true,
    showTotal: true,
    showAmountInWords: true,
    showSystemGeneratedNotice: true,
    showComplianceFooter: true,
    showPageFooter: true,
  };
}

// Reverse of buildConfigPayload() below - loads an existing template's
// stored (already-merged-with-built-in-defaults) config back into the flat
// form shape the modal edits. Every field falls back to `true`/the module
// default only as a defensive fallback for a field the stored config
// somehow omitted - the backend always returns a fully-populated config,
// so in practice these fallbacks are never exercised against real data.
function configToForm(config, moduleType) {
  const d = emptyConfigForm(moduleType);
  if (!config) return d;
  return {
    documentTitle: config.header?.documentTitle || "",
    subtitle: config.header?.subtitle || "",
    showCompanyName: config.header?.showCompanyName ?? d.showCompanyName,
    showCompanyAddress: config.header?.showCompanyAddress ?? d.showCompanyAddress,
    showTin: config.header?.showTin ?? d.showTin,
    showCopyBadge: config.header?.showCopyBadge ?? d.showCopyBadge,
    partySectionLabel: config.party?.sectionLabel || d.partySectionLabel,
    showPartyName: config.party?.showName ?? d.showPartyName,
    showPartyAddress: config.party?.showAddress ?? d.showPartyAddress,
    showPartyTin: config.party?.showTin ?? d.showPartyTin,
    showTransactionNumber: config.meta?.showTransactionNumber ?? d.showTransactionNumber,
    showDate: config.meta?.showDate ?? d.showDate,
    showCurrency: config.meta?.showCurrency ?? d.showCurrency,
    showExchangeRate: config.meta?.showExchangeRate ?? d.showExchangeRate,
    showReferenceNumber: config.meta?.showReferenceNumber ?? d.showReferenceNumber,
    showPaymentMethod: config.meta?.showPaymentMethod ?? d.showPaymentMethod,
    showPaymentAccount: config.meta?.showPaymentAccount ?? d.showPaymentAccount,
    showEwt: config.summary?.showEwt ?? d.showEwt,
    showTotal: config.summary?.showTotal ?? d.showTotal,
    showAmountInWords: config.summary?.showAmountInWords ?? d.showAmountInWords,
    showSystemGeneratedNotice: config.summary?.showSystemGeneratedNotice ?? d.showSystemGeneratedNotice,
    showComplianceFooter: config.summary?.showComplianceFooter ?? d.showComplianceFooter,
    showPageFooter: config.summary?.showPageFooter ?? d.showPageFooter,
  };
}

// Builds ONLY the config sections/fields Phase 3A actually exposes -
// `table`, `layout`, and `showAppliedInvoices` are never included here, so
// the backend's own merge-onto-built-in-default logic fills those in
// unchanged. This is what keeps "no unsupported config keys sent" true by
// construction, not by a client-side filter that could drift from the
// fields actually rendered above.
function buildConfigPayload(form, moduleType) {
  const isOr = moduleType === "or";
  return {
    header: {
      documentTitle: form.documentTitle.trim() || null,
      subtitle: form.subtitle.trim() || null,
      showCompanyName: form.showCompanyName,
      showCompanyAddress: form.showCompanyAddress,
      showTin: form.showTin,
      showCopyBadge: form.showCopyBadge,
    },
    party: {
      sectionLabel: form.partySectionLabel.trim(),
      showName: form.showPartyName,
      showAddress: form.showPartyAddress,
      showTin: form.showPartyTin,
    },
    meta: {
      showTransactionNumber: form.showTransactionNumber,
      showDate: form.showDate,
      showCurrency: form.showCurrency,
      showExchangeRate: form.showExchangeRate,
      showReferenceNumber: form.showReferenceNumber,
      ...(isOr ? { showPaymentMethod: form.showPaymentMethod, showPaymentAccount: form.showPaymentAccount } : {}),
    },
    summary: {
      showEwt: form.showEwt,
      showTotal: form.showTotal,
      ...(isOr ? { showAmountInWords: form.showAmountInWords } : {}),
      showSystemGeneratedNotice: form.showSystemGeneratedNotice,
      showComplianceFooter: form.showComplianceFooter,
      showPageFooter: form.showPageFooter,
    },
  };
}

function formatDateTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

export default function PrintTemplateList({ moduleType }) {
  const meta = MODULE_META[moduleType];
  const { can, loading: permsLoading } = usePermissions();

  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [banner, setBanner] = useState(null);

  const [showFormModal, setShowFormModal] = useState(false);
  const [formMode, setFormMode] = useState("add"); // "add" | "edit" | "view"
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [originalVariant, setOriginalVariant] = useState(null);
  const [form, setForm] = useState(emptyMainForm(moduleType));
  const [configForm, setConfigForm] = useState(emptyConfigForm(moduleType));
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [confirmAction, setConfirmAction] = useState(null); // { type: "set-default" | "deactivate", template }
  const [confirmBusy, setConfirmBusy] = useState(false);

  const canView = permsLoading || can(MODULE_KEY, "VIEW");
  const canCreate = can(MODULE_KEY, "CREATE");
  const canEdit = can(MODULE_KEY, "EDIT");
  const canActivate = can(MODULE_KEY, "ACTIVATE");
  const canDeactivate = can(MODULE_KEY, "DEACTIVATE");
  const canSetDefault = can(MODULE_KEY, "SET_DEFAULT");

  useEffect(() => {
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleType]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 5000);
    return () => clearTimeout(t);
  }, [banner]);

  async function loadTemplates() {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`${API_BASE}/api/print-templates?moduleType=${moduleType}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.message || "Failed to load templates.");
        return;
      }
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD PRINT TEMPLATES ERROR:", err);
      setLoadError("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }

  const sortedTemplates = useMemo(
    () => [...templates].sort((a, b) => (b.isDefault - a.isDefault) || a.templateName.localeCompare(b.templateName)),
    [templates]
  );

  function openAdd() {
    setForm(emptyMainForm(moduleType));
    setConfigForm(emptyConfigForm(moduleType));
    setEditingTemplate(null);
    setOriginalVariant(null);
    setFormMode("add");
    setFormError("");
    setDirty(false);
    setShowFormModal(true);
  }

  function openEditOrView(template) {
    setForm({
      templateName: template.templateName,
      templateCode: template.templateCode,
      documentVariant: template.documentVariant,
    });
    setConfigForm(configToForm(template.config, moduleType));
    setEditingTemplate(template);
    setOriginalVariant(template.documentVariant);
    setFormMode(canEdit ? "edit" : "view");
    setFormError("");
    setDirty(false);
    setShowFormModal(true);
  }

  function requestCloseModal() {
    if (dirty && !window.confirm("Discard unsaved changes to this template?")) return;
    setShowFormModal(false);
  }

  function updateForm(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function updateConfig(key, value) {
    setConfigForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function validateForm() {
    if (!form.templateName.trim()) return "Template Name is required.";
    if (form.templateName.length > 150) return "Template Name must be at most 150 characters.";
    if (formMode === "add") {
      if (!form.templateCode.trim()) return "Template Code is required.";
      if (!TEMPLATE_CODE_PATTERN.test(form.templateCode.trim())) {
        return "Template Code must be 3-60 characters, lowercase letters/digits/underscore/hyphen only, and cannot start or end with a separator.";
      }
    }
    if (!meta.variants.some((v) => v.value === form.documentVariant)) return "Select a valid document variant.";
    if (!configForm.partySectionLabel.trim()) return "Party Section Label is required.";
    return null;
  }

  async function handleSave() {
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const config = buildConfigPayload(configForm, moduleType);
      let res;
      if (formMode === "add") {
        res = await fetch(`${API_BASE}/api/print-templates`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            moduleType,
            templateCode: form.templateCode.trim(),
            templateName: form.templateName.trim(),
            documentVariant: form.documentVariant,
            config,
          }),
        });
      } else {
        res = await fetch(`${API_BASE}/api/print-templates/${editingTemplate.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            templateName: form.templateName.trim(),
            documentVariant: form.documentVariant,
            config,
          }),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.message || "Failed to save template.");
        return;
      }
      setShowFormModal(false);
      setBanner({ type: "success", message: `"${data.templateName}" ${formMode === "add" ? "created" : "updated"} successfully.` });
      await loadTemplates();
    } catch (err) {
      console.error("SAVE PRINT TEMPLATE ERROR:", err);
      setFormError("Unable to connect to server.");
    } finally {
      setSaving(false);
    }
  }

  function requestSetDefault(template) {
    setConfirmAction({ type: "set-default", template });
  }

  function requestDeactivate(template) {
    setConfirmAction({ type: "deactivate", template });
  }

  async function handleActivate(template) {
    setConfirmBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/print-templates/${template.id}/activate`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", message: data.message || "Failed to activate template." });
        return;
      }
      setBanner({ type: "success", message: `"${template.templateName}" activated.` });
      await loadTemplates();
    } catch (err) {
      console.error("ACTIVATE PRINT TEMPLATE ERROR:", err);
      setBanner({ type: "error", message: "Unable to connect to server." });
    } finally {
      setConfirmBusy(false);
    }
  }

  async function performConfirmAction() {
    if (!confirmAction) return;
    const { type, template } = confirmAction;
    setConfirmBusy(true);
    try {
      const path = type === "set-default" ? "set-default" : "deactivate";
      const res = await fetch(`${API_BASE}/api/print-templates/${template.id}/${path}`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", message: data.message || `Failed to ${type === "set-default" ? "set default" : "deactivate"} template.` });
        return;
      }
      setBanner({
        type: "success",
        message: type === "set-default"
          ? `"${template.templateName}" is now the default ${meta.singularNoun} template.`
          : `"${template.templateName}" deactivated.`,
      });
      await loadTemplates();
    } catch (err) {
      console.error("PRINT TEMPLATE ACTION ERROR:", err);
      setBanner({ type: "error", message: "Unable to connect to server." });
    } finally {
      setConfirmBusy(false);
      setConfirmAction(null);
    }
  }

  if (!canView) {
    return (
      <div className="fs-page">
        <div className="fs-card">You do not have permission to view {meta.title}.</div>
      </div>
    );
  }

  const existingDefault = editingTemplate
    ? templates.find((t) => t.isDefault && t.id !== editingTemplate.id)
    : templates.find((t) => t.isDefault);

  const variantChanged = formMode === "edit" && originalVariant && form.documentVariant !== originalVariant;
  const readOnly = formMode === "view";

  return (
    <div className="fs-page">
      <div className="fs-header">
        <div>
          <h1>{meta.title}</h1>
          <p>{meta.subtitle}</p>
        </div>
        {canCreate && (
          <button className="fs-btn primary" onClick={openAdd}>
            + New Template
          </button>
        )}
      </div>

      {banner && <div className={`ptl-banner ptl-banner-${banner.type}`}>{banner.message}</div>}

      <div className="fs-card">
        <table className="fs-table">
          <thead>
            <tr>
              <th>Template Name</th>
              <th>Module</th>
              <th>Variant</th>
              <th>Default</th>
              <th>Active</th>
              <th>Updated At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="7" className="fs-empty">Loading templates…</td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan="7" className="fs-empty ptl-error-text">{loadError}</td>
              </tr>
            ) : sortedTemplates.length === 0 ? (
              <tr>
                <td colSpan="7" className="fs-empty">
                  No custom templates yet. Every {meta.singularNoun} prints using the built-in default layout
                  until you create one.
                  {canCreate ? ' Click "+ New Template" to get started.' : ""}
                </td>
              </tr>
            ) : (
              sortedTemplates.map((t) => (
                <tr key={t.id}>
                  <td>{t.templateName}</td>
                  <td>{moduleType === "or" ? "OR" : "Invoice"}</td>
                  <td>{meta.variants.find((v) => v.value === t.documentVariant)?.label || t.documentVariant}</td>
                  <td>{t.isDefault ? <span className="ptl-badge ptl-badge-default">DEFAULT</span> : "—"}</td>
                  <td>
                    <span className={`ptl-badge ${t.isActive ? "ptl-badge-active" : "ptl-badge-inactive"}`}>
                      {t.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>{formatDateTime(t.updatedAt)}</td>
                  <td className="ptl-actions-cell">
                    <button className="fs-btn ptl-btn-sm" onClick={() => openEditOrView(t)}>
                      {canEdit ? "Edit" : "View"}
                    </button>
                    {t.isActive && canSetDefault && !t.isDefault && (
                      <button className="fs-btn ptl-btn-sm" onClick={() => requestSetDefault(t)}>Set Default</button>
                    )}
                    {t.isActive && canDeactivate && (
                      <button className="fs-btn ptl-btn-sm" onClick={() => requestDeactivate(t)}>Deactivate</button>
                    )}
                    {!t.isActive && canActivate && (
                      <button className="fs-btn ptl-btn-sm" onClick={() => handleActivate(t)} disabled={confirmBusy}>Activate</button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showFormModal && (
        <div className="ptl-overlay" role="dialog" aria-modal="true">
          <div className="ptl-modal ptl-modal-wide">
            <div className="ptl-modal-header">
              <h2>
                {formMode === "add" ? `New ${meta.title.replace(" Templates", "")} Template`
                  : formMode === "view" ? `View "${form.templateName}"`
                  : `Edit "${form.templateName}"`}
              </h2>
              <button className="ptl-close" onClick={requestCloseModal} aria-label="Close">&times;</button>
            </div>

            <div className="ptl-modal-body">
              {formError && <div className="ptl-banner ptl-banner-error">{formError}</div>}
              {readOnly && (
                <div className="ptl-banner ptl-banner-info">
                  You have view-only access to print templates. Editing requires the EDIT permission.
                </div>
              )}

              <div className="fs-grid ptl-main-fields">
                <div className="fs-field">
                  <label>Template Name</label>
                  <input
                    value={form.templateName}
                    onChange={(e) => updateForm("templateName", e.target.value)}
                    placeholder="e.g. Standard Sales Invoice"
                    disabled={readOnly}
                  />
                </div>
                <div className="fs-field">
                  <label title="Cannot be changed after creation.">Template Code {formMode !== "add" && "(fixed)"}</label>
                  <input
                    value={form.templateCode}
                    onChange={(e) => updateForm("templateCode", e.target.value.toLowerCase())}
                    placeholder="e.g. standard-sales-invoice"
                    disabled={formMode !== "add"}
                  />
                </div>
                <div className="fs-field">
                  <label>Document Variant</label>
                  <select
                    value={form.documentVariant}
                    onChange={(e) => updateForm("documentVariant", e.target.value)}
                    disabled={readOnly}
                  >
                    {meta.variants.map((v) => (
                      <option key={v.value} value={v.value}>{v.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {variantChanged && (
                <div className="ptl-banner ptl-banner-info ptl-variant-warning">
                  Changing the document variant does not automatically change the layout configuration.
                </div>
              )}

              {existingDefault && formMode !== "view" && (
                <p className="ptl-hint">
                  Current default {meta.singularNoun} template: <strong>{existingDefault.templateName}</strong>.
                  Use "Set Default" from the template list to change it.
                </p>
              )}

              <ConfigSection title="Header">
                <div className="fs-field">
                  <label>Document Title</label>
                  <input
                    value={configForm.documentTitle}
                    onChange={(e) => updateConfig("documentTitle", e.target.value)}
                    placeholder={moduleType === "or" ? "OFFICIAL RECEIPT" : "INVOICE"}
                    disabled={readOnly}
                  />
                </div>
                <div className="fs-field">
                  <label>Subtitle</label>
                  <input
                    value={configForm.subtitle}
                    onChange={(e) => updateConfig("subtitle", e.target.value)}
                    placeholder="Optional"
                    disabled={readOnly}
                  />
                </div>
                <Toggle label="Show Company Name" checked={configForm.showCompanyName} onChange={(v) => updateConfig("showCompanyName", v)} disabled={readOnly} />
                <Toggle label="Show Company Address" checked={configForm.showCompanyAddress} onChange={(v) => updateConfig("showCompanyAddress", v)} disabled={readOnly} />
                <Toggle label="Show TIN" checked={configForm.showTin} onChange={(v) => updateConfig("showTin", v)} disabled={readOnly} />
                <Toggle label="Show Copy Badge" checked={configForm.showCopyBadge} onChange={(v) => updateConfig("showCopyBadge", v)} disabled={readOnly} />
              </ConfigSection>

              <ConfigSection title={moduleType === "or" ? "Received From" : "Party"}>
                <div className="fs-field">
                  <label>Section Label</label>
                  <input
                    value={configForm.partySectionLabel}
                    onChange={(e) => updateConfig("partySectionLabel", e.target.value)}
                    placeholder={meta.defaultPartyLabel}
                    disabled={readOnly}
                  />
                </div>
                <Toggle label="Show Name" checked={configForm.showPartyName} onChange={(v) => updateConfig("showPartyName", v)} disabled={readOnly} />
                <Toggle label="Show Address" checked={configForm.showPartyAddress} onChange={(v) => updateConfig("showPartyAddress", v)} disabled={readOnly} />
                <Toggle label="Show TIN" checked={configForm.showPartyTin} onChange={(v) => updateConfig("showPartyTin", v)} disabled={readOnly} />
              </ConfigSection>

              <ConfigSection title={moduleType === "or" ? "Payment Metadata" : "Transaction Details"}>
                <Toggle label="Show Transaction Number" checked={configForm.showTransactionNumber} onChange={(v) => updateConfig("showTransactionNumber", v)} disabled={readOnly} />
                <Toggle label="Show Date" checked={configForm.showDate} onChange={(v) => updateConfig("showDate", v)} disabled={readOnly} />
                <Toggle label="Show Currency" checked={configForm.showCurrency} onChange={(v) => updateConfig("showCurrency", v)} disabled={readOnly} />
                <Toggle label="Show Exchange Rate" checked={configForm.showExchangeRate} onChange={(v) => updateConfig("showExchangeRate", v)} disabled={readOnly} />
                <Toggle label="Show Reference Number" checked={configForm.showReferenceNumber} onChange={(v) => updateConfig("showReferenceNumber", v)} disabled={readOnly} />
                {moduleType === "or" && (
                  <>
                    <Toggle label="Show Payment Method" checked={configForm.showPaymentMethod} onChange={(v) => updateConfig("showPaymentMethod", v)} disabled={readOnly} />
                    <Toggle label="Show Payment Account" checked={configForm.showPaymentAccount} onChange={(v) => updateConfig("showPaymentAccount", v)} disabled={readOnly} />
                  </>
                )}
              </ConfigSection>

              <ConfigSection title="Summary">
                <Toggle label="Show EWT" checked={configForm.showEwt} onChange={(v) => updateConfig("showEwt", v)} disabled={readOnly} />
                <Toggle label="Show Total" checked={configForm.showTotal} onChange={(v) => updateConfig("showTotal", v)} disabled={readOnly} />
                {moduleType === "or" && (
                  <Toggle label="Show Amount in Words" checked={configForm.showAmountInWords} onChange={(v) => updateConfig("showAmountInWords", v)} disabled={readOnly} />
                )}
              </ConfigSection>

              <ConfigSection title="Footer">
                <Toggle label="Show System-Generated Notice" checked={configForm.showSystemGeneratedNotice} onChange={(v) => updateConfig("showSystemGeneratedNotice", v)} disabled={readOnly} />
                <Toggle label="Show Compliance Footer" checked={configForm.showComplianceFooter} onChange={(v) => updateConfig("showComplianceFooter", v)} disabled={readOnly} />
                <Toggle label="Show Page Footer" checked={configForm.showPageFooter} onChange={(v) => updateConfig("showPageFooter", v)} disabled={readOnly} />
              </ConfigSection>

              <ConfigSection title="Not Yet Available" muted>
                <p className="ptl-future-hint">
                  Logo, status badge, payment terms, itemized quantity/unit price/discount, VAT-rate breakdown, and
                  BIR compliance fields (ATP/PTU/Permit/Approved Serial Nos.) are not supported by this system yet -
                  they are not shown as editable controls to avoid saving values that would never actually print.
                </p>
              </ConfigSection>
            </div>

            <div className="ptl-modal-footer">
              <button className="ptl-btn-secondary" onClick={requestCloseModal} disabled={saving}>
                {readOnly ? "Close" : "Cancel"}
              </button>
              {!readOnly && (
                <button className="ptl-btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : formMode === "add" ? "Save Template" : "Update Template"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <div className="ptl-overlay" role="dialog" aria-modal="true">
          <div className="ptl-modal ptl-modal-narrow">
            <div className="ptl-modal-header">
              <h2>{confirmAction.type === "set-default" ? "Set Default Template" : "Deactivate Template"}</h2>
              <button className="ptl-close" onClick={() => setConfirmAction(null)} aria-label="Close">&times;</button>
            </div>
            <div className="ptl-modal-body">
              {confirmAction.type === "set-default" ? (
                <p>
                  Set <strong>{confirmAction.template.templateName}</strong> as the default {meta.singularNoun} template?
                  {existingDefault && existingDefault.id !== confirmAction.template.id && (
                    <> This will replace <strong>{existingDefault.templateName}</strong> as the current default.</>
                  )}
                </p>
              ) : (
                <p>
                  Deactivate <strong>{confirmAction.template.templateName}</strong>?
                  {confirmAction.template.isDefault && (
                    <> This template is currently the default - deactivating it will clear its default status, and
                    printing will fall back to the built-in layout until you set a new default.</>
                  )}
                </p>
              )}
            </div>
            <div className="ptl-modal-footer">
              <button className="ptl-btn-secondary" onClick={() => setConfirmAction(null)} disabled={confirmBusy}>Cancel</button>
              <button className="ptl-btn-primary" onClick={performConfirmAction} disabled={confirmBusy}>
                {confirmBusy ? "Working…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigSection({ title, children, muted }) {
  return (
    <div className={`ptl-section${muted ? " ptl-section-muted" : ""}`}>
      <h3 className="ptl-section-title">{title}</h3>
      <div className="ptl-section-body">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled }) {
  return (
    <label className="ptl-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>{label}</span>
    </label>
  );
}
