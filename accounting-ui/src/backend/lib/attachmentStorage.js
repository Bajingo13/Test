const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Private file store for supporting documents. The project had no file
// storage before this (every upload was parsed in memory and discarded), so
// this is the one place file bytes are kept.
//
// - Location: ATTACHMENT_STORAGE_DIR, else accounting-ui/storage/attachments
//   (git-ignored; outside dist/ and public/, so express.static never serves
//   it). Tests default to a temp directory. In production this directory
//   must be on persistent storage (e.g. a Railway volume) - a container's own
//   filesystem is reset on every deploy.
// - Keys are generated here ("rfp/<companyId>/<uuid>") and never contain any
//   part of the uploaded filename. Every key is checked against that exact
//   shape and the resolved path must stay inside the root, so nothing a
//   client sends can reach another path.
// - Files are written to a temp name and renamed, so a half-written file is
//   never visible under its key.
//
// The interface (put / read / remove by key) is all callers use, so a
// cloud object store can replace this module without touching them.

const KEY_PATTERN = /^rfp\/[1-9][0-9]{0,9}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function storageRoot() {
  if (process.env.ATTACHMENT_STORAGE_DIR) return path.resolve(process.env.ATTACHMENT_STORAGE_DIR);
  if (process.env.NODE_ENV === "test") return path.join(os.tmpdir(), "astrea-attachments-test");
  return path.resolve(__dirname, "..", "..", "..", "storage", "attachments");
}

function newKey(companyId) {
  const id = Number(companyId);
  if (!Number.isInteger(id) || id < 1) throw new Error("A company is required for an attachment key.");
  return `rfp/${id}/${crypto.randomUUID()}`;
}

function pathFor(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) throw new Error("Invalid attachment storage key.");
  const root = storageRoot();
  const full = path.resolve(root, ...key.split("/"));
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid attachment storage key.");
  return full;
}

async function put(key, buffer) {
  const full = pathFor(key);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  const temp = `${full}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.promises.writeFile(temp, buffer, { flag: "wx", mode: 0o600 });
  try {
    // A key is a fresh random UUID, so nothing already exists under it.
    await fs.promises.rename(temp, full);
  } catch (err) {
    await fs.promises.unlink(temp).catch(() => {});
    throw err;
  }
}

async function read(key) {
  return fs.promises.readFile(pathFor(key));
}

async function remove(key) {
  await fs.promises.unlink(pathFor(key)).catch((err) => {
    if (err.code !== "ENOENT") throw err;
  });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = { storageRoot, newKey, put, read, remove, sha256, KEY_PATTERN };
