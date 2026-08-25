import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import "./COA.css";
import "../../components/RecurringTemplateModal.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

const CLASS_OPTIONS = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

const VALIDATION_OPTIONS = [
  "BANK / CASH",
  "OTHER ACCOUNTS",
  "PREPAYMENT",
  "ALLOCATION",
  "AR CODE",
  "EXPANDED TAX",
  "FIXED ASSET",
  "BEG. INVENTORY",
  "AP CODE",
  "FINAL TAX",
  "GAIN OR LOSS",
  "END INVENTORY",
  "INCOME",
  "INPUT VAT",
  "RESTATEMENT",
  "EXPENSE",
  "OUTPUT VAT",
];

const EMPTY_FORM = {
  id: null,
  code: "",
  date: new Date().toISOString().slice(0, 10),
  title: "",
  accountClass: "ASSET",
  description: "",
  validations: [],
  groups: [],
};

export default function COA() {
  const [accounts, setAccounts] = useState([]);
  const [groupCodeOptions, setGroupCodeOptions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [groupCode, setGroupCode] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const importInputRef = useRef(null);

  // Preview/confirm import flow: selecting a file only ever calls the
  // read-only /preview endpoint. The File object is held here so
  // "Confirm Import" can resubmit the SAME file to the real import
  // endpoint - nothing is written to the database until that explicit
  // confirmation.
  const [previewFile, setPreviewFile] = useState(null);
  const [previewResult, setPreviewResult] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [importResult, setImportResult] = useState(null);

  useEffect(() => {
    loadAccounts();
    loadGroupCodes();
  }, []);

  async function loadGroupCodes() {
    try {
      const res = await fetch(`${API_BASE}/api/group-codes`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load group codes");
        return;
      }

      setGroupCodeOptions(data);
    } catch (error) {
      console.error("LOAD GROUP CODES ERROR:", error);
    }
  }

  async function loadAccounts() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/coa`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load accounts");
        return;
      }

      setAccounts(data);

      if (data.length > 0) {
        setSelectedId(data[0].id);
        setForm({
          ...data[0],
          validations: data[0].validations || [],
          groups: data[0].groups || [],
        });
      } else {
        setSelectedId(null);
        setForm({ ...EMPTY_FORM });
      }
    } catch (error) {
      console.error("LOAD COA ERROR:", error);
      alert("Unable to connect to COA server.");
    } finally {
      setLoading(false);
    }
  }

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;

    return accounts.filter((account) =>
      [account.code, account.title, account.accountClass]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [accounts, search]);

  const currentIndex = accounts.findIndex((item) => item.id === selectedId);
  const isEditing = mode === "add" || mode === "edit";

  function loadAccount(account) {
    setSelectedId(account.id);
    setForm({
      ...account,
      validations: [...(account.validations || [])],
      groups: [...(account.groups || [])],
    });
    setMode("view");
  }

  function handleAdd() {
    setMode("add");
    setSelectedId(null);
    setForm({
      ...EMPTY_FORM,
      validations: [],
      groups: [],
    });
  }

  function handleEdit() {
    if (!form.id) return;
    setMode("edit");
  }

  async function handleDelete() {
    if (!form.id) return;

    const confirmDelete = window.confirm("Delete this account?");
    if (!confirmDelete) return;

    try {
      const res = await fetch(`${API_BASE}/api/coa/${form.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to delete account");
        return;
      }

      alert(data.message || "Account deleted successfully");
      await loadAccounts();
      setMode("view");
    } catch (error) {
      console.error("DELETE COA ERROR:", error);
      alert("Unable to delete account.");
    }
  }

  function handleView() {
    setMode("view");
    setShowPicker(true);
  }

  function pickAccount(account) {
    loadAccount(account);
    setShowPicker(false);
  }

  async function handleSave() {
    if (!form.code.trim() || !form.title.trim()) {
      alert("Code and Title are required.");
      return;
    }

    try {
      const payload = {
        code: form.code.trim(),
        date: form.date,
        title: form.title.trim(),
        accountClass: form.accountClass,
        description: form.description,
        validations: form.validations,
        groups: form.groups,
      };

      const url =
        mode === "add"
          ? `${API_BASE}/api/coa`
          : `${API_BASE}/api/coa/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to save account");
        return;
      }

      alert(data.message || "Account saved successfully");

      await loadAccounts();
      setMode("view");
    } catch (error) {
      console.error("SAVE COA ERROR:", error);
      alert("Unable to save account.");
    }
  }

  function handleCancel() {
    if (selectedId) {
      const original = accounts.find((item) => item.id === selectedId);
      if (original) {
        setForm({
          ...original,
          validations: [...(original.validations || [])],
          groups: [...(original.groups || [])],
        });
      }
    } else {
      setForm({ ...EMPTY_FORM, validations: [], groups: [] });
    }

    setMode("view");
  }

  function handlePrevious() {
    if (currentIndex > 0) {
      loadAccount(accounts[currentIndex - 1]);
    }
  }

  function handleNext() {
    if (currentIndex < accounts.length - 1) {
      loadAccount(accounts[currentIndex + 1]);
    }
  }

  function toggleValidation(value) {
    if (!isEditing) return;

    setForm((prev) => {
      const exists = prev.validations.includes(value);

      return {
        ...prev,
        validations: exists
          ? prev.validations.filter((item) => item !== value)
          : [...prev.validations, value],
      };
    });
  }

  function addGroupCode() {
    if (!isEditing) return;
    if (!groupCode) return;

    const selectedGroup = groupCodeOptions.find(
      (item) => item.groupCode === groupCode
    );

    if (!selectedGroup) return;

    const alreadyExists = form.groups.some(
      (item) => item.code === selectedGroup.groupCode
    );

    if (alreadyExists) {
      alert("This group code is already added.");
      return;
    }

    setForm((prev) => ({
      ...prev,
      groups: [
        ...prev.groups,
        {
          id: crypto.randomUUID(),
          code: selectedGroup.groupCode,
          description: selectedGroup.groupDescription,
        },
      ],
    }));

    setGroupCode("");
  }

  function removeGroupCode(id) {
    if (!isEditing) return;

    setForm((prev) => ({
      ...prev,
      groups: prev.groups.filter((item) => item.id !== id),
    }));
  }

  async function downloadTemplate() {
    try {
      const res = await fetch(`${API_BASE}/api/coa/template`, {
        credentials: "include",
        headers: authHeaders(),
      });

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert("Failed to generate template");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "Chart_of_Accounts_Template.xlsx";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("DOWNLOAD COA TEMPLATE ERROR:", error);
      alert("Unable to download template.");
    }
  }

  function triggerImport() {
    importInputRef.current?.click();
  }

  // Step 1: file selection only ever triggers a READ-ONLY preview - no
  // database write happens here. The chosen file is kept in state so the
  // exact same file can be resubmitted on explicit confirmation.
  async function handleImportFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setPreviewFile(file);
    setPreviewResult(null);
    setImportResult(null);
    setPreviewError("");
    setPreviewLoading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_BASE}/api/coa/import/preview`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setPreviewError(data.message || "Failed to read the file.");
        return;
      }

      setPreviewResult(data);
    } catch (error) {
      console.error("COA IMPORT PREVIEW ERROR:", error);
      setPreviewError("Unable to read the file.");
    } finally {
      setPreviewLoading(false);
      e.target.value = "";
    }
  }

  // Step 2: only fires on the user's explicit "Confirm Import" click.
  // Resubmits the SAME file to the real import endpoint, which re-parses
  // and re-validates it server-side (never trusts the earlier preview as
  // the source of truth for what gets written) and performs the actual
  // batch-transaction insert.
  async function handleConfirmImport() {
    if (!previewFile) return;
    setConfirming(true);

    try {
      const formData = new FormData();
      formData.append("file", previewFile);

      const res = await fetch(`${API_BASE}/api/coa/import`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setImportResult({ success: false, message: data.message || "Failed to import file", skipped: data.skipped, warnings: data.warnings });
        return;
      }

      setImportResult({ success: true, imported: data.imported, skipped: data.skipped, warnings: data.warnings });
      await loadAccounts();
    } catch (error) {
      console.error("IMPORT COA ERROR:", error);
      setImportResult({ success: false, message: "Unable to import file." });
    } finally {
      setConfirming(false);
    }
  }

  function closeImportPreview() {
    setPreviewFile(null);
    setPreviewResult(null);
    setPreviewError("");
    setImportResult(null);
  }

  return (
    <div className="coa-page">
      <div className="coa-layout">
        <section className="coa-main-panel">
          <div className="coa-header">
            <div>
              <p className="coa-mini-label">Astrea Blue</p>
              <h1>Chart of Accounts</h1>
              <p className="coa-subtext">
                Modern account maintenance module for your accounting system.
              </p>
            </div>

            <div className="coa-toolbar">
              <button className="btn btn-primary" onClick={handleAdd}>
                Add
              </button>
              <button className="btn" onClick={handleEdit}>
                Edit
              </button>
              <button className="btn btn-danger" onClick={handleDelete}>
                Delete
              </button>
              <button className="btn" onClick={handleView}>
                View
              </button>
              <button className="btn" onClick={() => window.print()}>
                Print
              </button>
              <button className="btn" onClick={handlePrevious}>
                Previous
              </button>
              <button className="btn" onClick={handleNext}>
                Next
              </button>
              <button className="btn" onClick={downloadTemplate}>
                Generate Template
              </button>
              <button className="btn" onClick={triggerImport} disabled={previewLoading}>
                {previewLoading ? "Reading file..." : "Import"}
              </button>
              <input
                type="file"
                ref={importInputRef}
                accept=".csv,.xlsx"
                style={{ display: "none" }}
                onChange={handleImportFileChange}
              />
            </div>
          </div>

          {showPicker && (
            <div className="coa-picker-panel">
              <div className="coa-picker-header">
                <div>
                  <h3>Accounts</h3>
                  <span>{filteredAccounts.length} item(s)</span>
                </div>
                <input
                  type="text"
                  placeholder="Search code or title"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="coa-picker-search"
                />
                <button
                  type="button"
                  className="coa-picker-close"
                  onClick={() => setShowPicker(false)}
                  aria-label="Close"
                >
                  &times;
                </button>
              </div>

              <div className="coa-picker-table-wrap">
                <table className="coa-picker-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Title</th>
                      <th>Class</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={3} className="empty-cell">Loading accounts...</td>
                      </tr>
                    ) : filteredAccounts.length > 0 ? (
                      filteredAccounts.map((account) => (
                        <tr
                          key={account.id}
                          className={selectedId === account.id ? "selected-row" : ""}
                          onClick={() => pickAccount(account)}
                        >
                          <td>{account.code}</td>
                          <td>{account.title}</td>
                          <td>{account.accountClass}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3} className="empty-cell">No accounts found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="coa-card">
            <div className="coa-grid">
              <div className="field">
                <label>Code</label>
                <input
                  value={form.code}
                  disabled={!isEditing}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, code: e.target.value }))
                  }
                />
              </div>

              <div className="field">
                <label>Date</label>
                <input
                  type="date"
                  value={form.date}
                  disabled={!isEditing}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, date: e.target.value }))
                  }
                />
              </div>

              <div className="field field-wide">
                <label>Title</label>
                <input
                  value={form.title}
                  disabled={!isEditing}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, title: e.target.value }))
                  }
                />
              </div>

              <div className="field">
                <label>Class</label>
                <select
                  value={form.accountClass}
                  disabled={!isEditing}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      accountClass: e.target.value,
                    }))
                  }
                >
                  {CLASS_OPTIONS.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="section-block">
              <div className="section-title-row">
                <h3>Validation Rules</h3>
                <span>{form.validations.length} selected</span>
              </div>

              <div className="validation-grid">
                {VALIDATION_OPTIONS.map((item) => {
                  const checked = form.validations.includes(item);

                  return (
                    <button
                      key={item}
                      type="button"
                      disabled={!isEditing}
                      className={
                        checked ? "validation-chip active" : "validation-chip"
                      }
                      onClick={() => toggleValidation(item)}
                    >
                      {item}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="section-block">
              <h3>Description</h3>
              <textarea
                rows="4"
                value={form.description}
                disabled={!isEditing}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                placeholder="Enter account description"
              />
            </div>

            <div className="section-block group-section">
              <div className="section-title-row">
                <div>
                  <h3>Group Codes</h3>
                  <p className="group-subtext">
                    Assign group codes from the database to the selected account.
                  </p>
                </div>
              </div>

              <div className="group-form">
                <select
                  value={groupCode}
                  disabled={!isEditing}
                  onChange={(e) => setGroupCode(e.target.value)}
                >
                  <option value="">Select Group Code</option>

                  {groupCodeOptions
                    .filter((item) => item.status === "ACTIVE")
                    .map((item) => (
                      <option key={item.id} value={item.groupCode}>
                        {item.groupCode} - {item.groupDescription}
                      </option>
                    ))}
                </select>

                <button
                  className="btn btn-dark"
                  type="button"
                  disabled={!isEditing || !groupCode}
                  onClick={addGroupCode}
                >
                  Insert Group Code
                </button>
              </div>

              <div className="table-wrap">
                <table className="coa-table">
                  <thead>
                    <tr>
                      <th>Group Code</th>
                      <th>Description</th>
                      <th>Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {form.groups.length > 0 ? (
                      form.groups.map((item) => (
                        <tr key={item.id}>
                          <td>{item.code}</td>
                          <td>{item.description}</td>
                          <td>
                            <button
                              className="btn btn-danger btn-small"
                              type="button"
                              disabled={!isEditing}
                              onClick={() => removeGroupCode(item.id)}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="3" className="empty-cell">
                          No group codes yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {isEditing && (
              <div className="coa-actions">
                <button className="btn" type="button" onClick={handleCancel}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={handleSave}
                >
                  Save Account
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      {previewFile && (
        <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && !confirming && closeImportPreview()}>
          <div className="rtm-modal" style={{ width: "min(680px, 96vw)" }} role="dialog" aria-modal="true" aria-label="Import Chart of Accounts">
            <div className="rtm-header">
              <div>
                <h2>Import Chart of Accounts</h2>
                <p className="rtm-subtitle">{previewFile.name}</p>
              </div>
              <button type="button" className="rtm-close" onClick={closeImportPreview} disabled={confirming}>&times;</button>
            </div>

            <div className="rtm-body">
              {previewLoading && (
                <div className="rtm-loading">Reading file...</div>
              )}

              {!previewLoading && previewError && (
                <div className="rtm-error-banner">{previewError}</div>
              )}

              {!previewLoading && !previewError && previewResult && !importResult && (
                <>
                  <p>
                    <strong>{previewResult.totalRows}</strong> row(s) detected &mdash;{" "}
                    <strong>{previewResult.readyCount}</strong> ready to import,{" "}
                    <strong>{previewResult.skipped?.length || 0}</strong> will be skipped.
                  </p>
                  <p className="rtm-hint">
                    No accounts have been created yet. Review the rows below, then confirm to import.
                  </p>

                  {previewResult.skipped?.length > 0 && (
                    <div className="coa-import-preview-section">
                      <h4>Skipped rows ({previewResult.skipped.length})</h4>
                      <ul className="coa-import-preview-list">
                        {previewResult.skipped.map((s, i) => (
                          <li key={i}>Row {s.row}: {s.reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {previewResult.warnings?.length > 0 && (
                    <div className="coa-import-preview-section">
                      <h4>Warnings ({previewResult.warnings.length})</h4>
                      <ul className="coa-import-preview-list">
                        {previewResult.warnings.map((w, i) => (
                          <li key={i}>Row {w.row}: {w.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {importResult && (
                importResult.success ? (
                  <div>
                    <p><strong>Imported {importResult.imported} account(s) successfully.</strong></p>
                    {importResult.skipped?.length > 0 && (
                      <div className="coa-import-preview-section">
                        <h4>Skipped rows ({importResult.skipped.length})</h4>
                        <ul className="coa-import-preview-list">
                          {importResult.skipped.map((s, i) => (
                            <li key={i}>Row {s.row}: {s.reason}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {importResult.warnings?.length > 0 && (
                      <div className="coa-import-preview-section">
                        <h4>Warnings ({importResult.warnings.length})</h4>
                        <ul className="coa-import-preview-list">
                          {importResult.warnings.map((w, i) => (
                            <li key={i}>Row {w.row}: {w.message}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rtm-error-banner">{importResult.message}</div>
                )
              )}
            </div>

            <div className="rtm-footer">
              {!importResult ? (
                <>
                  <button className="rtm-btn-secondary" onClick={closeImportPreview} disabled={confirming}>
                    Cancel
                  </button>
                  <button
                    className="rtm-btn-primary"
                    onClick={handleConfirmImport}
                    disabled={previewLoading || !!previewError || !previewResult || previewResult.readyCount === 0 || confirming}
                  >
                    {confirming ? "Importing..." : "Confirm Import"}
                  </button>
                </>
              ) : (
                <button className="rtm-btn-primary" onClick={closeImportPreview}>Close</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}