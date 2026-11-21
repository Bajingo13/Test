import { useEffect, useState } from "react";
import { authHeaders } from "../../utils/authSession";
import { branchOptions, defaultBranch, branchLabel } from "./reportBranch.mjs";

const API_URL = import.meta.env.VITE_API_URL || "";

// Multi-Branch Phase C-2A: the branches this user may report on, from the
// server (GET /api/branch-scope/branches). A failed load simply means no
// selector - the server still applies the user's branch scope to every report.
export default function useReportBranch() {
  const [options, setOptions] = useState([]);
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/branch-scope/branches`, { credentials: "include", headers: authHeaders() });
        const body = await res.json().catch(() => ({}));
        if (!alive || !res.ok) return;
        const opts = branchOptions(body);
        setOptions(opts);
        setValue((current) => (current && opts.some((o) => o.value === current) ? current : defaultBranch(opts)));
      } catch {
        // no selector; the server-side default scope still applies
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { options, value, setValue, label: branchLabel(options, value), loaded };
}
