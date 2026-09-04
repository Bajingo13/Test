const puppeteer = require("puppeteer");
const { HttpError } = require("../lib/httpError");
const { signInvoicePrintRenderToken } = require("./invoicePrintRenderTokenService");

// Internal, server-to-server base URL for the React app - Puppeteer
// navigates here directly, never through whatever public hostname the
// browser uses. Defaults to the Vite dev server; set INTERNAL_APP_URL in
// production to wherever the built frontend is actually served from.
const INTERNAL_APP_URL = process.env.INTERNAL_APP_URL || "http://127.0.0.1:5173";

const NAVIGATION_TIMEOUT_MS = 30000;
const READY_TIMEOUT_MS = 20000;

// Renders the Standard Invoice printable to a Letter-sized PDF via a
// disposable, isolated Puppeteer page. Read-only end to end: the page it
// loads never posts, never writes, and this function never touches
// invoice_headers/invoice_lines itself - the caller (the /pdf export
// controller) has already loaded/validated the invoice through the normal,
// company-scoped, permission-checked print pipeline before this runs.
async function renderInvoicePdf({ invoiceId, userId, username, companyId }) {
  const renderToken = signInvoicePrintRenderToken({ userId, username, companyId, invoiceId });
  const url = `${INTERNAL_APP_URL}/print/invoice/${encodeURIComponent(invoiceId)}?renderToken=${encodeURIComponent(renderToken)}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
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

    // The readiness contract StandardInvoicePrintPage/usePrintReadiness
    // sets: window.__REPLICA_READY only after data + fonts + images have
    // all settled, or window.__REPLICA_ERROR on a safe, non-sensitive
    // failure.
    await page.waitForFunction(
      "window.__REPLICA_READY === true || !!window.__REPLICA_ERROR",
      { timeout: READY_TIMEOUT_MS }
    );

    const replicaError = await page.evaluate(() => window.__REPLICA_ERROR);
    if (replicaError || renderError) {
      throw new HttpError(422, "Unable to render this invoice for PDF export.");
    }

    const pdfBuffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
      // The invoice's own CSS already draws its footer
      // (.invoice-print-footer-meta) - Chrome's built-in header/footer
      // template would duplicate it, so it stays off.
      displayHeaderFooter: false,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    return pdfBuffer;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Never bubble the raw Puppeteer error (it can echo back the request
    // URL, which carries the render token) to the HTTP response or logs.
    throw new HttpError(500, "Failed to generate invoice PDF.");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { renderInvoicePdf };
