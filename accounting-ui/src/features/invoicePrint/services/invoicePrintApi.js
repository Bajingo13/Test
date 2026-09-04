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

async function readErrorMessage(res, fallback) {
  let message = fallback;
  try {
    const body = await res.json();
    if (body?.message) message = body.message;
  } catch {
    // ignore - keep the generic message, never leak raw response text
  }
  return message;
}

// Fetches the standardized print view model for one invoice. Read-only:
// never mutates the invoice, never increments anything server-side.
// `mode` is "without_entries" (customer-facing, default) or
// "with_entries" (internal accounting copy - needs PRINT_WITH_ENTRIES).
export async function fetchInvoicePrintViewModel(identifier, { signal, renderToken, mode } = {}) {
  const params = new URLSearchParams({ intent: "preview" });
  if (mode === "with_entries") params.set("mode", "with_entries");

  const res = await fetch(`${API_URL}/api/invoice-print/${encodeURIComponent(identifier)}?${params.toString()}`, {
    credentials: "include",
    headers: authHeaders(renderToken),
    signal,
  });

  if (!res.ok) throw new Error(await readErrorMessage(res, `Failed to load invoice (${res.status})`));
  return res.json();
}

// Fetches the view model for one of the 3 "Print List by ..." summaries.
// `grouping` is "number" | "date" | "party" - same vocabulary
// transactionPrintDataService.getTransactionList already uses.
export async function fetchInvoiceListPrintViewModel({ signal, renderToken, grouping, from, to } = {}) {
  const params = new URLSearchParams({ grouping: grouping || "number" });
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const res = await fetch(`${API_URL}/api/invoice-print/list?${params.toString()}`, {
    credentials: "include",
    headers: authHeaders(renderToken),
    signal,
  });

  if (!res.ok) throw new Error(await readErrorMessage(res, `Failed to load invoice list (${res.status})`));
  return res.json();
}
