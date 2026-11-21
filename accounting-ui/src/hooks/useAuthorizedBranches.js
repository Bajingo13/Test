import { useEffect, useState } from "react";
import { authHeaders } from "../utils/authSession";

const API_BASE = import.meta.env.VITE_API_URL || "";

// Multi-Branch Phase C-2A: the branches the signed-in user may use in their
// company, straight from the server (GET /api/branch-scope/branches). Display
// only - every write is re-validated by the server.
export default function useAuthorizedBranches() {
  const [state, setState] = useState({ branches: [], canConsolidate: false, loaded: false });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/branch-scope/branches`, { credentials: "include", headers: authHeaders() });
        const body = await res.json().catch(() => ({}));
        if (alive) setState({ branches: res.ok && Array.isArray(body.branches) ? body.branches : [], canConsolidate: !!body.canConsolidate, loaded: true });
      } catch {
        if (alive) setState((s) => ({ ...s, loaded: true }));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
