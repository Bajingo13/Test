import { handleAuthError } from "./authSession";
import { withActiveBranchHeader } from "./activeBranchHeader";

// System-wide authentication audit: most pages (~40) have no local 401
// handling at all - a failed request just falls into that page's own
// `alert(data.message)` catch block. When several requests on one page
// fail with 401 at once (a page loading 4-5 lists concurrently against an
// expired token, for example), that produces several stacked native
// alert() dialogs before anything redirects the user anywhere.
//
// Rather than adding a `handleAuthError` call to every one of those pages
// individually, this installs one global fetch wrapper (once, at app
// startup) that reacts to ANY 401 response app-wide: it reuses
// authSession.js's own dedup guard, so only the first concurrent 401
// clears the session and redirects - see that module for why. This is a
// safety net, not a replacement for the pages that already call
// `handleAuthError` themselves; both paths converge on the same guarded
// function, so calling it twice for the same 401 is a harmless no-op.
//
// POST /api/login is deliberately excluded: a wrong password there is a
// normal 401 business response ("Invalid username or password"), not an
// expired session, and must not trigger a session-expired redirect while
// the user is already sitting on the login page trying to sign in.
export function installAuthFetchGuard() {
  if (window.__authFetchGuardInstalled) return;
  window.__authFetchGuardInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (...rawArgs) => {
    // System-wide Active Branch: this app's own /api requests carry the
    // active branch (X-Active-Branch). The server only ever NARROWS with it.
    const args = withActiveBranchHeader(rawArgs);
    const response = await originalFetch(...args);

    if (response.status === 401) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (!url.includes("/api/login")) {
        // the reason (e.g. SESSION_EXPIRED) from a clone, so the caller's body is untouched
        const code = await response.clone().json().then((d) => d?.code).catch(() => null);
        handleAuthError(401, code);
      }
    }

    return response;
  };
}
