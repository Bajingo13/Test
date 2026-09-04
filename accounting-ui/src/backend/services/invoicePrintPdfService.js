const puppeteer = require("puppeteer");
const { HttpError } = require("../lib/httpError");
const { signInvoicePrintRenderToken } = require("./invoicePrintRenderTokenService");

// Internal, server-to-server base URL for the React app - Puppeteer
// navigates here directly, never through whatever public hostname the
// browser uses.
//
// In production this same Express process serves the built frontend
// itself (see server.js's "FRONTEND STATIC FILES" section - express.static
// on `dist/`, same PORT as the API), so the correct target is this
// server's own port, not the Vite dev server. In development
// (npm run dev:backend sets NODE_ENV=development), the React app is only
// served by the separate Vite dev server on :5173 - `dist/` may not even
// exist yet. Set INTERNAL_APP_URL explicitly to override either default
// (e.g. a deployment that serves the frontend from a separate host).
const INTERNAL_APP_URL =
  process.env.INTERNAL_APP_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://127.0.0.1:5173"
    : `http://127.0.0.1:${process.env.PORT || 8080}`);

const NAVIGATION_TIMEOUT_MS = 30000;
const READY_TIMEOUT_MS = 20000;

// Shared by every Standard Invoice print flavor (single document, with-
// entries copy, and the 3 list summaries) - navigates to `url`, waits for
// the same window.__REPLICA_READY/__REPLICA_ERROR readiness contract every
// StandardInvoicePrintPage/InvoiceListPrintPage variant sets, and returns a
// Letter-sized PDF buffer.
async function renderPrintUrlToPdf(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      // --disable-dev-shm-usage: containers (Railway included) often mount
      // a tiny /dev/shm, which otherwise makes Chromium crash under normal
      // page load - a very common "just works locally, fails in the
      // container" gotcha, harmless to always set.
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();

    // Dismiss any unexpected dialog (alert/confirm/beforeunload) instead of
    // letting it hang PDF generation forever.
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));

    let renderError = null;
    page.on("pageerror", (err) => {
      renderError = renderError || err;
    });

    // Neutralize window.print/window.close before any app script runs, so
    // useAutoPrint (if ?autoprint were ever set) or a stray user action can
    // never open a native print dialog or close this headless tab.
    await page.evaluateOnNewDocument(() => {
      window.print = () => {};
      window.close = () => {};
    });

    await page.goto(url, { waitUntil: "networkidle0", timeout: NAVIGATION_TIMEOUT_MS });

    await page.waitForFunction(
      "window.__REPLICA_READY === true || !!window.__REPLICA_ERROR",
      { timeout: READY_TIMEOUT_MS }
    );

    const replicaError = await page.evaluate(() => window.__REPLICA_ERROR);
    if (replicaError || renderError) {
      throw new HttpError(422, "Unable to render this document for PDF export.");
    }

    return await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      // The page's own CSS already draws its footer - Chrome's built-in
      // header/footer template would duplicate it, so it stays off.
      displayHeaderFooter: false,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Server-side diagnostic only (never sent to the HTTP response) - the
    // render token is redacted first since a Puppeteer navigation error can
    // otherwise echo the full request URL back in its message.
    const safeMessage = String(err?.message || err).replace(/renderToken=[^&\s]+/g, "renderToken=[redacted]");
    console.error("INVOICE PDF RENDER ERROR:", err?.name || "Error", safeMessage);
    throw new HttpError(500, "Failed to generate PDF.");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Single invoice (customer-facing "without entries", or internal
// "with entries" accounting copy - see `mode`). Read-only end to end: the
// page it loads never posts, never writes, and this function never
// touches invoice_headers/invoice_lines itself - the caller (the /pdf
// export controller) has already loaded/validated the invoice through the
// normal, company-scoped, permission-checked print pipeline before this
// runs.
async function renderInvoicePdf({ invoiceId, userId, username, companyId, mode }) {
  const renderToken = signInvoicePrintRenderToken({ userId, username, companyId, invoiceId, docType: "single" });
  const params = new URLSearchParams({ renderToken });
  if (mode === "with_entries") params.set("mode", "with_entries");
  const url = `${INTERNAL_APP_URL}/print/invoice/${encodeURIComponent(invoiceId)}?${params.toString()}`;
  return renderPrintUrlToPdf(url);
}

// One of the 3 "Print List by ..." summaries (by invoice number, invoice
// date, or customer) - never scoped to a single invoice id.
async function renderInvoiceListPdf({ userId, username, companyId, grouping, from, to }) {
  const renderToken = signInvoicePrintRenderToken({ userId, username, companyId, docType: "list" });
  const params = new URLSearchParams({ renderToken, grouping: grouping || "number" });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const url = `${INTERNAL_APP_URL}/print/invoice/list?${params.toString()}`;
  return renderPrintUrlToPdf(url);
}

module.exports = { renderInvoicePdf, renderInvoiceListPdf };
