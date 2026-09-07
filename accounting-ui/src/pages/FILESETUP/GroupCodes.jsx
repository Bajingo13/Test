import { useEffect, useMemo, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import AutoResizeTextarea from "../../components/AutoResizeTextarea";
import { sectionsForClass, sectionLabel, isSectionValidForClass } from "./groupCodeSections.mjs";
import "./GroupCodes.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

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

export default function GroupCodes() {
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [mode, setMode] = useState("add");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadGroupCodes();
  }, []);

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;

    return records.filter((item) =>
      [item.groupCode, item.groupDescription, item.accountClass, item.status]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [records, search]);

  async function loadGroupCodes() {
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
      // clear it rather than keep an illegal combination.
      if (key === "accountClass" && !isSectionValidForClass(value, next.reportSection)) {
        next.reportSection = "";
      }
      return next;
    });
  }

  function handleNew() {
    setForm({ ...EMPTY_FORM });
    setMode("add");
  }

  function handleEdit(item) {
    setForm({
      ...EMPTY_FORM,
      ...item,
      reportSection: item.reportSection || "",
      displayOrder: item.displayOrder === null || item.displayOrder === undefined ? "" : String(item.displayOrder),
    });
    setMode("edit");
  }

  const unclassifiedCount = useMemo(
    () => records.filter((r) => r.status === "ACTIVE" && !r.reportSection).length,
    [records]
  );

  async function handleSave() {
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
      handleNew();
      await loadGroupCodes();
    } catch (err) {
      console.error("SAVE GROUP CODE ERROR:", err);
      alert("Unable to save group code.");
    }
  }

  async function handleDelete(id) {
    const confirmDelete = window.confirm("Delete this group code?");
    if (!confirmDelete) return;

    try {
      const res = await fetch(`${API_BASE}/api/group-codes/${id}`, {
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
      handleNew();
      await loadGroupCodes();
    } catch (err) {
      console.error("DELETE GROUP CODE ERROR:", err);
      alert("Unable to delete group code.");
    }
  }

  return (
    <div className="group-page">
      <div className="group-header">
        <div>
          <p className="group-mini">File Setup</p>
          <h1>Account Group Codes</h1>
          <p>Maintain group codes used inside Chart of Accounts.</p>
        </div>

        <button type="button" onClick={handleNew}>
          New Group Code
        </button>
      </div>

      {unclassifiedCount > 0 && (
        <div className="group-warning" role="status">
          {unclassifiedCount} Group Code{unclassifiedCount === 1 ? "" : "s"} require report
          classification before Condensed / Detailed Balance Sheet and Income Statement
          templates can be generated.
        </div>
      )}

      <div className="group-layout">
        <section className="group-card">
          <h2>{mode === "add" ? "Add Group Code" : "Edit Group Code"}</h2>

          <div className="group-form">
            <label>Group Code</label>
            <input
              value={form.groupCode}
              onChange={(e) => updateField("groupCode", e.target.value)}
              placeholder="Example: 1000"
            />

            <label>Group Description</label>
            <AutoResizeTextarea
              value={form.groupDescription}
              onChange={(e) => updateField("groupDescription", e.target.value)}
              placeholder="Example: Cash and Cash Equivalents"
            />

            <label>Account Class</label>
            <select
              value={form.accountClass}
              onChange={(e) => updateField("accountClass", e.target.value)}
            >
              {ACCOUNT_CLASS_OPTIONS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>

            <label>Report Section</label>
            <select
              value={form.reportSection}
              onChange={(e) => updateField("reportSection", e.target.value)}
            >
              <option value="">— Unclassified —</option>
              {sectionsForClass(form.accountClass).map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>

            <label>Display Order</label>
            <input
              type="number"
              step="1"
              value={form.displayOrder}
              onChange={(e) => updateField("displayOrder", e.target.value)}
              placeholder="e.g. 10, 20, 30 (blank = auto)"
            />

            <label>Status</label>
            <select
              value={form.status}
              onChange={(e) => updateField("status", e.target.value)}
            >
              {STATUS_OPTIONS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>

            <button className="primary-btn" type="button" onClick={handleSave}>
              {mode === "add" ? "Save Group Code" : "Update Group Code"}
            </button>
          </div>
        </section>

        <section className="group-card">
          <div className="group-list-header">
            <h2>Group Code List</h2>

            <input
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
                  <th>Action</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan="7" className="empty-cell">
                      Loading group codes...
                    </td>
                  </tr>
                ) : filteredRecords.length > 0 ? (
                  filteredRecords.map((item) => (
                    <tr key={item.id}>
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
                      <td>
                        <button type="button" onClick={() => handleEdit(item)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger-btn"
                          onClick={() => handleDelete(item.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="7" className="empty-cell">
                      No group codes found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}