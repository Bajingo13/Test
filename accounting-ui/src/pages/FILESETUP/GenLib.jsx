import { useEffect, useMemo, useRef, useState } from "react";
import { generateNextCode } from "../../utils/genLibCode";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import usePermissions from "../../hooks/usePermissions";
import RecordViewModal from "../../components/RecordViewModal";
import AutoResizeTextarea from "../../components/AutoResizeTextarea";
import { DEFAULT_SORT, filterGenLibRecords, sortOptions, sortRecords, statusBadge, toolbarState } from "./fileSetupRecords.mjs";
import { postBulkDelete } from "../../utils/fileSetupBulkDelete";
import useAuthorizedBranches from "../../hooks/useAuthorizedBranches";
import { ownershipLabel, ownershipOptions, ownershipValue, branchIdPayload } from "./branchOwnership.mjs";
import "./GenLib.css";
import "../../components/RecurringTemplateModal.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

const PARTY_TYPES = [
  "CUSTOMER",
  "SUPPLIER",
  "EMPLOYEE",
  "AFFILIATE",
  "BRANCH",
  "OTHER",
];

const STATUS_OPTIONS = ["ACTIVE", "INACTIVE"];
const CATEGORY_OPTIONS = ["REGULAR", "VIP", "AFFILIATES", "WALK-IN", "OTHERS"];

const EMPTY_FORM = {
  id: null,
  code: "",
  type: "CUSTOMER",
  name: "",
  status: "ACTIVE",
  startDate: new Date().toISOString().slice(0, 10),
  address1: "",
  address2: "",
  address3: "",
  attention: "",
  position: "",
  telephone: "",
  fax: "",
  mobile: "",
  tin: "",
  email: "",
  atcCode: "",
  ewtCode: "",
  category: "REGULAR",
  branchCode: "",
  rdoCode: "",
  notes: "",
  isProspective: false,
  isClient: true,
  // Multi-Branch: null = Shared party (not the BIR "Branch Code" above).
  branchId: null,
};

export default function GenLib() {
  const { can } = usePermissions();
  const canCreate = can("FILESETUP.GENLIB", "CREATE");
  const canEditPerm = can("FILESETUP.GENLIB", "EDIT");
  const canDeletePerm = can("FILESETUP.GENLIB", "DELETE");
  // Multi-Branch Phase C-2A: Shared vs branch-only parties (server-enforced).
  const { branches } = useAuthorizedBranches();
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("main");
  const [showTable, setShowTable] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  // Display order (default Code ascending, natural). `records` is kept in this
  // order, so Previous / Next and the record opened first follow it.
  const [sortKey, setSortKey] = useState(DEFAULT_SORT);
  const importInputRef = useRef(null);

  // Import is preview -> confirm (same flow as COA / Group Codes): choosing a
  // file only calls the READ-ONLY preview endpoint. The File is held so
  // "Confirm Import" resubmits the SAME file; the server re-parses and
  // re-validates it before inserting (the preview is never trusted).
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importPreviewLoading, setImportPreviewLoading] = useState(false);
  const [importError, setImportError] = useState("");
  const [importConfirming, setImportConfirming] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const isEditing = mode === "add" || mode === "edit";

  useEffect(() => {
    loadRecords();
  }, []);

  useEffect(() => {
    setRecords((prev) => sortRecords(prev, sortKey, { titleField: "name" }));
  }, [sortKey]);

  // keepId: the record to stay on after a save (otherwise the first record in
  // display order).
  async function loadRecords(keepId = null) {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/genlib`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load General Libraries");
        return;
      }

      const ordered = sortRecords(data, sortKey, { titleField: "name" });
      setRecords(ordered);

      if (ordered.length > 0) {
        const first = ordered.find((r) => keepId !== null && Number(r.id) === Number(keepId)) || ordered[0];
        setSelectedId(first.id);
        setForm({ ...first });
      } else {
        setSelectedId(null);
        setForm({ ...EMPTY_FORM });
      }
    } catch (error) {
      console.error("LOAD GENLIB ERROR:", error);
      alert("Unable to connect to General Libraries server.");
    } finally {
      setLoading(false);
    }
  }

  // H7: search (code, name, type, email, mobile, telephone, TIN, category,
  // status) plus exact Party Type / Status filters - all client-side.
  const filteredRecords = useMemo(
    () => sortRecords(filterGenLibRecords(records, { search, type: typeFilter, status: statusFilter }), sortKey, { titleField: "name" }),
    [records, search, typeFilter, statusFilter, sortKey]
  );

  const currentIndex = records.findIndex((item) => item.id === selectedId);
  const toolbar = toolbarState({
    index: currentIndex,
    total: records.length,
    hasRecord: Boolean(form.id),
    isEditing,
    busy: importPreviewLoading || importConfirming,
  });
  const badge = statusBadge(form.status);

  function loadRecord(record) {
    setSelectedId(record.id);
    setForm({ ...record });
    setMode("view");
  }

  const selectedRecord = records.find((item) => item.id === selectedId) || null;

  function getRecordDetails(record) {
    return [
      { label: "Code", value: record.code },
      { label: "Name", value: record.name },
      { label: "Type", value: record.type },
      { label: "Branch", value: ownershipLabel(record, branches) },
      { label: "Status", value: record.status },
      { label: "Start Date", value: record.startDate },
      { label: "Category", value: record.category },
      { label: "Address Line 1", value: record.address1 },
      { label: "Address Line 2", value: record.address2 },
      { label: "Address Line 3", value: record.address3 },
      { label: "Attention", value: record.attention },
      { label: "Position", value: record.position },
      { label: "Telephone No.", value: record.telephone },
      { label: "Fax No.", value: record.fax },
      { label: "Mobile No.", value: record.mobile },
      { label: "Email", value: record.email },
      { label: "TIN", value: record.tin },
      { label: "ATC Code", value: record.atcCode },
      { label: "EWT Code", value: record.ewtCode },
      { label: "Branch Code", value: record.branchCode },
      { label: "RDO Code", value: record.rdoCode },
      { label: "Prospective Client", value: record.isProspective ? "Yes" : "No" },
      { label: "Client", value: record.isClient ? "Yes" : "No" },
      { label: "Notes", value: record.notes, wide: true },
    ];
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleAdd() {
    setMode("add");
    setSelectedId(null);
    setForm({
      ...EMPTY_FORM,
      code: generateNextCode(records),
    });
    setActiveTab("main");
  }

  function handleEdit() {
    if (!form.id) return;
    setMode("edit");
  }

  async function handleDelete() {
    if (!form.id) return;

    const ok = window.confirm(`Delete "${form.name}"?`);
    if (!ok) return;

    try {
      const res = await fetch(`${API_BASE}/api/genlib/${form.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to delete record");
        return;
      }

      alert(data.message || "Record deleted successfully");
      await loadRecords();
      setMode("view");
    } catch (error) {
      console.error("DELETE GENLIB ERROR:", error);
      alert("Unable to delete record.");
    }
  }

  async function handleSave() {
    if (!form.code.trim() || !form.name.trim()) {
      alert("Code and Name are required.");
      return;
    }

    try {
      const url =
        mode === "add"
          ? `${API_BASE}/api/genlib`
          : `${API_BASE}/api/genlib/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to save record");
        return;
      }

      alert(data.message || "Record saved successfully");
      await loadRecords(data.id || form.id || null);
      setMode("view");
    } catch (error) {
      console.error("SAVE GENLIB ERROR:", error);
      alert("Unable to save record.");
    }
  }

  function handleCancel() {
    if (selectedId) {
      const original = records.find((item) => item.id === selectedId);
      if (original) setForm({ ...original });
    } else {
      setForm({ ...EMPTY_FORM });
    }
    setMode("view");
  }

  function handlePrevious() {
    if (currentIndex > 0) {
      loadRecord(records[currentIndex - 1]);
    }
  }

  function handleNext() {
    if (currentIndex < records.length - 1) {
      loadRecord(records[currentIndex + 1]);
    }
  }

  async function downloadTemplate() {
    try {
      const res = await fetch(`${API_BASE}/api/genlib/template`, {
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
      link.download = "General_Libraries_Template.xlsx";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("DOWNLOAD GENLIB TEMPLATE ERROR:", error);
      alert("Unable to download template.");
    }
  }

  function triggerImport() {
    importInputRef.current?.click();
  }

  // Step 1: READ-ONLY preview - no database write happens here.
  async function handleImportFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFile(file);
    setImportPreview(null);
    setImportResult(null);
    setImportError("");
    setImportPreviewLoading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_BASE}/api/genlib/import/preview`, {
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
    } catch (error) {
      console.error("GENLIB IMPORT PREVIEW ERROR:", error);
      setImportError("Unable to read the file.");
    } finally {
      setImportPreviewLoading(false);
      e.target.value = "";
    }
  }

  // Step 2: only on the explicit "Confirm Import" click - resubmits the SAME
  // file to the real import endpoint (the server re-validates against the
  // current database and inserts in one transaction).
  async function handleConfirmImport() {
    if (!importFile) return;
    setImportConfirming(true);

    try {
      const formData = new FormData();
      formData.append("file", importFile);

      const res = await fetch(`${API_BASE}/api/genlib/import`, {
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
      await loadRecords();
    } catch (error) {
      console.error("IMPORT GENLIB ERROR:", error);
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

  return (
    <div className="gl-page">
      <div className="gl-layout">
        <section className="gl-main">
          <div className="gl-header">
            <div>
              <p className="gl-mini-label">Astrea Blue</p>
              <h1>General Libraries</h1>
              <p className="gl-subtext">
                Maintain customers, suppliers, affiliates, branches, and other party records.
              </p>
            </div>

            <div className="gl-toolbar">
              {canCreate ? <button type="button" className="btn btn-primary" onClick={handleAdd}>Add</button> : null}
              {canEditPerm ? <button type="button" className="btn" onClick={handleEdit} disabled={!toolbar.canEdit}>Edit</button> : null}
              {canDeletePerm ? <button type="button" className="btn btn-danger" onClick={handleDelete} disabled={!toolbar.canDelete}>Delete</button> : null}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setMode("view");
                  setShowTable(true);
                }}
              >
                View
              </button>
              <button type="button" className="btn" onClick={() => window.print()}>Print</button>
              <button type="button" className="btn" onClick={handlePrevious} disabled={!toolbar.canPrevious}>Previous</button>
              <button type="button" className="btn" onClick={handleNext} disabled={!toolbar.canNext}>Next</button>
              <button type="button" className="btn" onClick={downloadTemplate}>
                Generate Template
              </button>
              {canCreate ? (
                <button type="button" className="btn" onClick={triggerImport} disabled={!toolbar.canImport}>
                  {importPreviewLoading ? "Reading file..." : "Import"}
                </button>
              ) : null}
              <input
                type="file"
                ref={importInputRef}
                accept=".csv,.xls,.xlsx"
                style={{ display: "none" }}
                onChange={handleImportFileChange}
              />
            </div>
          </div>

          {/* Selecting a record loads it into the page form through the normal
              selection path (so Edit / Delete / Previous / Next act on it) and
              closes the dialog, returning the user straight to that form. */}
          <RecordViewModal
            open={showTable}
            onClose={() => setShowTable(false)}
            title="View Records"
            subtitle="Select a record to open it."
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search code, name, TIN, phone, email..."
            filters={
              <>
                <label className="rvm-filter">
                  Sort
                  <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} aria-label="Sort records" data-testid="genlib-sort">
                    {sortOptions("Name").map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <label className="rvm-filter">
                  Type
                  <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by party type">
                    <option value="">All types</option>
                    {PARTY_TYPES.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label className="rvm-filter">
                  Status
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
                    <option value="">All statuses</option>
                    {STATUS_OPTIONS.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                {(typeFilter || statusFilter) && (
                  <button type="button" className="rvm-filter-clear" onClick={() => { setTypeFilter(""); setStatusFilter(""); }}>
                    Clear Filters
                  </button>
                )}
              </>
            }
            columns={[
              { key: "code", label: "Code" },
              { key: "name", label: "Name" },
              { key: "type", label: "Type" },
              { key: "branchName", label: "Branch" },
              {
                key: "status",
                label: "Status",
                render: (item) => {
                  const b = statusBadge(item.status);
                  return <span className={`gl-status-badge gl-status-badge--${b.tone}`}>{b.label}</span>;
                },
              },
              { key: "email", label: "Email" },
              { key: "mobile", label: "Mobile" },
            ]}
            records={filteredRecords.map((r) => ({ ...r, branchName: ownershipLabel(r, branches) }))}
            loading={loading}
            emptyMessage="No matching records."
            selectedId={selectedId}
            onSelect={(item) => {
              loadRecord(item);
              setShowTable(false);
            }}
            selectedRecord={selectedRecord}
            detailsTitle="Selected Record"
            getDetails={getRecordDetails}
            bulkDelete={canDeletePerm && !isEditing ? {
              noun: "record(s)",
              onDelete: async (ids) => {
                const out = await postBulkDelete("/api/genlib/bulk-delete", ids);
                if (!out.error) await loadRecords(selectedId);
                return out;
              },
            } : null}
          />

          <div className="gl-card">
            <div className="gl-top-grid">
              <div className="field">
                <label htmlFor="gl-code">
                  Code <span className="fs-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="gl-code"
                  aria-required="true"
                  value={form.code}
                  disabled={!isEditing}
                  onChange={(e) => updateField("code", e.target.value)}
                />
              </div>

              <div className="field field-wide">
                <div className="gl-label-row">
                  <label htmlFor="gl-name">
                    Name <span className="fs-required" aria-hidden="true">*</span>
                  </label>
                  {mode === "view" && form.id ? (
                    <span className={`gl-status-badge gl-status-badge--${badge.tone}`} data-testid="gl-status-badge">
                      {badge.label}
                    </span>
                  ) : null}
                </div>
                <AutoResizeTextarea
                  id="gl-name"
                  aria-required="true"
                  value={form.name}
                  disabled={!isEditing}
                  onChange={(e) => updateField("name", e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="gl-type">
                  Type <span className="fs-required" aria-hidden="true">*</span>
                </label>
                <select
                  id="gl-type"
                  aria-required="true"
                  value={form.type}
                  disabled={!isEditing}
                  onChange={(e) => updateField("type", e.target.value)}
                >
                  {PARTY_TYPES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="gl-owning-branch">Owning Branch</label>
                <select
                  id="gl-owning-branch"
                  value={ownershipValue(form)}
                  disabled={!isEditing}
                  onChange={(e) => updateField("branchId", branchIdPayload(e.target.value))}
                >
                  {ownershipOptions(branches).map((o) => (
                    <option key={o.value || "shared"} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="gl-tabs" role="tablist" aria-label="Record details">
              {[
                ["main", "Main Info"],
                ["additional", "Additional Info"],
                ["billing", "Billing / Tax"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  id={`gl-tab-${key}`}
                  role="tab"
                  aria-selected={activeTab === key}
                  aria-controls={`gl-panel-${key}`}
                  className={activeTab === key ? "gl-tab active" : "gl-tab"}
                  onClick={() => setActiveTab(key)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            {activeTab === "main" && (
              <div className="tab-panel" role="tabpanel" id="gl-panel-main" aria-labelledby="gl-tab-main">
                <div className="gl-grid">
                  <div className="field">
                    <label htmlFor="gl-status">Status</label>
                    <select
                      id="gl-status"
                      value={form.status}
                      disabled={!isEditing}
                      onChange={(e) => updateField("status", e.target.value)}
                    >
                      {STATUS_OPTIONS.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label htmlFor="gl-start-date">Start Date</label>
                    <input
                      id="gl-start-date"
                      type="date"
                      value={form.startDate || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("startDate", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label htmlFor="gl-address1">Address Line 1</label>
                    <AutoResizeTextarea
                      id="gl-address1"
                      value={form.address1 || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("address1", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label htmlFor="gl-address2">Address Line 2</label>
                    <AutoResizeTextarea
                      id="gl-address2"
                      value={form.address2 || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("address2", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label htmlFor="gl-address3">Address Line 3</label>
                    <AutoResizeTextarea
                      id="gl-address3"
                      value={form.address3 || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("address3", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-attention">Attention</label>
                    <input
                      id="gl-attention"
                      value={form.attention || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("attention", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-position">Position</label>
                    <input
                      id="gl-position"
                      value={form.position || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("position", e.target.value)}
                    />
                  </div>

                  <div className="field checkbox-field">
                    <label className="checkbox-wrap">
                      <input
                        type="checkbox"
                        checked={!!form.isProspective}
                        disabled={!isEditing}
                        onChange={(e) => updateField("isProspective", e.target.checked)}
                      />
                      <span>Prospective Client</span>
                    </label>
                  </div>

                  <div className="field checkbox-field">
                    <label className="checkbox-wrap">
                      <input
                        type="checkbox"
                        checked={!!form.isClient}
                        disabled={!isEditing}
                        onChange={(e) => updateField("isClient", e.target.checked)}
                      />
                      <span>Client</span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "additional" && (
              <div className="tab-panel" role="tabpanel" id="gl-panel-additional" aria-labelledby="gl-tab-additional">
                <div className="gl-grid">
                  <div className="field">
                    <label htmlFor="gl-telephone">Telephone No.</label>
                    <input
                      id="gl-telephone"
                      value={form.telephone || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("telephone", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-fax">Fax No.</label>
                    <input
                      id="gl-fax"
                      value={form.fax || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("fax", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-mobile">Mobile No.</label>
                    <input
                      id="gl-mobile"
                      value={form.mobile || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("mobile", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-email">Email</label>
                    <input
                      id="gl-email"
                      type="email"
                      value={form.email || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("email", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-category">Category</label>
                    <select
                      id="gl-category"
                      value={form.category}
                      disabled={!isEditing}
                      onChange={(e) => updateField("category", e.target.value)}
                    >
                      {CATEGORY_OPTIONS.map((item) => (
                        <option key={item}>{item}</option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label htmlFor="gl-branch-code">Branch Code</label>
                    <input
                      id="gl-branch-code"
                      value={form.branchCode || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("branchCode", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-rdo-code">RDO Code</label>
                    <input
                      id="gl-rdo-code"
                      value={form.rdoCode || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("rdoCode", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label htmlFor="gl-notes">Notes</label>
                    <textarea
                      id="gl-notes"
                      rows="5"
                      value={form.notes || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("notes", e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === "billing" && (
              <div className="tab-panel" role="tabpanel" id="gl-panel-billing" aria-labelledby="gl-tab-billing">
                <div className="gl-grid">
                  <div className="field">
                    <label htmlFor="gl-tin">TIN</label>
                    <input
                      id="gl-tin"
                      value={form.tin || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("tin", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-atc-code">ATC Code</label>
                    <input
                      id="gl-atc-code"
                      value={form.atcCode || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("atcCode", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="gl-ewt-code">EWT Code</label>
                    <input
                      id="gl-ewt-code"
                      value={form.ewtCode || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("ewtCode", e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {isEditing && (
              <div className="gl-actions">
                <button className="btn" type="button" onClick={handleCancel}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="button" onClick={handleSave}>
                  Save Record
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      {importFile && (
        <div className="rtm-overlay" onClick={(e) => e.target === e.currentTarget && closeImport()}>
          <div className="rtm-modal gl-import-modal" role="dialog" aria-modal="true" aria-labelledby="gl-import-title">
            <div className="rtm-header">
              <div>
                <h2 id="gl-import-title">Import General Libraries</h2>
                <p className="rtm-subtitle">{importFile.name}</p>
              </div>
              <button type="button" className="rtm-close" onClick={closeImport} disabled={importConfirming} aria-label="Close">
                &times;
              </button>
            </div>

            <div className="rtm-body">
              {importPreviewLoading && <div className="rtm-loading">Reading file...</div>}

              {!importPreviewLoading && importError && <div className="rtm-error-banner">{importError}</div>}

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
                  <p className="rtm-hint">Nothing has been saved yet. Review the rows below, then confirm to import.</p>

                  {/* Owning Branch column present: where each ready row will go. */}
                  {importPreview.ownership?.length > 0 && (
                    <p className="import-ownership-summary" data-testid="genlib-import-ownership">
                      Owning branch:{" "}
                      {importPreview.ownership.map((o, i) => (
                        <span key={o.owner}>{i > 0 ? ", " : ""}<strong>{o.owner}</strong> {o.count}</span>
                      ))}
                    </p>
                  )}

                  {importPreview.ready?.length > 0 && (
                    <div className="gl-import-section">
                      <h4>Ready to import ({importPreview.ready.length})</h4>
                      <ul className="gl-import-list" tabIndex={0} aria-label="Ready to import">
                        {importPreview.ready.map((r) => (
                          <li key={r.row}>
                            Row {r.row} | {r.code} | {r.name} ({r.type}, {r.status}){r.owningBranch ? ` → ${r.owningBranch}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <GenLibImportIssues skipped={importPreview.skipped} warnings={importPreview.warnings} />
                </>
              )}

              {importResult &&
                (importResult.success ? (
                  <>
                    <p className="gl-import-summary">
                      Imported: <strong>{importResult.imported}</strong> &nbsp;|&nbsp; Skipped:{" "}
                      <strong>{importResult.skipped?.length || 0}</strong> &nbsp;|&nbsp; Warnings:{" "}
                      <strong>{importResult.warnings?.length || 0}</strong>
                    </p>
                    <GenLibImportIssues skipped={importResult.skipped} warnings={importResult.warnings} />
                  </>
                ) : (
                  <>
                    <div className="rtm-error-banner">{importResult.message}</div>
                    <GenLibImportIssues skipped={importResult.skipped} warnings={importResult.warnings} />
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
                    disabled={importPreviewLoading || !!importError || !importPreview || importPreview.readyCount === 0 || importConfirming}
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

// Row-numbered skipped reasons ("Row X | Code | reason") + warnings, shared by
// the preview and the result. Each list scrolls inside the dialog.
function GenLibImportIssues({ skipped, warnings }) {
  return (
    <>
      {skipped?.length > 0 && (
        <div className="gl-import-section">
          <h4>Skipped rows ({skipped.length})</h4>
          <ul className="gl-import-list" tabIndex={0} aria-label="Skipped rows">
            {skipped.map((s, i) => (
              <li key={i}>
                Row {s.row} | {s.code || "-"} | {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings?.length > 0 && (
        <div className="gl-import-section">
          <h4>Warnings ({warnings.length})</h4>
          <ul className="gl-import-list" tabIndex={0} aria-label="Warnings">
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