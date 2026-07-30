import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL || "";

function authHeaders() {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Fetches the current user's resolved effective permissions once per page
// load and exposes a can(moduleKey, action) lookup - the frontend's job is
// only to REFLECT what the backend already enforces (hide/disable), never
// to be the actual security boundary; every one of these permissions is
// independently re-checked server-side by authorizePermission middleware.
export default function usePermissions() {
  const [permissions, setPermissions] = useState(null);
  const [roleCode, setRoleCode] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/me/permissions`, { headers: authHeaders() });
        if (!res.ok) {
          if (!cancelled) {
            setPermissions(new Map());
            setLoading(false);
          }
          return;
        }
        const data = await res.json();
        if (cancelled) return;

        const map = new Map();
        (data.permissions || []).forEach((p) => {
          if (p.granted) map.set(`${p.moduleKey}.${p.action}`, true);
        });
        setPermissions(map);
        setRoleCode(data.user?.roleCode || null);
      } catch (err) {
        console.error("LOAD PERMISSIONS ERROR:", err);
        if (!cancelled) setPermissions(new Map());
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  function can(moduleKey, action = "VIEW") {
    if (roleCode === "SUPER_ADMIN") return true;
    if (!permissions) return true; // fail-open on the frontend while loading - backend still enforces
    return permissions.has(`${moduleKey}.${action}`);
  }

  return { can, loading, roleCode };
}
