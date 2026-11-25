import { authHeaders, handleAuthError } from "./authSession";

const API_BASE = import.meta.env.VITE_API_URL || "";

// POST /api/<module>/bulk-delete { ids } for the File Setup "Delete Selected"
// action (RecordViewModal bulkDelete). Returns the server's per-record result
// ({ summary, results }) or { error } - never throws for an HTTP refusal.
// The server re-checks permission, company / branch scope and in-use rules
// for every id; nothing here decides what may be deleted.
export async function postBulkDelete(path, ids, extraBody = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ ...extraBody, ids }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    handleAuthError(res.status, data.code);
    return { error: "Your session has ended. Please sign in again. Nothing was deleted." };
  }
  if (!res.ok) return { error: data.message || "Delete failed. Nothing was deleted." };
  return data;
}
