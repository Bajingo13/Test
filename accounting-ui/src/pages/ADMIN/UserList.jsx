import { useEffect, useMemo, useState } from "react";
import UserAccessDrawer from "../../components/UserAccessDrawer";
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

export default function UserList({ canEdit }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [drawerUserId, setDrawerUserId] = useState(null);

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

  async function handleStatusChange(id, status) {
    if (!confirm(`Set this user's status to ${status}?`)) return;
    try {
      const res = await fetch(`${API_URL}/api/users/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to update status");
        return;
      }
      loadUsers();
    } catch (err) {
      console.error("UPDATE STATUS ERROR:", err);
      alert("Unable to connect to the server.");
    }
  }

  async function handleRevokeSessions(id) {
    if (!confirm("Revoke all active sessions for this user? They will be signed out immediately.")) return;
    try {
      const res = await fetch(`${API_URL}/api/users/${id}/revoke-sessions`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message || "Failed to revoke sessions");
        return;
      }
      alert("Sessions revoked.");
    } catch (err) {
      console.error("REVOKE SESSIONS ERROR:", err);
      alert("Unable to connect to the server.");
    }
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

  return (
    <div>
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

      {error && <div className="ul-error-banner">{error}</div>}

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
                    <td>{u.full_name}</td>
                    <td>{u.email || u.username}</td>
                    <td>
                      <span className={`ul-role-badge ul-role-${(u.role_code || "").toLowerCase()}`}>
                        {u.role_name || "-"}
                      </span>
                    </td>
                    <td>{u.companies.map((c) => c.name).join(", ") || "-"}</td>
                    <td>{u.branches.map((b) => b.name).join(", ") || "-"}</td>
                    <td>
                      <span className={`ul-status-badge ul-status-${u.status.toLowerCase()}`}>{u.status}</span>
                    </td>
                    <td>{formatDate(u.last_login_at)}</td>
                    <td>{formatDate(u.created_at)}</td>
                    <td>
                      {canEdit && (
                        <div className="ul-row-actions">
                          <button type="button" className="ul-link-btn" onClick={() => setDrawerUserId(u.id)}>Edit Access</button>
                          {u.status !== "ACTIVE" && (
                            <button type="button" className="ul-link-btn" onClick={() => handleStatusChange(u.id, "ACTIVE")}>Activate</button>
                          )}
                          {u.status === "ACTIVE" && (
                            <button type="button" className="ul-link-btn" onClick={() => handleStatusChange(u.id, "INACTIVE")}>Deactivate</button>
                          )}
                          {u.status !== "SUSPENDED" && (
                            <button type="button" className="ul-link-btn ul-danger" onClick={() => handleStatusChange(u.id, "SUSPENDED")}>Suspend</button>
                          )}
                          <button type="button" className="ul-link-btn" onClick={() => handleRevokeSessions(u.id)}>Revoke Sessions</button>
                        </div>
                      )}
                    </td>
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
        onClose={() => setDrawerUserId(null)}
        onSaved={loadUsers}
      />
    </div>
  );
}
