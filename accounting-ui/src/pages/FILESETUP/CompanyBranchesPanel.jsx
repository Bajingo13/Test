import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authHeaders, handleAuthError } from "../../utils/authSession";
import usePermissions from "../../hooks/usePermissions";
import "./BranchManagement.css";

// Company Profile -> "Branches" section: the company's branches at a glance,
// read-only, with a link to Branch Management. Shown only to users who may
// view branches (FILESETUP.BRANCHES / VIEW); the API enforces the same rule.
const API_BASE = import.meta.env.VITE_API_URL || "";

export default function CompanyBranchesPanel() {
  const { can, loading: permsLoading } = usePermissions();
  const canView = !permsLoading && can("FILESETUP.BRANCHES", "VIEW");
  const [branches, setBranches] = useState(null);

  useEffect(() => {
    if (!canView) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/company-branches`, { credentials: "include", headers: authHeaders() });
        const data = await res.json().catch(() => []);
        if (!res.ok) {
          handleAuthError(res.status);
          setBranches([]);
          return;
        }
        setBranches(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error("LOAD COMPANY BRANCHES ERROR:", err);
        setBranches([]);
      }
    })();
  }, [canView]);

  if (!canView) return null;
  const multiCompany = new Set((branches || []).map((b) => b.companyId)).size > 1;

  return (
    <section className="group-card br-page br-panel" aria-labelledby="cp-branches-title" style={{ maxWidth: 600 }}>
      <div className="br-panel-head">
        <h2 id="cp-branches-title">Branches</h2>
        <Link to="/branch-management" className="br-panel-link">Manage branches</Link>
      </div>
      {branches === null ? (
        <p className="br-summary">Loading branches...</p>
      ) : branches.length === 0 ? (
        <p className="br-summary">No branches yet.</p>
      ) : (
        <ul className="br-panel-list">
          {branches.map((b) => (
            <li key={b.id}>
              <span className="br-code">{b.code}</span>
              <span className="br-panel-name">{b.name}{multiCompany ? ` · ${b.companyName}` : ""}</span>
              <span className={`br-status br-status--${b.status === "INACTIVE" ? "inactive" : "active"}`}>{b.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
