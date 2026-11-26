import { addActiveBranchHeader } from "./activeBranch.mjs";
import { getToken } from "./authSession";

// The X-Active-Branch value the global fetch wrapper (installAuthFetchGuard)
// adds to this app's own /api requests. Set by the ActiveBranchProvider
// whenever the active branch changes; null = no header (the aggregate view or
// no branches: the server applies the user's own full scope).
//
// The value is bound to the session token it was chosen under: after a
// logout / a login as someone else (a different token) nothing is sent until
// the provider has loaded the NEW user's branches - a previous user's branch
// never rides along on the next session's requests.
let current = null;
let owner = null;

function tokenNow() {
  try {
    return getToken() || null;
  } catch {
    return null;
  }
}

export function setActiveBranchHeader(value) {
  current = value ? String(value) : null;
  owner = current ? tokenNow() : null;
}

export function getActiveBranchHeader() {
  return current && owner && owner === tokenNow() ? current : null;
}

export function withActiveBranchHeader(args) {
  return addActiveBranchHeader(args, getActiveBranchHeader(), {
    origin: typeof window !== "undefined" ? window.location.origin : "",
    apiBase: import.meta.env.VITE_API_URL || "",
  });
}
