// Populates permission_template_items for the 8 starter templates seeded
// by permission_templates_migration.sql. Run once after that migration
// (idempotent - INSERT IGNORE against the template_id+permission_id
// unique key, safe to re-run). Uses module_key/action matching rather
// than hardcoded IDs since permission IDs aren't stable across environments.
require("dotenv").config();
const pool = require("../db");

// Each entry: { template: name, match: (p) => boolean } - p is a row from
// the permissions catalog ({ module_key, action }).
const TEMPLATE_RULES = [
  {
    template: "Full Admin",
    match: (p) => !p.module_key.startsWith("ADMIN.") || p.module_key === "ADMIN.USER_SETTINGS" || p.module_key === "ADMIN.INVITATIONS",
  },
  {
    template: "Limited Admin",
    match: (p) => !p.module_key.startsWith("ADMIN."),
  },
  {
    template: "Senior Accountant",
    match: (p) =>
      p.module_key === "DASHBOARD" ||
      p.module_key.startsWith("TRANSACTIONS.") ||
      p.module_key.startsWith("LEDGER.") ||
      p.module_key === "POSTING" ||
      (p.module_key.startsWith("REPORTS.") && ["VIEW", "EXPORT"].includes(p.action)),
  },
  {
    template: "Accounts Receivable Accountant",
    match: (p) =>
      p.module_key === "DASHBOARD" ||
      p.module_key === "TRANSACTIONS.INVOICE" ||
      p.module_key === "TRANSACTIONS.OR" ||
      p.module_key === "LEDGER.SUBSIDIARY_LEDGER" ||
      p.module_key === "LEDGER.ACCOUNT_ANALYSIS" ||
      (p.module_key === "REPORTS.AR" && ["VIEW", "EXPORT"].includes(p.action)),
  },
  {
    template: "Accounts Payable Accountant",
    match: (p) =>
      p.module_key === "DASHBOARD" ||
      p.module_key === "TRANSACTIONS.APV" ||
      p.module_key === "TRANSACTIONS.CV" ||
      p.module_key === "LEDGER.SUBSIDIARY_LEDGER" ||
      p.module_key === "LEDGER.ACCOUNT_ANALYSIS" ||
      (p.module_key === "REPORTS.AP" && ["VIEW", "EXPORT"].includes(p.action)),
  },
  {
    template: "Reporting Only",
    match: (p) =>
      p.module_key === "DASHBOARD" ||
      (p.module_key.startsWith("REPORTS.") && ["VIEW", "EXPORT"].includes(p.action)) ||
      (p.module_key.startsWith("LEDGER.") && p.action === "VIEW"),
  },
  {
    template: "Bank Reconciliation User",
    match: (p) =>
      p.module_key === "DASHBOARD" ||
      p.module_key === "REPORTS.BANK_RECONCILIATION" ||
      (p.module_key === "REPORTS.AI_RECONCILIATION" && p.action === "VIEW"),
  },
  {
    template: "Read-Only Auditor",
    match: (p) => p.action === "VIEW",
  },
];

async function main() {
  const [permissions] = await pool.execute("SELECT id, module_key, action FROM permissions");
  const [templates] = await pool.execute("SELECT id, name FROM permission_templates");
  const templateByName = new Map(templates.map((t) => [t.name, t.id]));

  for (const rule of TEMPLATE_RULES) {
    const templateId = templateByName.get(rule.template);
    if (!templateId) {
      console.warn(`Template "${rule.template}" not found - skipping.`);
      continue;
    }

    const matched = permissions.filter(rule.match);
    for (const p of matched) {
      await pool.execute(
        `INSERT IGNORE INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)`,
        [templateId, p.id]
      );
    }
    console.log(`${rule.template}: ${matched.length} permission(s) seeded.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
