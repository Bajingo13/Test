// Prints a bcrypt hash for a password you supply, e.g. to set a user's
// password by hand. The password is never hardcoded, passed as an argument
// (shell history) or printed.
//
// Usage:
//   node generateHash.js                        (prompts, input not echoed)
//   GENERATE_HASH_PASSWORD=... node generateHash.js
//   some-command | node generateHash.js

const { Writable } = require("stream");
const readline = require("readline");
const bcrypt = require("bcryptjs");

function promptHidden() {
  return new Promise((resolve) => {
    const muted = new Writable({ write: (chunk, enc, cb) => cb() });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stderr.write("Password: ");
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function readPiped() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, "");
}

async function readPassword() {
  if (process.env.GENERATE_HASH_PASSWORD) return process.env.GENERATE_HASH_PASSWORD;
  return process.stdin.isTTY ? promptHidden() : readPiped();
}

readPassword().then(async (password) => {
  if (!password) {
    console.error("No password given.");
    process.exitCode = 1;
    return;
  }
  console.log("Hash:", await bcrypt.hash(password, 10));
});
