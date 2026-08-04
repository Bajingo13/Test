const pool = require("../db");
const { HttpError } = require("../lib/httpError");

const SUPPORTED_MODULE_TYPES = ["invoice", "apv", "jv", "po", "or", "cv"];
const MODULES_WITHOUT_PARTY = new Set(["jv"]);
const SUPPORTED_FREQUENCIES = [
  "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "BIMONTHLY",
  "QUARTERLY", "SEMIANNUAL", "ANNUAL", "CUSTOM",
];
const SUPPORTED_DATE_ADJUSTMENT_RULES = [
  "KEEP_ORIGINAL", "NEXT_BUSINESS_DAY", "PREVIOUS_BUSINESS_DAY", "LAST_VALID_DAY", "SKIP",
];
const SUPPORTED_AMOUNT_MODES = [
  "FIXED", "COPY_LAST", "MANUAL_REVIEW", "PERCENTAGE_ADJUSTMENT", "ESCALATION",
];

function isBalanced(lines) {
  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  return Math.abs(totalDebit - totalCredit) < 0.01;
}

// Validates template + schedule input before saving (create/update). Does
// NOT touch the database - pure structural/business-rule validation.
function validateTemplateInput({ moduleType, templateName, partyId, lines, schedule }) {
  if (!SUPPORTED_MODULE_TYPES.includes(moduleType)) {
    throw new HttpError(400, `Unsupported transaction type for recurring: ${moduleType}`);
  }
  if (!templateName || !templateName.trim()) {
    throw new HttpError(400, "Template name is required.");
  }
  if (!MODULES_WITHOUT_PARTY.has(moduleType) && !partyId) {
    throw new HttpError(400, "A customer or supplier is required for this transaction type.");
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new HttpError(400, "At least one account line is required.");
  }
  for (const line of lines) {
    if (!line.accountId) {
      throw new HttpError(400, "Every line must reference a valid account.");
    }
    if (!(Number(line.debit) > 0) && !(Number(line.credit) > 0)) {
      throw new HttpError(400, "Every line must have a debit or credit amount.");
    }
  }
  if (!isBalanced(lines)) {
    throw new HttpError(400, "Template lines must balance - total debit must equal total credit.");
  }

  if (!schedule) {
    throw new HttpError(400, "A recurrence schedule is required.");
  }
  if (!SUPPORTED_FREQUENCIES.includes(schedule.frequency)) {
    throw new HttpError(400, `Unsupported recurrence frequency: ${schedule.frequency}`);
  }
  if (schedule.dateAdjustmentRule && !SUPPORTED_DATE_ADJUSTMENT_RULES.includes(schedule.dateAdjustmentRule)) {
    throw new HttpError(400, `Unsupported date adjustment rule: ${schedule.dateAdjustmentRule}`);
  }
  if (!schedule.startDate) {
    throw new HttpError(400, "A start date is required.");
  }
  if (schedule.endDate && schedule.endDate < schedule.startDate) {
    throw new HttpError(400, "End date must be after the start date.");
  }
  if (schedule.maxOccurrences !== undefined && schedule.maxOccurrences !== null && Number(schedule.maxOccurrences) <= 0) {
    throw new HttpError(400, "Maximum occurrences must be greater than zero.");
  }
  if (schedule.frequency === "WEEKLY" || schedule.frequency === "BIWEEKLY") {
    if (schedule.weekday === undefined || schedule.weekday === null) {
      throw new HttpError(400, "A weekday is required for weekly recurrence.");
    }
  }
  if (schedule.frequency === "CUSTOM") {
    if (!["DAYS", "WEEKS", "MONTHS", "YEARS"].includes(schedule.customUnit)) {
      throw new HttpError(400, "A valid custom interval unit is required (days/weeks/months/years).");
    }
  }

  const amountMode = schedule.amountMode || "FIXED";
  if (!SUPPORTED_AMOUNT_MODES.includes(amountMode)) {
    throw new HttpError(400, `Unsupported amount mode: ${amountMode}`);
  }
}

// Re-validates master data immediately before generating an occurrence -
// stored template data can go stale between save and generation (party
// deactivated, account deleted). Must run inside the generation
// transaction (pass the active `conn`) so it sees a consistent snapshot.
async function revalidateForGeneration(conn, { moduleType, partyId, lines }) {
  if (!MODULES_WITHOUT_PARTY.has(moduleType) && partyId) {
    const [partyRows] = await conn.execute(
      "SELECT id, status FROM general_libraries WHERE id = ?",
      [partyId]
    );
    if (partyRows.length === 0) {
      throw new HttpError(422, "The customer/supplier on this template no longer exists.");
    }
    if (partyRows[0].status !== "ACTIVE") {
      throw new HttpError(422, "The customer/supplier on this template is no longer active.");
    }
  }

  for (const line of lines) {
    const [acctRows] = await conn.execute(
      "SELECT id FROM chart_of_accounts WHERE id = ?",
      [line.account_id]
    );
    if (acctRows.length === 0) {
      throw new HttpError(422, `Account ${line.account_code || line.account_id} on this template no longer exists.`);
    }
  }

  if (!isBalanced(lines.map((l) => ({ debit: l.debit, credit: l.credit })))) {
    throw new HttpError(422, "Template lines are no longer balanced - cannot generate.");
  }
}

module.exports = {
  SUPPORTED_MODULE_TYPES,
  MODULES_WITHOUT_PARTY,
  SUPPORTED_FREQUENCIES,
  SUPPORTED_DATE_ADJUSTMENT_RULES,
  SUPPORTED_AMOUNT_MODES,
  isBalanced,
  validateTemplateInput,
  revalidateForGeneration,
};
