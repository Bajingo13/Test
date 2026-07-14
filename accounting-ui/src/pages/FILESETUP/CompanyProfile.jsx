import { useEffect, useState } from "react";
import "./GroupCodes.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

export default function CompanyProfile() {
  const [form, setForm] = useState({
    payorName: "",
    payorTin: "",
    payorAddress: "",
    payorZip: "",
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/company-profile`, { credentials: "include" });
      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to load company profile.");
        return;
      }

      setForm(data);
    } catch (err) {
      console.error("LOAD COMPANY PROFILE ERROR:", err);
      alert("Unable to connect to server.");
    } finally {
      setLoading(false);
    }
  }

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    if (!form.payorName.trim() || !form.payorTin.trim()) {
      alert("Company Name and TIN are required.");
      return;
    }

    try {
      setSaving(true);

      const res = await fetch(`${API_BASE}/api/company-profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Failed to save company profile.");
        return;
      }

      alert(data.message || "Company profile saved successfully.");
    } catch (err) {
      console.error("SAVE COMPANY PROFILE ERROR:", err);
      alert("Unable to save company profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="group-page">
      <div className="group-header">
        <div>
          <p className="group-mini">File Setup</p>
          <h1>Company Profile</h1>
          <p>
            Your own company's details, used as the Payor information on tax certificates
            such as BIR Form 2307.
          </p>
        </div>
      </div>

      <div className="group-layout">
        <section className="group-card" style={{ maxWidth: 600 }}>
          <h2>Payor Information</h2>

          {loading ? (
            <p>Loading...</p>
          ) : (
            <div className="group-form">
              <label>Company Name</label>
              <input
                value={form.payorName}
                onChange={(e) => updateField("payorName", e.target.value)}
                placeholder="Registered company name"
              />

              <label>TIN</label>
              <input
                value={form.payorTin}
                onChange={(e) => updateField("payorTin", e.target.value)}
                placeholder="000-000-000-000"
              />

              <label>Registered Address</label>
              <input
                value={form.payorAddress}
                onChange={(e) => updateField("payorAddress", e.target.value)}
                placeholder="Complete registered address"
              />

              <label>Zip Code</label>
              <input
                value={form.payorZip}
                onChange={(e) => updateField("payorZip", e.target.value)}
                placeholder="0000"
              />

              <button className="primary-btn" type="button" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Company Profile"}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
