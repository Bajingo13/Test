// Supporting-document file checks (RFP receipts): what a file IS is decided
// from its bytes, never from its name or the browser-supplied MIME type.
//
//   PNG   89 50 4E 47 0D 0A 1A 0A, then an IHDR chunk
//   JPEG  FF D8 FF
//   WebP  "RIFF" .... "WEBP" "VP8"
//   PDF   "%PDF-" at byte 0 and "%%EOF" in the last 1 KB; no active content
//
// The filename extension must ALSO be one of the allowed extensions and must
// agree with the detected type, so a PDF renamed .png, an .exe renamed .pdf,
// or an HTML/SVG/script/archive file under any name is rejected (415).

const ALLOWED = {
  "image/png": { label: "PNG", extensions: [".png"] },
  "image/jpeg": { label: "JPEG", extensions: [".jpg", ".jpeg"] },
  "image/webp": { label: "WebP", extensions: [".webp"] },
  "application/pdf": { label: "PDF", extensions: [".pdf"] },
};
const ALLOWED_EXTENSIONS = Object.values(ALLOWED).flatMap((t) => t.extensions);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const FILENAME_MAX = 200;
const SUPPORTED_TEXT = "JPG, JPEG, PNG, WebP or PDF";

// PDF features that make a document run something: scripts, launch actions,
// embedded files, rich media. Receipts never need them.
const PDF_ACTIVE_CONTENT = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia)[\s/<(\[]/;

function fileError(message, statusCode = 415) {
  return Object.assign(new Error(message), { statusCode });
}

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

function detectFileType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && startsWith(buf, ascii("IHDR"), 12)) return "image/png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8) && startsWith(buf, ascii("VP8"), 12)) return "image/webp";
  if (startsWith(buf, ascii("%PDF-"))) return "application/pdf";
  return null;
}

function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || "").trim());
  return m ? `.${m[1].toLowerCase()}` : "";
}

function isAllowedExtension(name) {
  return ALLOWED_EXTENSIONS.includes(extensionOf(name));
}

// Display name only - it is never used as a path. Drops any directory part,
// control characters and characters Windows / macOS / shells treat
// specially, and keeps the extension when shortening.
function sanitizeFilename(name, fallbackExt) {
  let s = String(name || "").normalize("NFC");
  s = s.split(/[\\/]/).pop();
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim();
  s = s.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  const own = /.[A-Za-z0-9]{1,10}$/.exec(s)?.[0] || "";
  const ext = own || fallbackExt;
  let stem = s.slice(0, s.length - own.length).trim();
  if (!stem) stem = "attachment";
  if (stem.length + ext.length > FILENAME_MAX) stem = stem.slice(0, FILENAME_MAX - ext.length).trim();
  return `${stem}${ext}`;
}

// Validates an uploaded file (multer memory file) and returns its detected
// type and safe display name. Throws a 400/413/415 error with a message that
// is safe to show the user.
function validateAttachmentFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw fileError("Choose a file to attach.", 400);
  if (file.buffer.length === 0) throw fileError("The file is empty.", 400);
  if (file.buffer.length > MAX_ATTACHMENT_BYTES) throw fileError("The file is larger than the 10 MB limit.", 413);
  const ext = extensionOf(file.originalname);
  if (!ALLOWED_EXTENSIONS.includes(ext)) throw fileError(`Only ${SUPPORTED_TEXT} files can be attached.`);

  const mime = detectFileType(file.buffer);
  if (!mime) throw fileError(`The file is not a valid ${SUPPORTED_TEXT} file.`);
  if (!ALLOWED[mime].extensions.includes(ext)) {
    throw fileError(`The file content is ${ALLOWED[mime].label}, which does not match its ${ext} extension. Rename it or choose another file.`);
  }
  if (mime === "application/pdf") {
    const tail = file.buffer.subarray(Math.max(0, file.buffer.length - 1024)).toString("latin1");
    if (!tail.includes("%%EOF")) throw fileError("The PDF is incomplete or damaged.");
    if (PDF_ACTIVE_CONTENT.test(file.buffer.toString("latin1"))) {
      throw fileError("PDFs containing scripts, launch actions or embedded files cannot be attached.");
    }
  }
  return { mimeType: mime, extension: ext, filename: sanitizeFilename(file.originalname, ALLOWED[mime].extensions[0]) };
}

// RFC 6266 header: an ASCII fallback plus the exact UTF-8 name.
function contentDisposition(filename, type = "attachment") {
  const fallback = String(filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = {
  ALLOWED,
  ALLOWED_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  SUPPORTED_TEXT,
  detectFileType,
  extensionOf,
  isAllowedExtension,
  sanitizeFilename,
  validateAttachmentFile,
  contentDisposition,
  fileError,
};
