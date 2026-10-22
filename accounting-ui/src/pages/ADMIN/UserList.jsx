import { useEffect, useMemo, useRef, useState } from "react";
import UserAccessDrawer, { MANAGEABLE_ROLES_BY_ACTOR } from "../../components/UserAccessDrawer";
import "./UserList.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function formatDate(value) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function displayName(u) {
  return (u.full_name || "").trim() || u.username;
}

const ACTION_HELP = {
  unlock: "Clear the failed-login lockout so this user can sign in again.",
  activate: "Restore access. The user can sign in again.",
  deactivate:
    "Deactivate: turn the account off, e.g. the person has left. They are signed out and can't sign in until reactivated.",
  suspend:
    "Suspend: temporarily block the account, e.g. during a review. They are signed out and can't sign in until reactivated.",
  revoke: "Sign this user out of every device. Their account stays active.",
};

// What each confirmation says. Unlock and Activate run without one.
const CONFIRMATIONS = {
  INACTIVE: {
    title: "Deactivate user?",
    body: (name) => `${name} will be signed out immediately and won't be able to sign in until the account is reactivated.`,
    confirmLabel: "Deactivate",
  },
  SUSPENDED: {
    title: "Suspend user?",
    body: (name) => `${name} will be signed out immediately and won't be able to sign in until the account is reactivated.`,
    confirmLabel: "Suspend",
  },
  REVOKE: {
    title: "Revoke sessions?",
    body: (name) => `${name} will be signed out of every device immediately. The account stays active.`,
    confirmLabel: "Revoke Sessions",
  },
};

function ConfirmDialog({ confirmation, busy, onCancel, onConfirm }) {
  const confirmRef = useRef(null);
  useEffect(() => {
    if (!confirmation) return undefined;
    confirmRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmation, onCancel]);

  if (!confirmation) return null;
  const config = CONFIRMATIONS[confirmation.kind];
  return (
    <div className="ul-confirm-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="ul-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ul-confirm-title">
        <h3 id="ul-confirm-title">{config.title}</h3>
        <p>{config.body(confirmation.name)}</p>
        <div className="ul-confirm-actions">
          <button type="button" className="ul-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" ref={confirmRef} className="ul-btn ul-btn-danger-solid" onClick={onConfirm} disabled={busy}>
            {busy ? "Working..." : config.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function UserList({ canEdit, currentUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [drawerUserId, setDrawerUserId] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/api/users`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "Failed to load users");
        return;
      }
      setUsers(data);
    } catch (err) {
      console.error("LOAD USERS ERROR:", err);
      setError("Unable to connect to the server.");
    } finally {
      setLoading(false);
    }
  }

  async function runAction(path, init, successMessage, failureMessage) {
    setError("");
    setNotice("");
    try {
      const res = await fetch(`${API_URL}/api/users/${path}`, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || failureMessage);
        return;
      }
      setNotice(successMessage);
      loadUsers();
    } catch (err) {
      console.error("USER ACTION ERROR:", err);
      setError("Unable to connect to the server.");
    }
  }

  function changeStatus(user, status) {
    const label = status === "ACTIVE" ? "activated" : status === "SUSPENDED" ? "suspended" : "deactivated";
    return runAction(
      `${user.id}/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ status }),
      },
      `${displayName(user)} was ${label}.`,
      "Failed to update status"
    );
  }

  function unlock(user) {
    return runAction(
      `${user.id}/unlock`,
      { method: "POST", headers: authHeaders() },
      `${displayName(user)} was unlocked.`,
      "Failed to unlock user"
    );
  }

  function revokeSessions(user) {
    return runAction(
      `${user.id}/revoke-sessions`,
      { method: "POST", headers: authHeaders() },
      `Sessions revoked for ${displayName(user)}.`,
      "Failed to revoke sessions"
    );
  }

  async function handleConfirm() {
    if (!confirmation) return;
    setBusy(true);
    const { kind, user } = confirmation;
    if (kind === "REVOKE") await revokeSessions(user);
    else await changeStatus(user, kind);
    setBusy(false);
    setConfirmation(null);
  }

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      const matchesSearch =
        !q ||
        [u.username, u.email, u.full_name, u.role_name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q);
      const matchesStatus = statusFilter === "ALL" || u.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [users, search, statusFilter]);

  const manageableRoles = MANAGEABLE_ROLES_BY_ACTOR[currentUser?.roleCode] || [];

  function renderActions(u) {
    const isSelf = Number(u.id) === Number(currentUser?.id);
    // Own row: only Edit Access (name / memberships; the role is locked in
    // the drawer). No status changes, unlock or revoke on yourself.
    if (isSelf) {
      return (
        <div className="ul-row-actions">
          <button type="button" className="ul-btn" onClick={() => setDrawerUserId(u.id)}>Edit Access</button>
        </div>
      );
    }
    if (!manageableRoles.includes(u.role_code)) {
      return <span className="ul-muted ul-no-actions" title="You can't manage users with this role.">View only</span>;
    }
    const ask = (kind) => setConfirmation({ kind, user: u, name: displayName(u) });
    return (
      <div className="ul-row-actions">
        <button type="button" className="ul-btn" onClick={() => setDrawerUserId(u.id)}>Edit Access</button>
        {!!u.is_locked && (
          <button type="button" className="ul-btn" title={ACTION_HELP.unlock} onClick={() => unlock(u)}>Unlock</button>
        )}
        {u.status !== "ACTIVE" && (
          <button type="button" className="ul-btn" title={ACTION_HELP.activate} onClick={() => changeStatus(u, "ACTIVE")}>Activate</button>
        )}
        {u.status === "ACTIVE" && (
          <button type="button" className="ul-btn ul-btn-danger" title={ACTION_HELP.deactivate} onClick={() => ask("INACTIVE")}>Deactivate</button>
        )}
        {u.status !== "SUSPENDED" && (
          <button type="button" className="ul-btn ul-btn-danger" title={ACTION_HELP.suspend} onClick={() => ask("SUSPENDED")}>Suspend</button>
        )}
        <button type="button" className="ul-btn" title={ACTION_HELP.revoke} onClick={() => ask("REVOKE")}>Revoke Sessions</button>
      </div>
    );
  }

  return (
    <div className="ul-root">
      <div className="ul-toolbar">
        <input
          type="text"
          className="ul-search-input"
          placeholder="Search by name, email, username, or role..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="ul-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="ALL">All Statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="SUSPENDED">Suspended</option>
        </select>
      </div>

      {error && <div className="ul-error-banner" role="alert">{error}</div>}
      {notice && <div className="ul-success-banner" role="status">{notice}</div>}

      {loading ? (
        <p className="ul-muted">Loading users...</p>
      ) : (
        <div className="ul-table-wrap">
          <table className="ul-table">
            <thead>
              <tr>
                <th>Full Name</th>
                <th>Email / Username</th>
                <th>Role</th>
                <th>Companies</th>
                <th>Branches</th>
                <th>Status</th>
                <th>Last Login</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan="9" className="ul-empty">No users found.</td>
                </tr>
              ) : (
                filteredUsers.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {displayName(u)}
                      {Number(u.id) === Number(currentUser?.id) && <span className="ul-you">You</span>}
                    </td>
                    <td>{u.email || u.username}</td>
                    <td>
                      <span className={`ul-role-badge ul-role-${(u.role_code || "").toLowerCase()}`}>
                        {u.role_name || "-"}
                      </span>
                    </td>
                    <td>{u.companies.map((c) => c.name).join(", ") || "-"}</td>
                    <td>{u.branches.map((b) => b.name).join(", ") || "-"}</td>
                    <td>
                      <div className="ul-badges">
                        <span className={`ul-status-badge ul-status-${u.status.toLowerCase()}`}>{u.status}</span>
                        {!!u.is_locked && (
                          <span className="ul-status-badge ul-status-locked" title="Locked after too many failed sign-in attempts.">
                            Locked
                          </span>
                        )}
                      </div>
                    </td>
                    <td>{formatDate(u.last_login_at)}</td>
                    <td>{formatDate(u.created_at)}</td>
                    <td>{canEdit && renderActions(u)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <UserAccessDrawer
        open={drawerUserId !== null}
        userId={drawerUserId}
        currentUser={currentUser}
        onClose={() => setDrawerUserId(null)}
        onSaved={loadUsers}
      />

      <ConfirmDialog
        confirmation={confirmation}
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
