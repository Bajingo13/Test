import { useEffect, useState } from "react";
import UserList from "./UserList";
import PendingInvitations from "./PendingInvitations";
import "./UserSettings.css";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const TABS = [
  { id: "users", label: "User List" },
  { id: "invitations", label: "Pending Invitations" },
];

export default function UserSettings() {
  const [activeTab, setActiveTab] = useState("users");
  const [canView, setCanView] = useState(null);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/me/permissions`, { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) {
          setCanView(false);
          return;
        }
        const view = data.permissions.some((p) => p.moduleKey === "ADMIN.USER_SETTINGS" && p.action === "VIEW" && p.granted);
        const edit = data.permissions.some((p) => p.moduleKey === "ADMIN.USER_SETTINGS" && p.action === "EDIT" && p.granted);
        setCanView(view);
        setCanEdit(edit);
      } catch (err) {
        console.error("CHECK USER SETTINGS ACCESS ERROR:", err);
        setCanView(false);
      }
    })();
  }, []);

  if (canView === null) {
    return <div className="us-page"><p className="us-muted">Loading...</p></div>;
  }

  if (canView === false) {
    return (
      <div className="us-page">
        <div className="us-card">
          <h1>User Settings</h1>
          <div className="us-error-banner">You do not have permission to view User Settings.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="us-page">
      <h1>User Settings</h1>

      <div className="us-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`us-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="us-card">
        {activeTab === "users" && <UserList canEdit={canEdit} />}
        {activeTab === "invitations" && <PendingInvitations embedded />}
      </div>
    </div>
  );
}
