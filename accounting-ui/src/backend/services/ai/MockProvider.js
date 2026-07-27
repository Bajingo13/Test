// Deterministic dispatcher for AI_PROVIDER=mock (and =local, currently an
// alias - see index.js). No network calls, no API key required. Parses the
// prompt with PromptParser's regex/keyword rules, calls the exact same
// backend actions the Anthropic provider and the manual UI use, and
// formats the reply from string templates. Never invents a number that
// didn't come back from an action call.
const actions = require("../BankReconAgentActions");
const { parsePrompt, INTENTS } = require("../PromptParser");

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function bankLabel(session) {
  return `${session.bankCode} - ${session.bankName}${
    session.bankAccountNo ? ` (${session.bankAccountNo})` : ""
  }`;
}

function needSessionReply() {
  return {
    replyText:
      'I don\'t have an active reconciliation session in this conversation yet. Ask me to generate one first, e.g. "Generate the reconciliation for <bank> for <month> <year>".',
    sessionId: null,
  };
}

async function resolveSessionInput(params) {
  const input = { bankAccountId: params.bankAccountId };
  let usedDefaultPeriod = false;

  if (params.periodEnd) {
    const [y, m] = params.periodEnd.split("-");
    input.month = Number(m);
    input.year = Number(y);
  } else if (params.month && params.year) {
    input.month = params.month;
    input.year = params.year;
  } else {
    const today = new Date();
    input.month = today.getUTCMonth() + 1;
    input.year = today.getUTCFullYear();
    usedDefaultPeriod = true;
  }

  if (params.dateToleranceDays) input.dateToleranceDays = params.dateToleranceDays;
  if (params.amountVarianceType) input.amountVarianceType = params.amountVarianceType;
  if (params.amountVarianceValue !== null && params.amountVarianceValue !== undefined) {
    input.amountVarianceValue = params.amountVarianceValue;
  }

  return { input, usedDefaultPeriod };
}

async function handleGenerate(params, user) {
  if (!params.bankAccountId) {
    const accounts = await actions.listBankAccounts();
    return {
      replyText: `Which bank account? I have: ${accounts
        .map((a) => `${a.bankCode} - ${a.bankName}`)
        .join(", ")}.`,
      sessionId: null,
    };
  }

  const { input, usedDefaultPeriod } = await resolveSessionInput(params);
  const { created, session } = await actions.findOrCreateSession(input, user);
  await actions.runMatchingForSession(session.id, user);
  const { summary } = await actions.getSessionSummary(session.id);

  const lines = [
    `${created ? "Created" : "Found"} reconciliation session #${session.id} for ${bankLabel(
      session
    )}, period ${session.periodStart} to ${session.periodEnd}.`,
  ];

  if (usedDefaultPeriod) {
    lines.push("(No period was specified, so I used the current month - name a specific month if that's wrong.)");
  }

  lines.push(
    `Statement ending balance: ₱ ${formatMoney(summary.statementEndingBalance)}. Book balance: ₱ ${formatMoney(
      summary.bookBalance
    )}.`
  );
  lines.push(
    `Outstanding checks: ₱ ${formatMoney(summary.outstandingChecksTotal)} (${
      summary.outstandingChecks.length
    }). Deposits in transit: ₱ ${formatMoney(summary.depositsInTransitTotal)} (${
      summary.depositsInTransit.length
    }).`
  );
  lines.push(
    `Adjusted bank balance: ₱ ${formatMoney(summary.adjustedBank)}. Difference: ₱ ${formatMoney(
      summary.difference
    )}.`
  );
  lines.push(
    summary.canFinalizeCleanly
      ? "Status: BALANCED and ready to finalize."
      : `Status: NOT balanced yet - ${summary.pendingAdjustmentsCount} pending adjustment(s), ${summary.unresolvedStatementLinesCount} unresolved statement line(s). Open the workspace to review and confirm matches.`
  );

  return { replyText: lines.join("\n"), sessionId: session.id };
}

async function handleOutstanding(params, kind) {
  if (!params.sessionId) return needSessionReply();

  const { outstandingChecks, depositsInTransit } = await actions.getOutstandingItems(
    params.sessionId
  );
  const list = kind === "checks" ? outstandingChecks : depositsInTransit;
  const label = kind === "checks" ? "Outstanding checks" : "Deposits in transit";

  if (list.length === 0) {
    return {
      replyText: `No ${label.toLowerCase()} for session #${params.sessionId}.`,
      sessionId: params.sessionId,
    };
  }

  const total = list.reduce((sum, i) => sum + Number(i.amount), 0);
  const lines = list.map(
    (i) => `${i.sourceType} ${i.voucherNo} - ${i.payeeOrCustomer} - ${i.date} - ₱ ${formatMoney(i.amount)}`
  );

  return {
    replyText: `${label} for session #${params.sessionId} (${list.length}, total ₱ ${formatMoney(
      total
    )}):\n${lines.join("\n")}`,
    sessionId: params.sessionId,
  };
}

async function handleLowConfidence(params) {
  if (!params.sessionId) return needSessionReply();

  const threshold = params.confidenceThreshold || 90;
  const rows = await actions.getLowConfidenceLines(params.sessionId, threshold);

  if (rows.length === 0) {
    return {
      replyText: `No pending suggested matches below ${threshold}% confidence in session #${params.sessionId}.`,
      sessionId: params.sessionId,
    };
  }

  const lines = rows.map(
    (r) =>
      `Line #${r.statementLineId} (${r.txnDate}, ${r.description}) -> ${r.bookSourceType} #${r.bookSourceId}, ₱ ${formatMoney(
        r.amount
      )}, ${r.confidenceScore}% confidence`
  );

  return {
    replyText: `${rows.length} suggested match(es) below ${threshold}% confidence:\n${lines.join("\n")}`,
    sessionId: params.sessionId,
  };
}

async function handleAdjustments(params) {
  if (!params.sessionId) return needSessionReply();

  let rows = await actions.listAdjustments(params.sessionId);
  rows = rows.filter((a) => a.status !== "REJECTED");

  if (params.amountThreshold) {
    rows = rows.filter(
      (a) => !(a.adjustmentType === "BANK_CHARGE" && Number(a.amount) < params.amountThreshold)
    );
  }

  if (rows.length === 0) {
    return {
      replyText: `No adjustment suggestions to review for session #${params.sessionId}.`,
      sessionId: params.sessionId,
    };
  }

  const lines = rows.map(
    (a) => `#${a.id} ${a.adjustmentType} ₱ ${formatMoney(a.amount)} (${a.status}) - ${a.description || "no description"}`
  );

  return {
    replyText: `Suggested adjusting entries for session #${params.sessionId} (never posted automatically - approve and post from the workspace):\n${lines.join(
      "\n"
    )}`,
    sessionId: params.sessionId,
  };
}

async function handleExplainUnbalanced(params) {
  if (!params.sessionId) return needSessionReply();

  const { session, summary } = await actions.getSessionSummary(params.sessionId);

  if (summary.canFinalizeCleanly) {
    return {
      replyText: `Session #${params.sessionId} is balanced - difference is ₱0.00.`,
      sessionId: params.sessionId,
    };
  }

  const lines = [`Session #${params.sessionId} (${bankLabel(session)}) is not fully reconciled:`];
  lines.push(`- Difference between adjusted bank and book balance: ₱ ${formatMoney(summary.difference)}`);
  if (summary.unresolvedStatementLinesCount > 0) {
    lines.push(`- ${summary.unresolvedStatementLinesCount} statement line(s) still unmatched or awaiting your review`);
  }
  if (summary.pendingAdjustmentsCount > 0) {
    lines.push(`- ${summary.pendingAdjustmentsCount} adjustment suggestion(s) awaiting approval`);
  }
  if (summary.outstandingChecks.length > 0) {
    lines.push(
      `- ${summary.outstandingChecks.length} outstanding check(s) totaling ₱ ${formatMoney(
        summary.outstandingChecksTotal
      )}`
    );
  }
  if (summary.depositsInTransit.length > 0) {
    lines.push(
      `- ${summary.depositsInTransit.length} deposit(s) in transit totaling ₱ ${formatMoney(
        summary.depositsInTransitTotal
      )}`
    );
  }
  lines.push("Resolve these in the workspace, then re-run to check again.");

  return { replyText: lines.join("\n"), sessionId: params.sessionId };
}

async function handleRerunTolerance(params, user) {
  if (!params.sessionId) return needSessionReply();

  const updateInput = {};
  if (params.dateToleranceDays !== null) updateInput.dateToleranceDays = params.dateToleranceDays;
  if (params.amountVarianceType) updateInput.amountVarianceType = params.amountVarianceType;
  if (params.amountVarianceValue !== null && params.amountVarianceValue !== undefined) {
    updateInput.amountVarianceValue = params.amountVarianceValue;
  }

  const next = await actions.updateSessionTolerance(params.sessionId, updateInput, user);
  const { processed, suggested } = await actions.runMatchingForSession(params.sessionId, user);

  const varianceLabel =
    next.amountVarianceType === "PERCENT"
      ? `${next.amountVarianceValue}%`
      : `₱ ${formatMoney(next.amountVarianceValue)}`;

  return {
    replyText: `Updated session #${params.sessionId}: ${next.dateToleranceDays}-day tolerance, ${varianceLabel} variance. Re-ran matching: ${processed} line(s) processed, ${suggested} now have suggested matches.`,
    sessionId: params.sessionId,
  };
}

// Gated by parsePrompt's own regex ("confirm all exact") - this is only
// reached when the user's own message was that explicit imperative.
async function handleConfirmAllExact(params, user) {
  if (!params.sessionId) return needSessionReply();

  const { confirmedCount } = await actions.bulkConfirmExact(params.sessionId, user);

  return {
    replyText: `Confirmed ${confirmedCount} exact match(es) in session #${params.sessionId}.`,
    sessionId: params.sessionId,
  };
}

function handleUnknown() {
  return {
    replyText: [
      "I can help with things like:",
      '- "Generate the bank reconciliation for <bank> as of <date>"',
      '- "Show outstanding checks" / "Show deposits in transit"',
      '- "Show transactions with confidence below 90%"',
      '- "Generate adjusting journal entries"',
      '- "Explain why reconciliation is not balanced"',
      '- "Match transactions within 3 days and allow a ₱1.00 variance"',
      '- "Confirm all exact matches"',
    ].join("\n"),
    sessionId: null,
  };
}

async function processTurn({ messages, sessionId, user }) {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "";

  const bankAccounts = await actions.listBankAccounts();
  const { intent, params } = parsePrompt(text, { bankAccounts, sessionId });

  let result;
  switch (intent) {
    case INTENTS.GENERATE:
      result = await handleGenerate(params, user);
      break;
    case INTENTS.OUTSTANDING_CHECKS:
      result = await handleOutstanding(params, "checks");
      break;
    case INTENTS.DEPOSITS_IN_TRANSIT:
      result = await handleOutstanding(params, "deposits");
      break;
    case INTENTS.LOW_CONFIDENCE:
      result = await handleLowConfidence(params);
      break;
    case INTENTS.ADJUSTING_ENTRIES:
      result = await handleAdjustments(params);
      break;
    case INTENTS.EXPLAIN_UNBALANCED:
      result = await handleExplainUnbalanced(params);
      break;
    case INTENTS.RERUN_TOLERANCE:
      result = await handleRerunTolerance(params, user);
      break;
    case INTENTS.CONFIRM_ALL_EXACT:
      result = await handleConfirmAllExact(params, user);
      break;
    default:
      result = handleUnknown();
  }

  return { ...result, mode: "mock" };
}

module.exports = { processTurn };
