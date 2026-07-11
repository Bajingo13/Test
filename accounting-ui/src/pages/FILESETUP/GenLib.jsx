import { useEffect, useMemo, useState } from "react";
import "./GenLib.css";

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
};

export default function GenLib() {
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("main");
  const [showTable, setShowTable] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(false);

  const isEditing = mode === "add" || mode === "edit";

  useEffect(() => {
    loadRecords();
  }, []);

  async function loadRecords() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/genlib`, {
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load General Libraries");
        return;
      }

      setRecords(data);

      if (data.length > 0) {
        setSelectedId(data[0].id);
        setForm({ ...data[0] });
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

  const filteredRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;

    return records.filter((item) =>
      [
        item.code,
        item.name,
        item.type,
        item.email,
        item.mobile,
        item.category,
        item.status,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [records, search]);

  const currentIndex = records.findIndex((item) => item.id === selectedId);

  function loadRecord(record) {
    setSelectedId(record.id);
    setForm({ ...record });
    setMode("view");
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function generateNextCode(list) {
    const numbers = list
      .map((item) => Number(String(item.code).replace(/[^\d]/g, "")))
      .filter((num) => !Number.isNaN(num));

    const next = numbers.length ? Math.max(...numbers) + 1 : 1;
    return `GL-${String(next).padStart(4, "0")}`;
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
      });

      const data = await res.json();

      if (!res.ok) {
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
        },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to save record");
        return;
      }

      alert(data.message || "Record saved successfully");
      await loadRecords();
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

  return (
    <div className="gl-page">
      <div className="gl-layout">
        <aside className="gl-sidebar">
          <div className="gl-sidebar-header">
            <p className="gl-mini-label">File Setup</p>
            <h2>General Libraries</h2>
            <input
              className="gl-search"
              type="text"
              placeholder="Search code, name, type..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="gl-list">
            {loading ? (
              <div className="gl-empty-list">Loading records...</div>
            ) : filteredRecords.length > 0 ? (
              filteredRecords.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={
                    selectedId === item.id
                      ? "gl-list-card active"
                      : "gl-list-card"
                  }
                  onClick={() => loadRecord(item)}
                >
                  <div className="gl-list-top">
                    <span className="gl-code">{item.code}</span>
                    <span className="gl-badge">{item.type}</span>
                  </div>
                  <div className="gl-name">{item.name}</div>
                  <div className="gl-meta">
                    {item.status} • {item.email || item.mobile || "No contact"}
                  </div>
                </button>
              ))
            ) : (
              <div className="gl-empty-list">No records found.</div>
            )}
          </div>
        </aside>

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
              <button className="btn btn-primary" onClick={handleAdd}>Add</button>
              <button className="btn" onClick={handleEdit}>Edit</button>
              <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
              <button className="btn" onClick={() => setMode("view")}>View</button>
              <button className="btn" onClick={() => window.print()}>Print</button>
              <button className="btn" onClick={handlePrevious}>Previous</button>
              <button className="btn" onClick={handleNext}>Next</button>
              <button
                className="btn btn-dark"
                onClick={() => setShowTable((prev) => !prev)}
              >
                {showTable ? "Hide Table" : "Show Table"}
              </button>
            </div>
          </div>

          <div className="gl-card">
            {showTable && (
              <div className="gl-table-section">
                <div className="gl-table-top">
                  <h3>Records</h3>
                  <span>{filteredRecords.length} item(s)</span>
                </div>

                <div className="gl-table-wrap">
                  <table className="gl-table">
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Email</th>
                        <th>Mobile</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecords.length > 0 ? (
                        filteredRecords.map((item) => (
                          <tr
                            key={item.id}
                            className={selectedId === item.id ? "selected-row" : ""}
                            onClick={() => loadRecord(item)}
                          >
                            <td>{item.code}</td>
                            <td>{item.name}</td>
                            <td>{item.type}</td>
                            <td>{item.status}</td>
                            <td>{item.email}</td>
                            <td>{item.mobile}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan="6" className="empty-cell">
                            No matching records.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="gl-top-grid">
              <div className="field">
                <label>Code</label>
                <input
                  value={form.code}
                  disabled={!isEditing}
                  onChange={(e) => updateField("code", e.target.value)}
                />
              </div>

              <div className="field field-wide">
                <label>Name</label>
                <input
                  value={form.name}
                  disabled={!isEditing}
                  onChange={(e) => updateField("name", e.target.value)}
                />
              </div>

              <div className="field">
                <label>Type</label>
                <select
                  value={form.type}
                  disabled={!isEditing}
                  onChange={(e) => updateField("type", e.target.value)}
                >
                  {PARTY_TYPES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="gl-tabs">
              <button
                className={activeTab === "main" ? "gl-tab active" : "gl-tab"}
                onClick={() => setActiveTab("main")}
                type="button"
              >
                Main Info
              </button>
              <button
                className={activeTab === "additional" ? "gl-tab active" : "gl-tab"}
                onClick={() => setActiveTab("additional")}
                type="button"
              >
                Additional Info
              </button>
              <button
                className={activeTab === "billing" ? "gl-tab active" : "gl-tab"}
                onClick={() => setActiveTab("billing")}
                type="button"
              >
                Billing / Tax
              </button>
            </div>

            {activeTab === "main" && (
              <div className="tab-panel">
                <div className="gl-grid">
                  <div className="field">
                    <label>Status</label>
                    <select
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
                    <label>Start Date</label>
                    <input
                      type="date"
                      value={form.startDate || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("startDate", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label>Address Line 1</label>
                    <input
                      value={form.address1 || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("address1", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label>Address Line 2</label>
                    <input
                      value={form.address2 || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("address2", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label>Address Line 3</label>
                    <input
                      value={form.address3 || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("address3", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>Attention</label>
                    <input
                      value={form.attention || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("attention", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>Position</label>
                    <input
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
              <div className="tab-panel">
                <div className="gl-grid">
                  <div className="field">
                    <label>Telephone No.</label>
                    <input
                      value={form.telephone || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("telephone", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>Fax No.</label>
                    <input
                      value={form.fax || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("fax", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>Mobile No.</label>
                    <input
                      value={form.mobile || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("mobile", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>Email</label>
                    <input
                      type="email"
                      value={form.email || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("email", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>Category</label>
                    <select
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
                    <label>Branch Code</label>
                    <input
                      value={form.branchCode || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("branchCode", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>RDO Code</label>
                    <input
                      value={form.rdoCode || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("rdoCode", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label>Notes</label>
                    <textarea
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
              <div className="tab-panel">
                <div className="gl-grid">
                  <div className="field">
                    <label>TIN</label>
                    <input
                      value={form.tin || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("tin", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>ATC Code</label>
                    <input
                      value={form.atcCode || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("atcCode", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label>EWT Code</label>
                    <input
                      value={form.ewtCode || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("ewtCode", e.target.value)}
                    />
                  </div>

                  <div className="field field-span-2">
                    <label>Billing Notes</label>
                    <textarea
                      rows="5"
                      value={form.notes || ""}
                      disabled={!isEditing}
                      onChange={(e) => updateField("notes", e.target.value)}
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
    </div>
  );
}