import { authHeaders, handleAuthError } from "./utils/authSession";

const API_BASE_URL = import.meta.env.VITE_API_URL || "";

export async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...options.headers,
    },
  });

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  // 403 (authenticated but not permitted) must not clear the session or
  // redirect - only a real 401 (missing/expired/revoked token) does, and
  // POST /api/login's own 401 for a wrong password is excluded entirely
  // (see authSession.js/installAuthFetchGuard.js for the same rule applied
  // to every other fetch() call in the app).
  if (response.status === 401 && !endpoint.includes("/api/login")) {
    handleAuthError(401);
  }

  if (!response.ok) {
    throw new Error(
      data?.message || `Request failed with status ${response.status}`
    );
  }

  return data;
}

export function apiGet(endpoint) {
  return apiRequest(endpoint);
}

export function apiPost(endpoint, body) {
  return apiRequest(endpoint, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function apiPut(endpoint, body) {
  return apiRequest(endpoint, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function apiDelete(endpoint) {
  return apiRequest(endpoint, {
    method: "DELETE",
  });
}