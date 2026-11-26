import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { authHeaders, getToken, USER_KEY } from "../utils/authSession";
import { setActiveBranchHeader } from "../utils/activeBranchHeader";
import { ALL, activeBranchId, buildOptions, headerValue, isAll, labelFor, lastKey, resolveValue, storageKey } from "../utils/activeBranch.mjs";

const API_URL = import.meta.env.VITE_API_URL || "";
const PUBLIC_PATHS = ["/login", "/accept-invite", "/verify-email"];

// System-wide Active Branch - ONE shared selection for the whole app.
//
// The Dashboard's Branch selector and the sidebar selector both drive it; the
// global fetch wrapper sends it to the server as X-Active-Branch, so lists,
// posting and reports follow it (the server only ever narrows with it).
//
//   - options = the signed-in user's ACTUAL assigned branches in the selected
//     company (GET /api/branch-scope/branches), plus an aggregate option when
//     there are several ("All Branches" / "All Assigned Branches");
//   - re-read on every navigation, so changed assignments are picked up and a
//     branch that is no longer allowed falls back to the aggregate;
//   - reset on logout / login (the token / user changes);
//   - a per-user, per-company saved choice is a convenience only;
//   - changing it remounts the current page (App keys the page by
//     `renderKey`), so no data, selection or cache from the previous branch
//     survives; pages with unsaved edits can ask for a confirmation first.
const ActiveBranchContext = createContext(null);

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
function signedInUserId() {
  try {
    return String(JSON.parse(storage()?.getItem(USER_KEY) || "null")?.id || "");
  } catch {
    return "";
  }
}
function readSaved(key) {
  try {
    return storage()?.getItem(key) || "";
  } catch {
    return "";
  }
}
function writeSaved(key, value) {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* storage unavailable - the choice lasts for this visit only */
  }
}

export function ActiveBranchProvider({ children }) {
  const location = useLocation();
  const isPublic = PUBLIC_PATHS.includes(location.pathname) || location.pathname.startsWith("/print/") || location.pathname.startsWith("/verify/");
  // Re-read on every navigation: a login / logout changes these.
  const token = getToken();
  const userId = signedInUserId();
  const sessionKey = token ? `${userId}:${token.slice(-16)}` : "";

  const [requestedCompanyId, setRequestedCompanyId] = useState("");
  const [state, setState] = useState(() => {
    // Apply the last choice at once so the very first requests carry it (the
    // server re-validates it; the branch list below confirms or replaces it).
    const last = userId ? readSaved(lastKey(userId)) : "";
    setActiveBranchHeader(token ? headerValue(last) : null);
    return { status: "idle", sessionKey: "", companyId: "", branches: [], canConsolidate: false, totalBranches: 0, value: last };
  });
  const dirtyRef = useRef(new Map());
  const [pending, setPending] = useState(null); // a switch waiting for confirmation

  const options = useMemo(() => buildOptions(state), [state]);

  // Load / revalidate the branch list (company + session + navigation).
  useEffect(() => {
    if (!token || isPublic) {
      if (!token) {
        setActiveBranchHeader(null);
        setState((s) => (s.status === "idle" && !s.value ? s : { status: "idle", sessionKey: "", companyId: "", branches: [], canConsolidate: false, totalBranches: 0, value: "" }));
      }
      return undefined;
    }
    let alive = true;
    (async () => {
      try {
        const qs = requestedCompanyId ? `?${new URLSearchParams({ companyId: requestedCompanyId })}` : "";
        const res = await fetch(`${API_URL}/api/branch-scope/branches${qs}`, { credentials: "include", headers: { ...authHeaders(), "X-Active-Branch": ALL } });
        const body = await res.json().catch(() => ({}));
        if (!alive || !res.ok) return;
        const companyId = String(body.companyId || "");
        const next = { branches: Array.isArray(body.branches) ? body.branches : [], canConsolidate: !!body.canConsolidate, totalBranches: Number(body.totalBranches || 0) };
        const nextOptions = buildOptions(next);
        setState((s) => {
          const sameSession = s.sessionKey === sessionKey && s.companyId === companyId;
          const saved = sameSession ? s.value : readSaved(storageKey(userId, companyId)) || s.value;
          const value = resolveValue(nextOptions, saved);
          setActiveBranchHeader(headerValue(value));
          if (userId) writeSaved(lastKey(userId), value);
          return { status: "ready", sessionKey, companyId, ...next, value };
        });
      } catch {
        /* keep the current selection; the server still applies the user's own scope */
      }
    })();
    return () => {
      alive = false;
    };
    // location.pathname: revalidate on every navigation
  }, [token, sessionKey, userId, requestedCompanyId, isPublic, location.pathname]);

  const apply = useCallback(
    (value) => {
      setState((s) => {
        const v = resolveValue(buildOptions(s), value);
        setActiveBranchHeader(headerValue(v));
        if (userId) {
          writeSaved(storageKey(userId, s.companyId), v);
          writeSaved(lastKey(userId), v);
        }
        return { ...s, value: v };
      });
      setPending(null);
    },
    [userId]
  );

  // Pages with unsaved edits register here; a switch then waits for a
  // confirmation (shown by the selector) instead of discarding them silently.
  const registerDirty = useCallback((key, dirty) => {
    if (dirty) dirtyRef.current.set(key, true);
    else dirtyRef.current.delete(key);
  }, []);

  const requestChange = useCallback(
    (value) => {
      if (String(value) === String(state.value)) return;
      if (dirtyRef.current.size > 0) {
        setPending(String(value));
        return;
      }
      apply(value);
    },
    [apply, state.value]
  );

  const ctx = useMemo(
    () => ({
      ready: state.status === "ready",
      companyId: state.companyId,
      setCompanyId: (id) => setRequestedCompanyId(id ? String(id) : ""),
      branches: state.branches,
      canConsolidate: state.canConsolidate,
      totalBranches: state.totalBranches,
      options,
      value: state.value,
      isAll: isAll(state.value),
      activeBranchId: activeBranchId(state.value),
      label: labelFor(options, state.value),
      requestChange,
      pending,
      pendingLabel: pending ? labelFor(options, pending) : "",
      confirmPending: () => pending && (dirtyRef.current.clear(), apply(pending)),
      cancelPending: () => setPending(null),
      registerDirty,
      // App keys the routed page by this: a new branch remounts the page.
      // (Only the value: the first branch-list load confirming the saved
      // choice must not remount the page a second time.)
      renderKey: String(state.value || ""),
    }),
    [state, options, requestChange, pending, apply, registerDirty]
  );

  return <ActiveBranchContext.Provider value={ctx}>{children}</ActiveBranchContext.Provider>;
}

const FALLBACK = {
  ready: false, companyId: "", setCompanyId: () => {}, branches: [], canConsolidate: false, totalBranches: 0, options: [], value: "",
  isAll: true, activeBranchId: null, label: "", requestChange: () => {}, pending: null, pendingLabel: "", confirmPending: () => {},
  cancelPending: () => {}, registerDirty: () => {}, renderKey: "",
};

export function useActiveBranch() {
  return useContext(ActiveBranchContext) || FALLBACK;
}

// A page with unsaved edits: a branch switch asks for confirmation first.
export function useActiveBranchDirtyGuard(key, dirty) {
  const { registerDirty } = useActiveBranch();
  useEffect(() => {
    registerDirty(key, !!dirty);
    return () => registerDirty(key, false);
  }, [key, dirty, registerDirty]);
}
