// RFP supporting documents - browser helpers (utils/rfpAttachments.mjs) and
// source checks on the form / view / APV wiring. The server-side behaviour
// (content checks, storage, permissions) is in
// backend/__tests__/rfpAttachments.http.test.js.
const fs = require("fs");
const path = require("path");

let a;
let r;
beforeAll(async () => {
  a = await import("../rfpAttachments.mjs");
  r = await import("../rfpPage.mjs");
});

const SRC = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const file = (name, size, type = "") => ({ name, size, type });

describe("checkAttachmentFile", () => {
  test.each(["receipt.png", "Receipt.JPG", "photo.jpeg", "scan.webp", "invoice.pdf"])("accepts %s", (name) => {
    expect(a.checkAttachmentFile(file(name, 1000))).toBe("");
  });

  test.each(["setup.exe", "archive.zip", "page.html", "image.svg", "receipt", "receipt.pdf.exe", "notes.txt"])("refuses %s", (name) => {
    expect(a.checkAttachmentFile(file(name, 1000))).toMatch(/only JPG, JPEG, PNG, WebP or PDF/);
  });

  test("size: empty refused, exactly 10 MB accepted, one byte more refused", () => {
    expect(a.checkAttachmentFile(file("a.png", 0))).toMatch(/empty/);
    expect(a.checkAttachmentFile(file("a.png", 10 * 1024 * 1024))).toBe("");
    expect(a.checkAttachmentFile(file("a.png", 10 * 1024 * 1024 + 1))).toMatch(/10 MB/);
  });
});

describe("helpers", () => {
  test("previewKind", () => {
    expect(a.previewKind("image/png")).toBe("image");
    expect(a.previewKind("image/jpeg")).toBe("image");
    expect(a.previewKind("application/pdf")).toBe("pdf");
    expect(a.previewKind("receipt.WEBP")).toBe("image");
    expect(a.previewKind("image/svg+xml")).toBeNull();
    expect(a.previewKind("text/html")).toBeNull();
  });

  test("formatFileSize", () => {
    expect(a.formatFileSize(512)).toBe("512 B");
    expect(a.formatFileSize(2048)).toBe("2.0 KB");
    expect(a.formatFileSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
  });

  test("paths are encoded", () => {
    expect(a.rfpAttachmentsPath(5)).toBe("/api/rfp/5/attachments");
    expect(a.apvAttachmentsPath("7")).toBe("/api/apv/7/attachments");
    expect(a.downloadPath("/api/rfp/5/attachments", "../x")).toBe("/api/rfp/5/attachments/..%2Fx/download");
  });

  test("the browser accept list and limits match the server", () => {
    const server = require("../../backend/lib/attachmentFileType");
    expect([...a.ATTACHMENT_EXTENSIONS].sort()).toEqual([...server.ALLOWED_EXTENSIONS].sort());
    expect(a.MAX_ATTACHMENT_BYTES).toBe(server.MAX_ATTACHMENT_BYTES);
    expect(a.SUPPORTED_TEXT).toBe(server.SUPPORTED_TEXT);
  });

  test("upload refusals show the server's reason (413 / 415 / 410), never internals", () => {
    expect(r.errorMessage(415, { message: "The file content is PDF, which does not match its .png extension." })).toMatch(/does not match/);
    expect(r.errorMessage(413, { message: "The file is larger than the 10 MB limit." })).toMatch(/10 MB/);
    expect(r.errorMessage(410, { message: "The stored file for this attachment is missing." })).toMatch(/missing/);
    expect(r.errorMessage(415, { message: "SELECT * FROM rfp_attachments" }, "Fallback")).toBe("Fallback");
    expect(r.errorMessage(500, { message: "The stored file failed its integrity check" }, "Fallback")).toBe("Fallback");
  });
});

describe("wiring", () => {
  const component = read("pages", "TRANSACTIONS", "RfpAttachments.jsx");

  test("files are fetched with the token and shown from blob URLs, never a plain server link", () => {
    expect(component).toMatch(/headers: authHeaders\(\)/);
    expect(component).toMatch(/URL\.createObjectURL/);
    expect(component).not.toMatch(/href=\{`?\$\{API_URL\}/);
    expect(component).not.toMatch(/dangerouslySetInnerHTML/);
  });

  test("the form queues files with a preview and uploads them after the RFP is saved", () => {
    const form = read("pages", "TRANSACTIONS", "RfpForm.jsx");
    expect(form).toMatch(/<AttachmentPicker/);
    expect(form).toMatch(/onSave\(form, \{ queued: .*removeIds \}\)/);
    const page = read("pages", "TRANSACTIONS", "RFP.jsx");
    expect(page).toMatch(/const failures = await syncAttachments\(r\.data\.id, attachments\);/);
    // uploads are multipart with no hand-set Content-Type
    expect(page).toMatch(/fd\.append\("file", file, file\.name\)/);
    expect(page).toMatch(/headers: authHeaders\(\), body: formData/);
  });

  test("the RFP view and the APV page show the documents", () => {
    expect(read("pages", "TRANSACTIONS", "RfpDetail.jsx")).toMatch(/<AttachmentsCard[\s\S]*listPath=\{rfpAttachmentsPath\(rfp\.id\)\}/);
    expect(read("pages", "TRANSACTIONS", "TransactionFormLayout.jsx")).toMatch(/code === "APV" && selectedTransaction\?\.id \? \(\s*<ApvSourceAttachments apvId=\{selectedTransaction\.id\} \/>/);
    expect(read("pages", "TRANSACTIONS", "ApvSourceAttachments.jsx")).toMatch(/apvAttachmentsPath\(apvId\)/);
  });
});
