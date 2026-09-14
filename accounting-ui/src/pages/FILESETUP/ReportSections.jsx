import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import usePermissions from "../../hooks/usePermissions";
import "./GroupCodes.css";

// Phase M.1: Report Section master data. Reuses GroupCodes.css verbatim
// (group-* class names) - same List/Add/Edit/Delete/View/Search toolbar
// pattern as Group Code, on purpose: this page is the new authoritative
// source Group Code's own Report Section dropdown now loads dynamically
// from GET /api/report-sections, replacing the old hard-coded
// groupCodeSections.mjs-driven dropdown.

const API_BASE = import.meta.env.VITE_API_URL || "";
const MODULE_KEY = "FILESETUP.REPORT_SECTIONS";

const ACCOUNT_CLASS_OPTIONS = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const STATUS_OPTIONS = ["ACTIVE", "INACTIVE"];

const EMPTY_FORM = {
  id: null,
  code: "",
  name: "",
  accountClass: "ASSET",
  displayOrder: "",
  status: "ACTIVE",
};

function toForm(item) {
  return {
    ...EMPTY_FORM,
    ...item,
    displayOrder:
      item.displayOrder === null || item.displayOrder === undefined
        ? ""
        : String(item.displayOrder),
  };
}

export default function ReportSections() {
  const { can, loading: permsLoading } = usePermissions();

  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // "view" | "add" | "edit"
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);

  const isEditing = mode === "add" || mode === "edit";

  // Backend authority is authorizePermission("FILESETUP.REPORT_SECTIONS",
  // ...); the toolbar only REFLECTS it, same pattern as Group Code.
  const canView = permsLoading || can(MODULE_KEY, "VIEW");
  const canConfigure = can(MODULE_KEY, "CONFIGURE");

  useEffect(() => {
    loadReportSections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;

    return records.filter((item) =>
      [item.code, item.name, item.accountClass, item.status]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [records, search]);

  const currentIndex = filteredRecords.findIndex((r) => r.id === selectedId);

  useEffect(() => {
    if (isEditing) return;
    if (selectedId != null && !filteredRecords.some((r) => r.id === selectedId)) {
      setSelectedId(null);
      setForm({ ...EMPTY_FORM });
      setMode("view");
    }
  }, [filteredRecords, isEditing, selectedId]);

  async function loadReportSections(preferId) {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/report-sections`, {
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load report sections.");
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
      console.error("LOAD REPORT SECTIONS ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function confirmDiscardIfEditing() {
    if (!isEditing) return true;
    return window.confirm("Discard unsaved changes to this Report Section?");
  }

  function applySelection(item) {
    setSelectedId(item.id);
    setForm(toForm(item));
    setMode("view");
  }

  function selectRecord(item) {
    if (item.id === selectedId && !isEditing) return;
    if (!confirmDiscardIfEditing()) return;
    applySelection(item);
  }

  function handleAdd() {
    if (!canConfigure) return;
    if (!confirmDiscardIfEditing()) return;
    setSelectedId(null);
    setForm({ ...EMPTY_FORM });
    setMode("add");
  }

  function handleView() {
    if (!selectedId) return;
    const original = records.find((r) => r.id === selectedId);
    if (original) setForm(toForm(original));
    setMode("view");
  }

  function handleEdit() {
    if (!canConfigure) return;
    if (!form.id) {
      alert("Select a Report Section from the list first.");
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

  async function handleSave() {
    if (!canConfigure) return;
    if (!form.code.trim() || !form.name.trim()) {
      alert("Report Section Code and Name are required.");
      return;
    }

    try {
      const url =
        mode === "add"
          ? `${API_BASE}/api/report-sections`
          : `${API_BASE}/api/report-sections/${form.id}`;

      const method = mode === "add" ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        credentials: "include",
        body: JSON.stringify({
          code: form.code.trim(),
          name: form.name.trim(),
          accountClass: form.accountClass,
          status: form.status,
          displayOrder: form.displayOrder === "" ? null : Number(form.displayOrder),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to save report section.");
        return;
      }

      alert(data.message || "Report section saved successfully.");
      const savedId = mode === "add" ? data.id : form.id;
      await loadReportSections(savedId);
    } catch (err) {
      console.error("SAVE REPORT SECTION ERROR:", err);
      alert("Unable to save report section.");
    }
  }

  async function handleDelete() {
    if (!canConfigure) return;
    if (!form.id) {
      alert("Select a Report Section from the list first.");
      return;
    }

    const confirmDelete = window.confirm(
      `Delete report section "${form.name}"? This cannot be undone.`
    );
    if (!confirmDelete) return;

    try {
      const res = await fetch(`${API_BASE}/api/report-sections/${form.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: authHeaders(),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to delete report section.");
        return;
      }

      alert(data.message || "Report section deleted successfully.");
      await loadReportSections();
    } catch (err) {
      console.error("DELETE REPORT SECTION ERROR:", err);
      alert("Unable to delete report section.");
    }
  }

  const modeLabel =
    mode === "add"
      ? "Adding a new Report Section"
      : mode === "edit"
      ? "Editing Report Section"
      : selectedId
      ? "Viewing Report Section"
      : "No Report Section selected";

  if (!canView) {
    return (
      <div className="group-page">
        <div className="group-main">
          <div className="group-card">You do not have permission to view Report Sections.</div>
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
            <h1>Report Sections</h1>
            <p className="group-subtext">
              Maintain the Balance Sheet / Income Statement section catalog Group Codes classify
              into.
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
              disabled={!selectedId || mode === "view"}
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
          </div>
        </div>

        <div className="group-card">
          <p className="group-mode-tag">{modeLabel}</p>

          <div className="group-form-grid">
            <div className="group-field">
              <label htmlFor="rs-code">Report Section Code</label>
              <input
                id="rs-code"
                value={form.code}
                disabled={!isEditing}
                onChange={(e) => updateField("code", e.target.value.toUpperCase())}
                placeholder="Example: CURRENT_ASSET"
              />
              <p className="group-help">Machine-safe code stored on Group Code.</p>
            </div>

            <div className="group-field group-field--wide">
              <label htmlFor="rs-name">Report Section Name</label>
              <input
                id="rs-name"
                value={form.name}
                disabled={!isEditing}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="Example: Current Assets"
              />
            </div>

            <div className="group-field">
              <label htmlFor="rs-class">Account Class</label>
              <select
                id="rs-class"
                value={form.accountClass}
                disabled={!isEditing}
                onChange={(e) => updateField("accountClass", e.target.value)}
              >
                {ACCOUNT_CLASS_OPTIONS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <p className="group-help">Which Group Code Account Class can use this section.</p>
            </div>

            <div className="group-field">
              <label htmlFor="rs-order">Display Order</label>
              <input
                id="rs-order"
                type="number"
                step="1"
                value={form.displayOrder}
                disabled={!isEditing}
                onChange={(e) => updateField("displayOrder", e.target.value)}
                placeholder="blank = auto"
              />
              <p className="group-help">
                Controls the order sections are offered in. Leave blank for automatic ordering.
              </p>
            </div>

            <div className="group-field">
              <label htmlFor="rs-status">Status</label>
              <select
                id="rs-status"
                value={form.status}
                disabled={!isEditing}
                onChange={(e) => updateField("status", e.target.value)}
              >
                {STATUS_OPTIONS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
              <p className="group-help">Only ACTIVE sections are offered on Group Code.</p>
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
                {mode === "add" ? "Save Report Section" : "Update Report Section"}
              </button>
            </div>
          )}

          <div className="group-list-section">
            <div className="group-list-header">
              <h2>Report Section List</h2>
              <span className="group-count">{filteredRecords.length} item(s)</span>
              <input
                className="group-search no-print"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search report section..."
              />
            </div>

            <div className="group-table-wrap">
              <table className="group-table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Account Class</th>
                    <th>Order</th>
                    <th>Status</th>
                  </tr>
                </thead>

                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan="5" className="empty-cell">
                        Loading report sections...
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
                        <td>{item.code}</td>
                        <td>{item.name}</td>
                        <td>{item.accountClass}</td>
                        <td>{item.displayOrder ?? ""}</td>
                        <td>{item.status}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="5" className="empty-cell">
                        No report sections found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
