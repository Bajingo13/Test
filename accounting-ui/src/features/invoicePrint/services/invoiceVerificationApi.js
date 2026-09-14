const API_URL = import.meta.env.VITE_API_URL || "";

// Public verification endpoints - no auth header, no cookies, exactly like
// any anonymous visitor scanning the QR code. Never sends the session
// token even if one happens to exist in this browser (a logged-in staff
// member testing a QR code should see exactly what a customer sees).
export async function fetchInvoiceVerification(token, { signal } = {}) {
  const res = await fetch(`${API_URL}/api/verify/${encodeURIComponent(token)}`, { signal });
  if (!res.ok) return { status: "invalid" };
  return res.json();
}

export function verifiedInvoicePdfUrl(token) {
  return `${API_URL}/api/verify/${encodeURIComponent(token)}/pdf`;
}
