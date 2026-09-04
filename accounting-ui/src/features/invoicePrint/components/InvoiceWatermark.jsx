// Same states/behavior as the E-Invoicing Replica's applyWatermark(): DRAFT
// (gray) or VOID/CANCELLED (red), hidden for every other status. Invoice
// doesn't currently expose a Void/Cancelled workflow (that's APV/CV-only
// today - see voidCancelService.js), so this only ever fires for DRAFT in
// practice; VOID is wired for when/if invoice void is added, not invented.
export default function InvoiceWatermark({ status }) {
  const normalized = String(status || "").trim().toLowerCase();

  let text = null;
  let variant = null;

  if (normalized === "draft") {
    text = "DRAFT";
    variant = "draft";
  } else if (["void", "canceled", "cancelled"].includes(normalized)) {
    text = "VOID";
    variant = "void";
  }

  if (!text) return null;

  return (
    <div className={`invoice-watermark invoice-watermark--${variant}`} aria-hidden="true">
      {text}
    </div>
  );
}
