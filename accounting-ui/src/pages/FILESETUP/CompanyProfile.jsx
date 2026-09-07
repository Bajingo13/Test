import { useEffect, useState } from "react";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import AutoResizeTextarea from "../../components/AutoResizeTextarea";
import "./GroupCodes.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

export default function CompanyProfile() {
  const [form, setForm] = useState({
    payorName: "",
    payorTin: "",
    payorAddress: "",
    payorZip: "",
    telephone: "",
    email: "",
    vatRegistered: true,
    branchCode: "",
    logoUrl: "",
    birPermitNo: "",
    atpDate: "",
    approvedSerialFrom: "",
    approvedSerialTo: "",
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      setLoading(true);

      const res = await fetch(`${API_BASE}/api/company-profile`, {
        credentials: "include",
        headers: authHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
        alert(data.message || "Failed to load company profile.");
        return;
      }

      setForm({
        payorName: data.payorName || "",
        payorTin: data.payorTin || "",
        payorAddress: data.payorAddress || "",
        payorZip: data.payorZip || "",
        telephone: data.telephone || "",
        email: data.email || "",
        vatRegistered: data.vatRegistered != null ? !!data.vatRegistered : true,
        branchCode: data.branchCode || "",
        logoUrl: data.logoUrl || "",
        birPermitNo: data.birPermitNo || "",
        atpDate: data.atpDate ? String(data.atpDate).slice(0, 10) : "",
        approvedSerialFrom: data.approvedSerialFrom || "",
        approvedSerialTo: data.approvedSerialTo || "",
      });
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
        headers: { "Content-Type": "application/json", ...authHeaders() },
        credentials: "include",
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        if (handleAuthError(res.status)) return;
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
              <AutoResizeTextarea
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

              <label>Telephone</label>
              <input
                value={form.telephone}
                onChange={(e) => updateField("telephone", e.target.value)}
                placeholder="(02) 8123-4567"
              />

              <label>Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => updateField("email", e.target.value)}
                placeholder="billing@company.example"
              />

              <label>
                <input
                  type="checkbox"
                  checked={form.vatRegistered}
                  onChange={(e) => updateField("vatRegistered", e.target.checked)}
                />{" "}
                VAT Registered
              </label>

              <label>Branch Code</label>
              <input
                value={form.branchCode}
                onChange={(e) => updateField("branchCode", e.target.value)}
                placeholder="HO"
              />

              <label>Logo URL</label>
              <input
                value={form.logoUrl}
                onChange={(e) => updateField("logoUrl", e.target.value)}
                placeholder="https://..."
              />

              <label>BIR Permit No.</label>
              <input
                value={form.birPermitNo}
                onChange={(e) => updateField("birPermitNo", e.target.value)}
                placeholder="BIR Permit / ATP number"
              />

              <label>ATP Date Issued</label>
              <input
                type="date"
                value={form.atpDate}
                onChange={(e) => updateField("atpDate", e.target.value)}
              />

              <label>Approved Serial No. (From)</label>
              <input
                value={form.approvedSerialFrom}
                onChange={(e) => updateField("approvedSerialFrom", e.target.value)}
                placeholder="000001"
              />

              <label>Approved Serial No. (To)</label>
              <input
                value={form.approvedSerialTo}
                onChange={(e) => updateField("approvedSerialTo", e.target.value)}
                placeholder="000100"
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
