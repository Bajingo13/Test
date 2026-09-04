const API_URL = import.meta.env.VITE_API_URL || "";

// A renderToken (present only when Puppeteer's headless page loaded this
// route - see invoicePrintPdfService.js) stands in for the normal session
// token: the headless browser has no access to this origin's localStorage,
// so there is no real login JWT to send.
function authHeaders(renderToken) {
  if (renderToken) return { "x-print-render-token": renderToken };
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Fetches the standardized print view model for one invoice. Read-only:
// never mutates the invoice, never increments anything server-side.
export async function fetchInvoicePrintViewModel(identifier, { signal, renderToken } = {}) {
  const res = await fetch(`${API_URL}/api/invoice-print/${encodeURIComponent(identifier)}?intent=preview`, {
    credentials: "include",
    headers: authHeaders(renderToken),
    signal,
  });

  if (!res.ok) {
    let message = `Failed to load invoice (${res.status})`;
    try {
      const body = await res.json();
      if (body?.message) message = body.message;
    } catch {
      // ignore - keep the generic message, never leak raw response text
    }
    throw new Error(message);
  }

  return res.json();
}
