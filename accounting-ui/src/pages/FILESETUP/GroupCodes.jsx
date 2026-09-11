import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import usePermissions from "../../hooks/usePermissions";
import AutoResizeTextarea from "../../components/AutoResizeTextarea";
import { sectionsForClass, sectionLabel, isSectionValidForClass } from "./groupCodeSections.mjs";
import "./GroupCodes.css";

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

  const isEditing = mode === "add" || mode === "edit";

  // Backend authority is authorizePermission("FILESETUP.GROUP_CODES", ...);
  // the toolbar only REFLECTS it. VIEW gates the screen, CONFIGURE gates
  // every write. No new permissions are introduced.
  const canView = permsLoading || can(MODULE_KEY, "VIEW");
  const canConfigure = can(MODULE_KEY, "CONFIGURE");

  useEffect(() => {
    loadGroupCodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              <p className="group-help">
                Where this group appears in the Balance Sheet / Income Statement template. The
                choices follow the selected Account Class.
              </p>
            </div>

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
    </div>
  );
}
