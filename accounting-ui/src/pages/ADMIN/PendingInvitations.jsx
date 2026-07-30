import { useEffect, useState } from "react";
import InviteUserModal from "../../components/InviteUserModal";
import "./PendingInvitations.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

// Standalone page for now (Phase 2 scope) - Phase 3 folds this into the
// full UserSettings.jsx shell as a tab, reusing this same component.
export default function PendingInvitations({ embedded = false }) {
  const [canView, setCanView] = useState(null);
  const [canCreate, setCanCreate] = useState(false);
  const [invitations, setInvitations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showInviteModal, setShowInviteModal] = useState(false);

  useEffect(() => {
    checkAccessThenLoad();
  }, []);

  async function checkAccessThenLoad() {
    try {
      const res = await fetch(`${API_URL}/api/me/permissions`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setCanView(false);
        return;
      }
      const canViewInvites = data.permissions.some((p) => p.moduleKey === "ADMIN.INVITATIONS" && p.action === "VIEW" && p.granted);
      const canCreateInvites = data.permissions.some((p) => p.moduleKey === "ADMIN.INVITATIONS" && p.action === "CREATE" && p.granted);
      setCanView(canViewInvites);
      setCanCreate(canCreateInvites);
      if (canViewInvites) await loadInvitations();
    } catch (err) {
      console.error("CHECK ACCESS ERROR:", err);
      setCanView(false);
    }
  }

  async function loadInvitations() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/invitations`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "Failed to load invitations");
        return;
      }
      setInvitations(data);
    } catch (err) {
      console.error("LOAD INVITATIONS ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResend(id) {
    try {
      const res = await fetch(`${API_URL}/api/invitations/${id}/resend`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to resend invitation");
        return;
      }
      if (data.emailDelivered === false) {
        alert(`Email delivery isn't configured. Share this link manually:\n\n${data.acceptUrl}`);
      }
      loadInvitations();
    } catch (err) {
      console.error("RESEND INVITATION ERROR:", err);
      alert("Unable to connect to the server.");
    }
  }

  async function handleRevoke(id) {
    if (!confirm("Revoke this invitation? The link will stop working immediately.")) return;
    try {
      const res = await fetch(`${API_URL}/api/invitations/${id}/revoke`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to revoke invitation");
        return;
      }
      loadInvitations();
    } catch (err) {
      console.error("REVOKE INVITATION ERROR:", err);
      alert("Unable to connect to the server.");
    }
  }

  if (canView === null) {
    return embedded ? <p className="pi-muted">Loading...</p> : <div className="pi-page"><p className="pi-muted">Loading...</p></div>;
  }

  if (canView === false) {
    const denied = <div className="pi-error-banner">You do not have permission to view invitations.</div>;
    if (embedded) return denied;
    return (
      <div className="pi-page">
        <div className="pi-card">
          <h1>Pending Invitations</h1>
          {denied}
        </div>
      </div>
    );
  }

  const content = (
    <>
      <div className="pi-header">
        {!embedded && <h1>Pending Invitations</h1>}
        {embedded && <div />}
        {canCreate && (
          <button type="button" className="pi-btn-primary" onClick={() => setShowInviteModal(true)}>
            + Invite User
          </button>
        )}
      </div>

      <div className={embedded ? "" : "pi-card"}>
        {error && <div className="pi-error-banner">{error}</div>}
        {loading ? (
          <p className="pi-muted">Loading invitations...</p>
        ) : invitations.length === 0 ? (
          <p className="pi-muted">No invitations yet.</p>
        ) : (
          <div className="pi-table-wrap">
            <table className="pi-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Full Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Invited By</th>
                  <th>Expires</th>
                  <th>Email</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.email}</td>
                    <td>{inv.full_name}</td>
                    <td>{inv.role_name}</td>
                    <td>
                      <span className={`pi-badge pi-badge-${inv.status.toLowerCase()}`}>{inv.status}</span>
                    </td>
                    <td>{inv.invited_by_username}</td>
                    <td>{formatDate(inv.expires_at)}</td>
                    <td>{inv.email_delivery_status === "SENT" ? "Sent" : "Not sent"}</td>
                    <td>
                      {inv.status === "PENDING" && canCreate && (
                        <div className="pi-row-actions">
                          <button type="button" className="pi-link-btn" onClick={() => handleResend(inv.id)}>Resend</button>
                          <button type="button" className="pi-link-btn pi-danger" onClick={() => handleRevoke(inv.id)}>Revoke</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <InviteUserModal
        open={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        onInvited={loadInvitations}
      />
    </>
  );

  return embedded ? content : <div className="pi-page">{content}</div>;
}
