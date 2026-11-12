import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import usePermissions from "../../hooks/usePermissions";
import AutoResizeTextarea from "../../components/AutoResizeTextarea";
import ReportSectionQuickAddModal from "../../components/ReportSectionQuickAddModal";
import RecordViewModal from "../../components/RecordViewModal";
import "./GroupCodes.css";
import "../../components/RecurringTemplateModal.css";

const API_BASE = import.meta.env.VITE_API_URL || "";
const MODULE_KEY = "FILESETUP.GROUP_CODES";

const ACCOUNT_CLASS_OPTIONS = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const STATUS_OPTIONS = ["ACTIVE", "INACTIVE"];

const EMPTY_FORM = {
  id: null,
  groupCode: "",
  groupDescription: "",
  accountClass: "ASSET",
  reportSection: "",
  displayOrder: "",
  status: "ACTIVE",
};

// API row -> form shape (Report Section "" = Unclassified, Display Order as a
// string so the number input stays controlled and "blank" round-trips).
function toForm(item) {
  return {
    ...EMPTY_FORM,
    ...item,
    reportSection: item.reportSection || "",
    displayOrder:
      item.displayOrder === null || item.displayOrder === undefined
        ? ""
        : String(item.displayOrder),
  };
}

export default function GroupCodes() {
  const { can, loading: permsLoading } = usePermissions();

  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // "view" | "add" | "edit"
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);

  // Phase M.1: Report Section options now come from the dynamic
  // report_sections master table (GET /api/report-sections) instead of the
  // old hard-coded groupCodeSections.mjs - loaded once on mount and
  // refreshed after a quick-add. `sections` holds ALL rows (any status) so
  // an existing Group Code referencing a since-deactivated section can
  // still show its proper name instead of the raw code; the dropdown
  // itself filters to ACTIVE + the selected Account Class.
  const [sections, setSections] = useState([]);
  const [showSectionModal, setShowSectionModal] = useState(false);
  const [showViewModal, setShowViewModal] = useState(false);

  // Generate Template + Import (same preview -> confirm flow as COA).
  // Choosing a file only calls the READ-ONLY preview endpoint; the File is
  // held so "Confirm Import" resubmits the SAME file, which the server
  // re-parses and re-validates before inserting (the preview is never trusted).
  const importInputRef = useRef(null);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importPreviewLoading, setImportPreviewLoading] = useState(false);
  const [importError, setImportError] = useState("");
  const [importConfirming, setImportConfirming] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const isEditing = mode === "add" || mode === "edit";

  // Backend authority is authorizePermission("FILESETUP.GROUP_CODES", ...);
  // the toolbar only REFLECTS it. VIEW gates the screen, CONFIGURE gates
  // every write. No new permissions are introduced.
  const canView = permsLoading || can(MODULE_KEY, "VIEW");
  const canConfigure = can(MODULE_KEY, "CONFIGURE");

  useEffect(() => {
    loadGroupCodes();
    loadReportSections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadReportSections() {
    try {
      const res = await fetch(`${API_BASE}/api/report-sections`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (res.ok) setSections(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("LOAD REPORT SECTIONS ERROR:", err);
    }
  }

  // [{code, name}] for a class, ACTIVE only - what the dropdown offers.
  function sectionsForClass(accountClass) {
    const cls = String(accountClass || "").trim().toUpperCase();
    return sections
      .filter((s) => s.accountClass === cls && s.status === "ACTIVE")
      .map((s) => ({ code: s.code, label: s.name }));
  }

  // Any status, so a since-deactivated section a Group Code still
  // references shows its real name rather than the bare code.
  function sectionLabel(code) {
    const found = sections.find((s) => s.code === code);
    return found ? found.name : code || "";
  }

  function isSectionValidForClass(accountClass, section) {
    if (!section) return true;
    return sectionsForClass(accountClass).some((s) => s.code === section);
  }

  function handleSectionCreated(created) {
    setShowSectionModal(false);
    loadReportSections();
    // The whole point of the "+" quick-add is that the newly created
    // section is immediately usable - select it right away rather than
    // leaving the user to reopen the dropdown and find it themselves.
    updateField("reportSection", created.code);
  }

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;

    return records.filter((item) =>
      [
        item.groupCode,
        item.groupDescription,
        item.accountClass,
        item.reportSection ? sectionLabel(item.reportSection) : "Unclassified",
        item.status,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [records, search]);

  // Previous / Next walk the CURRENTLY VISIBLE (filtered) list, in the same
  // deterministic order the API returns (display_order asc, NULLs last, then
  // group_code).
  const currentIndex = filteredRecords.findIndex((r) => r.id === selectedId);

  // If a narrowing search hides the selected record, drop the selection so a
  // later Edit / Delete can never act on a row the user can no longer see.
  useEffect(() => {
    if (isEditing) return;
    if (selectedId != null && !filteredRecords.some((r) => r.id === selectedId)) {
      setSelectedId(null);
      setForm({ ...EMPTY_FORM });
      setMode("view");
    }
  }, [filteredRecords, isEditing, selectedId]);

  async function loadGroupCodes(preferId) {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/group-codes`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load group codes.");
        return;
      }

      setRecords(data);

      const pick =
        (preferId != null && data.find((r) => r.id === preferId)) || data[0] || null;

      if (pick) {
        setSelectedId(pick.id);
        setForm(toForm(pick));
      } else {
        setSelectedId(null);
        setForm({ ...EMPTY_FORM });
      }
      setMode("view");
    } catch (err) {
      console.error("LOAD GROUP CODES ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }

  function updateField(key, value) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // Changing Account Class can invalidate the chosen Report Section -
      // reset it to Unclassified rather than keep an illegal combination or
      // silently guess a replacement.
      if (key === "accountClass" && !isSectionValidForClass(value, next.reportSection)) {
        next.reportSection = "";
      }
      return next;
    });
  }

  const unclassifiedCount = useMemo(
    () => records.filter((r) => r.status === "ACTIVE" && !r.reportSection).length,
    [records]
  );

  function confirmDiscardIfEditing() {
    if (!isEditing) return true;
    return window.confirm("Discard unsaved changes to this Group Code?");
  }

  function applySelection(item) {
    setSelectedId(item.id);
    setForm(toForm(item));
    setMode("view");
  }

  // Returns whether the record is now the selected one (false only when the
  // user cancels the discard-changes prompt) so the View dialog knows
  // whether to close.
  function selectRecord(item) {
    if (item.id === selectedId && !isEditing) return true;
    if (!confirmDiscardIfEditing()) return false;
    applySelection(item);
    return true;
  }

  function handleAdd() {
    if (!canConfigure) return;
    if (!confirmDiscardIfEditing()) return;
    setSelectedId(null);
    setForm({ ...EMPTY_FORM });
    setMode("add");
  }

  // Restores the selected record read-only (unchanged behavior), then opens
  // the shared View dialog. Picking a record there uses the same
  // selectRecord() as clicking a row in the list below, then closes the
  // dialog so the record shows in the form.
  function handleView() {
    if (selectedId) {
      const original = records.find((r) => r.id === selectedId);
      if (original) setForm(toForm(original));
    }
    setMode("view");
    setShowViewModal(true);
  }

  const selectedRecord = records.find((r) => r.id === selectedId) || null;

  function getGroupCodeDetails(item) {
    return [
      { label: "Group Code", value: item.groupCode },
      { label: "Description", value: item.groupDescription },
      { label: "Account Class", value: item.accountClass },
      {
        label: "Report Section",
        value: item.reportSection ? sectionLabel(item.reportSection) : "Unclassified",
      },
      { label: "Display Order", value: item.displayOrder ?? "" },
      { label: "Status", value: item.status },
    ];
  }

  function handleEdit() {
    if (!canConfigure) return;
    if (!form.id) {
      alert("Select a Group Code from the list first.");
      return;
    }
    setMode("edit");
  }

  function handleCancel() {
    if (selectedId) {
      const original = records.find((r) => r.id === selectedId);
      if (original) setForm(toForm(original));
    } else {
      setForm({ ...EMPTY_FORM });
    }
    setMode("view");
  }

  function handlePrevious() {
    if (!confirmDiscardIfEditing()) return;
    if (currentIndex > 0) applySelection(filteredRecords[currentIndex - 1]);
  }

  function handleNext() {
    if (!confirmDiscardIfEditing()) return;
    if (currentIndex >= 0 && currentIndex < filteredRecords.length - 1) {
      applySelection(filteredRecords[currentIndex + 1]);
    }
  }

  function handlePrint() {
    window.print();
  }

  async function handleDownloadTemplate() {
    if (!canConfigure) return;
    try {
      const res = await fetch(`${API_BASE}/api/group-codes/template`, {
        credentials: "include",
        headers: authHeaders(),
      });
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert("Failed to generate template.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "Group_Codes_Template.xlsx";
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("DOWNLOAD GROUP CODE TEMPLATE ERROR:", err);
      alert("Unable to download template.");
    }
  }

  function triggerImport() {
    if (!canConfigure || isEditing) return;
    importInputRef.current?.click();
  }

  // Step 1: READ-ONLY preview - no database write happens here.
  async function handleImportFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setImportFile(file);
    setImportPreview(null);
    setImportResult(null);
    setImportError("");
    setImportPreviewLoading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_BASE}/api/group-codes/import/preview`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setImportError(data.message || "Failed to read the file.");
        return;
      }
      setImportPreview(data);
    } catch (err) {
      console.error("GROUP CODE IMPORT PREVIEW ERROR:", err);
      setImportError("Unable to read the file.");
    } finally {
      setImportPreviewLoading(false);
    }
  }

  // Step 2: explicit confirmation - resubmits the SAME file to the real
  // import endpoint (server re-validates against the current database).
  async function handleConfirmImport() {
    if (!importFile || !canConfigure) return;
    setImportConfirming(true);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      const res = await fetch(`${API_BASE}/api/group-codes/import`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        setImportResult({ success: false, message: data.message || "Failed to import file.", skipped: data.skipped, warnings: data.warnings });
        return;
      }
      setImportResult({ success: true, imported: data.imported, skipped: data.skipped, warnings: data.warnings });
      await loadGroupCodes(selectedId);
    } catch (err) {
      console.error("GROUP CODE IMPORT ERROR:", err);
      setImportResult({ success: false, message: "Unable to import file." });
    } finally {
      setImportConfirming(false);
    }
  }

  function closeImport() {
    if (importConfirming) return;
    setImportFile(null);
    setImportPreview(null);
    setImportError("");
    setImportResult(null);
  }

  async function handleSave() {
    if (!canConfigure) return;
    if (!form.groupCode.trim() || !form.groupDescription.trim()) {
      alert("Group Code and Description are required.");
      return;
    }

    try {
      const url =
        mode === "add"
          ? `${API_BASE}/api/group-codes`
          : `${API_BASE}/api/group-codes/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify({
          groupCode: form.groupCode.trim(),
          groupDescription: form.groupDescription.trim(),
          accountClass: form.accountClass,
          status: form.status,
          reportSection: form.reportSection || null,
          displayOrder: form.displayOrder === "" ? null : Number(form.displayOrder),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to save group code.");
        return;
      }

      alert(data.message || "Group code saved successfully.");
      const savedId = mode === "add" ? data.id : form.id;
      await loadGroupCodes(savedId);
    } catch (err) {
      console.error("SAVE GROUP CODE ERROR:", err);
      alert("Unable to save group code.");
    }
  }

  async function handleDelete() {
    if (!canConfigure) return;
    if (!form.id) {
      alert("Select a Group Code from the list first.");
      return;
    }

    const confirmDelete = window.confirm(
      `Delete group code "${form.groupCode}"? This cannot be undone.`
    );
    if (!confirmDelete) return;

    try {
      const res = await fetch(`${API_BASE}/api/group-codes/${form.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to delete group code.");
        return;
      }

      alert(data.message || "Group code deleted successfully.");
      await loadGroupCodes();
    } catch (err) {
      console.error("DELETE GROUP CODE ERROR:", err);
      alert("Unable to delete group code.");
    }
  }

  const modeLabel =
    mode === "add"
      ? "Adding a new Group Code"
      : mode === "edit"
      ? "Editing Group Code"
      : selectedId
      ? "Viewing Group Code"
      : "No Group Code selected";

  if (!canView) {
    return (
      <div className="group-page">
        <div className="group-main">
          <div className="group-card">You do not have permission to view Group Codes.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="group-page">
      <div className="group-main">
        <div className="group-header">
          <div>
            <p className="group-mini">Astrea Blue</p>
            <h1>Group Codes</h1>
            <p className="group-subtext">
              Maintain account grouping and financial statement classification.
            </p>
          </div>

          <div className="group-toolbar no-print">
            <button
              type="button"
              className="group-btn group-btn--primary"
              onClick={handleAdd}
              disabled={!canConfigure}
            >
              Add
            </button>
            <button
              type="button"
              className="group-btn"
              onClick={handleEdit}
              disabled={!canConfigure || !form.id || isEditing}
            >
              Edit
            </button>
            <button
              type="button"
              className="group-btn group-btn--danger"
              onClick={handleDelete}
              disabled={!canConfigure || !form.id || isEditing}
            >
              Delete
            </button>
            <button
              type="button"
              className="group-btn"
              onClick={handleView}
              disabled={records.length === 0}
            >
              View
            </button>
            <button type="button" className="group-btn" onClick={handlePrint}>
              Print
            </button>
            <button
              type="button"
              className="group-btn"
              onClick={handlePrevious}
              disabled={isEditing || currentIndex <= 0}
            >
              Previous
            </button>
            <button
              type="button"
              className="group-btn"
              onClick={handleNext}
              disabled={
                isEditing ||
                currentIndex < 0 ||
                currentIndex >= filteredRecords.length - 1
              }
            >
              Next
            </button>
            {canConfigure && (
              <>
                <button
                  type="button"
                  className="group-btn"
                  onClick={handleDownloadTemplate}
                  disabled={isEditing}
                >
                  Generate Template
                </button>
                <button
                  type="button"
                  className="group-btn"
                  onClick={triggerImport}
                  disabled={isEditing || importPreviewLoading}
                >
                  {importPreviewLoading ? "Reading file..." : "Import"}
                </button>
                <input
                  type="file"
                  ref={importInputRef}
                  accept=".csv,.xlsx"
                  style={{ display: "none" }}
                  onChange={handleImportFileChange}
                  data-testid="group-import-input"
                />
              </>
            )}
          </div>
        </div>

        <RecordViewModal
          open={showViewModal}
          onClose={() => setShowViewModal(false)}
          title="View Group Codes"
          subtitle="Select a group code to open it."
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search group code..."
          columns={[
            { key: "groupCode", label: "Group Code" },
            { key: "groupDescription", label: "Description" },
            { key: "accountClass", label: "Class" },
            {
              key: "reportSection",
              label: "Report Section",
              render: (item) =>
                item.reportSection ? sectionLabel(item.reportSection) : "Unclassified",
            },
            { key: "status", label: "Status" },
          ]}
          records={filteredRecords}
          loading={loading}
          emptyMessage="No group codes found."
          selectedId={selectedId}
          onSelect={(item) => {
            if (selectRecord(item)) setShowViewModal(false);
          }}
          selectedRecord={selectedRecord}
          detailsTitle="Selected Group Code"
          getDetails={getGroupCodeDetails}
        />

        <div className="group-card">
          {unclassifiedCount > 0 && (
            <div className="group-warning" role="status">
              {unclassifiedCount} Group Code{unclassifiedCount === 1 ? "" : "s"} still need
              report classification. Their balances will appear under Unclassified on the
              Condensed / Detailed Balance Sheet and Income Statement until classification is
              completed.
            </div>
          )}

          <p className="group-mode-tag">{modeLabel}</p>

          <div className="group-form-grid">
            <div className="group-field">
              <label htmlFor="gc-code">Group Code</label>
              <input
                id="gc-code"
                value={form.groupCode}
                disabled={!isEditing}
                onChange={(e) => updateField("groupCode", e.target.value)}
                placeholder="Example: 1000"
              />
            </div>

            <div className="group-field group-field--wide">
              <label htmlFor="gc-desc">Group Description</label>
              <AutoResizeTextarea
                id="gc-desc"
                value={form.groupDescription}
                disabled={!isEditing}
                onChange={(e) => updateField("groupDescription", e.target.value)}
                placeholder="Example: Cash and Cash Equivalents"
              />
            </div>

            <div className="group-field">
              <label htmlFor="gc-class">Account Class</label>
              <select
                id="gc-class"
                value={form.accountClass}
                disabled={!isEditing}
                onChange={(e) => updateField("accountClass", e.target.value)}
              >
                {ACCOUNT_CLASS_OPTIONS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <p className="group-help">What type of account this group holds.</p>
            </div>

            <div className="group-field">
              <label htmlFor="gc-section">Report Section</label>
              <div className="group-section-row">
                <select
                  id="gc-section"
                  value={form.reportSection}
                  disabled={!isEditing}
                  onChange={(e) => updateField("reportSection", e.target.value)}
                >
                  <option value="">— Unclassified —</option>
                  {sectionsForClass(form.accountClass).map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {isEditing && (
                  <button
                    type="button"
                    className="group-section-add-btn"
                    onClick={() => setShowSectionModal(true)}
                    title="Add New Report Section"
                    aria-label="Add New Report Section"
                  >
                    +
                  </button>
                )}
              </div>
              <p className="group-help">
                Where this group appears in the Balance Sheet / Income Statement template. The
                choices follow the selected Account Class. Manage the full catalog under File
                Setup → Report Sections.
              </p>
            </div>

            <ReportSectionQuickAddModal
              open={showSectionModal}
              accountClass={form.accountClass}
              onClose={() => setShowSectionModal(false)}
              onCreated={handleSectionCreated}
            />

            <div className="group-field">
              <label htmlFor="gc-order">Display Order</label>
              <input
                id="gc-order"
                type="number"
                step="1"
                value={form.displayOrder}
                disabled={!isEditing}
                onChange={(e) => updateField("displayOrder", e.target.value)}
                placeholder="blank = auto"
              />
              <p className="group-help">
                Controls the order of Group Codes within the selected Report Section. Leave
                blank for automatic ordering.
              </p>
            </div>

            <div className="group-field">
              <label htmlFor="gc-status">Status</label>
              <select
                id="gc-status"
                value={form.status}
                disabled={!isEditing}
                onChange={(e) => updateField("status", e.target.value)}
              >
                {STATUS_OPTIONS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </div>
          </div>

          {isEditing && (
            <div className="group-actions no-print">
              <button type="button" className="group-btn" onClick={handleCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="group-btn group-btn--primary"
                onClick={handleSave}
              >
                {mode === "add" ? "Save Group Code" : "Update Group Code"}
              </button>
            </div>
          )}

          <div className="group-list-section">
            <div className="group-list-header">
              <h2>Group Code List</h2>
              <span className="group-count">{filteredRecords.length} item(s)</span>
              <input
                className="group-search no-print"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search group code..."
              />
            </div>

            <div className="group-table-wrap">
              <table className="group-table">
                <thead>
                  <tr>
                    <th>Group Code</th>
                    <th>Description</th>
                    <th>Class</th>
                    <th>Report Section</th>
                    <th>Order</th>
                    <th>Status</th>
                  </tr>
                </thead>

                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan="6" className="empty-cell">
                        Loading group codes...
                      </td>
                    </tr>
                  ) : filteredRecords.length > 0 ? (
                    filteredRecords.map((item) => (
                      <tr
                        key={item.id}
                        className={
                          selectedId === item.id ? "group-row selected-row" : "group-row"
                        }
                        onClick={() => selectRecord(item)}
                      >
                        <td>{item.groupCode}</td>
                        <td>{item.groupDescription}</td>
                        <td>{item.accountClass}</td>
                        <td>
                          {item.reportSection ? (
                            sectionLabel(item.reportSection)
                          ) : (
                            <span className="group-unclassified">Unclassified</span>
                          )}
                        </td>
                        <td>{item.displayOrder ?? ""}</td>
                        <td>{item.status}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="6" className="empty-cell">
                        No group codes found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {importFile && (
        <div
          className="rtm-overlay"
          onClick={(e) => e.target === e.currentTarget && closeImport()}
        >
          <div
            className="rtm-modal"
            style={{ width: "min(720px, 96vw)" }}
            role="dialog"
            aria-modal="true"
            aria-label="Import Group Codes"
          >
            <div className="rtm-header">
              <div>
                <h2>Import Group Codes</h2>
                <p className="rtm-subtitle">{importFile.name}</p>
              </div>
              <button type="button" className="rtm-close" onClick={closeImport} disabled={importConfirming}>
                &times;
              </button>
            </div>

            <div className="rtm-body">
              <div className="group-warning" role="note">
                Group Codes are global: imported Group Codes are shared by every company in the system.
                Existing Group Codes are never updated.
              </div>

              {importPreviewLoading && <div className="rtm-loading">Reading file...</div>}

              {!importPreviewLoading && importError && (
                <div className="rtm-error-banner">{importError}</div>
              )}

              {!importPreviewLoading && !importError && importPreview && !importResult && (
                <>
                  <p>
                    <strong>{importPreview.totalRows}</strong> row(s) detected &mdash;{" "}
                    <strong>{importPreview.readyCount}</strong> ready to import,{" "}
                    <strong>{importPreview.skipped?.length || 0}</strong> will be skipped
                    {importPreview.warnings?.length ? (
                      <>
                        , <strong>{importPreview.warnings.length}</strong> warning(s)
                      </>
                    ) : null}
                    .
                  </p>
                  <p className="rtm-hint">
                    Nothing has been saved yet. Review the rows below, then confirm to import.
                  </p>

                  {importPreview.ready?.length > 0 && (
                    <div className="group-import-section">
                      <h4>Ready to import ({importPreview.ready.length})</h4>
                      <ul className="group-import-list">
                        {importPreview.ready.map((r) => (
                          <li key={r.row}>
                            Row {r.row}: {r.groupCode} &mdash; {r.groupDescription} ({r.accountClass}
                            {r.reportSection ? `, ${r.reportSection}` : ""}, {r.status})
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <ImportIssueLists skipped={importPreview.skipped} warnings={importPreview.warnings} />
                </>
              )}

              {importResult &&
                (importResult.success ? (
                  <>
                    <p className="group-import-summary">
                      Imported: <strong>{importResult.imported}</strong> &nbsp;|&nbsp; Skipped:{" "}
                      <strong>{importResult.skipped?.length || 0}</strong> &nbsp;|&nbsp; Warnings:{" "}
                      <strong>{importResult.warnings?.length || 0}</strong>
                    </p>
                    <ImportIssueLists skipped={importResult.skipped} warnings={importResult.warnings} />
                  </>
                ) : (
                  <>
                    <div className="rtm-error-banner">{importResult.message}</div>
                    <ImportIssueLists skipped={importResult.skipped} warnings={importResult.warnings} />
                  </>
                ))}
            </div>

            <div className="rtm-footer">
              {!importResult ? (
                <>
                  <button type="button" className="rtm-btn-secondary" onClick={closeImport} disabled={importConfirming}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rtm-btn-primary"
                    onClick={handleConfirmImport}
                    disabled={
                      importPreviewLoading ||
                      !!importError ||
                      !importPreview ||
                      importPreview.readyCount === 0 ||
                      importConfirming
                    }
                  >
                    {importConfirming ? "Importing..." : "Confirm Import"}
                  </button>
                </>
              ) : (
                <button type="button" className="rtm-btn-primary" onClick={closeImport}>
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Row-numbered skipped reasons + warnings, shared by preview and result.
function ImportIssueLists({ skipped, warnings }) {
  return (
    <>
      {skipped?.length > 0 && (
        <div className="group-import-section">
          <h4>Skipped rows ({skipped.length})</h4>
          <ul className="group-import-list">
            {skipped.map((s, i) => (
              <li key={i}>
                Row {s.row}
                {s.groupCode ? ` | ${s.groupCode}` : ""} | {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings?.length > 0 && (
        <div className="group-import-section">
          <h4>Warnings ({warnings.length})</h4>
          <ul className="group-import-list">
            {warnings.map((w, i) => (
              <li key={i}>
                Row {w.row}: {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
