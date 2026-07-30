import { useEffect, useMemo, useState } from "react";
import "./PermissionTemplateManager.css";

const API_URL = import.meta.env.VITE_API_URL || "";
const ACTIONS = ["VIEW", "CREATE", "EDIT", "DELETE", "SUBMIT", "APPROVE", "POST", "EXPORT", "CONFIGURE"];

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function PermissionTemplateManager() {
  const [isSuperAdmin, setIsSuperAdmin] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [items, setItems] = useState([]);
  const [grants, setGrants] = useState({});
  const [originalGrants, setOriginalGrants] = useState({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_URL}/api/me/permissions`, { headers: authHeaders() });
      const data = await res.json();
      const superAdmin = res.ok && data.user?.roleCode === "SUPER_ADMIN";
      setIsSuperAdmin(superAdmin);
      if (superAdmin) await loadTemplates();
    })();
  }, []);

  async function loadTemplates() {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/permission-templates`, { headers: authHeaders() });
      const data = await res.json();
      setTemplates(data);
      if (data.length && !selectedId) selectTemplate(data[0].id);
    } catch (err) {
      console.error("LOAD TEMPLATES ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  async function selectTemplate(id) {
    if (isDirty() && !confirm("Discard unsaved changes?")) return;
    setCreatingNew(false);
    setSelectedId(id);
    setError("");
    setSuccess("");
    const res = await fetch(`${API_URL}/api/permission-templates/${id}`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message || "Failed to load template");
      return;
    }
    setName(data.template.name);
    setDescription(data.template.description || "");
    setItems(data.items);
    const g = {};
    data.items.forEach((i) => { g[i.permission_id] = !!i.granted; });
    setGrants(g);
    setOriginalGrants(g);
  }

  function startNewTemplate() {
    if (isDirty() && !confirm("Discard unsaved changes?")) return;
    setCreatingNew(true);
    setSelectedId(null);
    setName("");
    setDescription("");
    setError("");
    setSuccess("");
    if (items.length === 0 && templates.length) {
      // Load the full permission catalog shape from any existing template's items list (all-permissions, all ungranted)
      fetch(`${API_URL}/api/permission-templates/${templates[0].id}`, { headers: authHeaders() })
        .then((r) => r.json())
        .then((data) => {
          setItems(data.items);
          setGrants({});
          setOriginalGrants({});
        });
    } else {
      const g = {};
      setGrants(g);
      setOriginalGrants(g);
    }
  }

  function isDirty() {
    const keys = new Set([...Object.keys(grants), ...Object.keys(originalGrants)]);
    return [...keys].some((k) => !!grants[k] !== !!originalGrants[k]);
  }

  const grouped = useMemo(() => {
    const byModule = {};
    items.forEach((i) => {
      if (!byModule[i.module_key]) byModule[i.module_key] = {};
      byModule[i.module_key][i.action] = i.permission_id;
    });
    return byModule;
  }, [items]);

  function toggle(permissionId) {
    setGrants((prev) => ({ ...prev, [permissionId]: !prev[permissionId] }));
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Template name is required.");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const grantsArray = Object.entries(grants)
        .filter(([, granted]) => granted)
        .map(([permissionId]) => ({ permissionId: Number(permissionId), granted: true }));

      const url = creatingNew ? `${API_URL}/api/permission-templates` : `${API_URL}/api/permission-templates/${selectedId}`;
      const method = creatingNew ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name, description, grants: grantsArray }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "Failed to save template");
        return;
      }
      setSuccess("Template saved. Existing users assigned this template are not affected unless you explicitly re-apply it.");
      await loadTemplates();
      selectTemplate(data.template.id);
    } catch (err) {
      console.error("SAVE TEMPLATE ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    if (!confirm(`Delete template "${name}"? This does not affect users already assigned from it.`)) return;
    try {
      const res = await fetch(`${API_URL}/api/permission-templates/${selectedId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to delete template");
        return;
      }
      setSelectedId(null);
      loadTemplates();
    } catch (err) {
      console.error("DELETE TEMPLATE ERROR:", err);
      alert("Unable to connect to the server.");
    }
  }

  if (isSuperAdmin === null) {
    return <div className="ptm-page"><p className="ptm-muted">Loading...</p></div>;
  }

  if (isSuperAdmin === false) {
    return (
      <div className="ptm-page">
        <div className="ptm-card">
          <h1>Permission Templates</h1>
          <div className="ptm-error-banner">Only the Super Admin can manage permission templates.</div>
        </div>
      </div>
    );
  }

  const selectedTemplate = templates.find((t) => t.id === selectedId);

  return (
    <div className="ptm-page">
      <h1>Permission Templates</h1>

      <div className="ptm-layout">
        <div className="ptm-sidebar">
          <button type="button" className="ptm-btn-primary ptm-new-btn" onClick={startNewTemplate}>
            + New Template
          </button>
          {loading ? (
            <p className="ptm-muted">Loading...</p>
          ) : (
            <ul className="ptm-template-list">
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`ptm-template-item ${selectedId === t.id ? "active" : ""}`}
                    onClick={() => selectTemplate(t.id)}
                  >
                    <span>{t.name}</span>
                    <span className="ptm-count">{t.permission_count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ptm-card ptm-editor">
          {(selectedTemplate || creatingNew) && (
            <>
              <div className="ptm-editor-header">
                <div className="ptm-field">
                  <label>Template Name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="ptm-field ptm-field-wide">
                  <label>Description</label>
                  <input value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
                <div className="ptm-editor-actions">
                  <button type="button" className="ptm-btn-primary" onClick={handleSave} disabled={saving}>
                    {saving ? "Saving..." : creatingNew ? "Create Template" : "Save Changes"}
                  </button>
                  {!creatingNew && selectedTemplate && !selectedTemplate.is_system && (
                    <button type="button" className="ptm-btn-danger" onClick={handleDelete}>Delete</button>
                  )}
                </div>
              </div>

              {error && <div className="ptm-error-banner">{error}</div>}
              {success && <div className="ptm-success-banner">{success}</div>}

              <div className="ptm-table-wrap">
                <table className="ptm-table">
                  <thead>
                    <tr>
                      <th>Module</th>
                      {ACTIONS.map((a) => <th key={a}>{a}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(grouped).sort().map((moduleKey) => (
                      <tr key={moduleKey}>
                        <td className="ptm-module-cell">{moduleKey}</td>
                        {ACTIONS.map((action) => {
                          const permId = grouped[moduleKey][action];
                          if (!permId) return <td key={action} className="ptm-na">-</td>;
                          return (
                            <td key={action}>
                              <input type="checkbox" checked={!!grants[permId]} onChange={() => toggle(permId)} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
