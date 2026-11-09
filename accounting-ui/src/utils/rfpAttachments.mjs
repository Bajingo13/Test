// RFP supporting documents - browser-side rules. These only give the user
// an early, clear message; the server re-checks every file by its content
// (lib/attachmentFileType.js) and is the authority.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const ATTACHMENT_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];
export const ATTACHMENT_ACCEPT = ".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf";
export const SUPPORTED_TEXT = "JPG, JPEG, PNG, WebP or PDF";

export const ATTACHMENT_CATEGORIES = [
  { value: "RECEIPT", label: "Receipt" },
  { value: "SUPPORTING_DOCUMENT", label: "Supporting document" },
];

export function categoryLabel(value) {
  return ATTACHMENT_CATEGORIES.find((c) => c.value === value)?.label || value || "";
}

export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || "").trim());
  return m ? `.${m[1].toLowerCase()}` : "";
}

// Returns an error message for a file the user picked, or "" when it may be
// queued for upload.
export function checkAttachmentFile(file) {
  if (!file) return "Choose a file.";
  if (!ATTACHMENT_EXTENSIONS.includes(extensionOf(file.name))) return `${file.name}: only ${SUPPORTED_TEXT} files can be attached.`;
  if (!file.size) return `${file.name}: the file is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name}: the file is larger than the 10 MB limit.`;
  return "";
}

// How a file can be previewed in the page: images inline, PDFs in a frame.
export function previewKind(mimeTypeOrName) {
  const v = String(mimeTypeOrName || "").toLowerCase();
  if (/^image\/(png|jpeg|webp)$/.test(v) || [".png", ".jpg", ".jpeg", ".webp"].includes(extensionOf(v))) return "image";
  if (v === "application/pdf" || extensionOf(v) === ".pdf") return "pdf";
  return null;
}

export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function rfpAttachmentsPath(rfpId) {
  return `/api/rfp/${encodeURIComponent(rfpId)}/attachments`;
}

export function apvAttachmentsPath(apvId) {
  return `/api/apv/${encodeURIComponent(apvId)}/attachments`;
}

export function downloadPath(basePath, attachmentId) {
  return `${basePath}/${encodeURIComponent(attachmentId)}/download`;
}
