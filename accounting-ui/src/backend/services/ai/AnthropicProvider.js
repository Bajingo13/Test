// AI_PROVIDER=anthropic: Claude drives the same actions the mock provider
// and the manual UI use (BankReconAgentActions) via the SDK's Tool Runner.
// Claude never decides a match or computes a number itself - it only calls
// tools that run the existing deterministic engine and narrates the result.
//
// The Anthropic client is constructed lazily (inside getClient(), not at
// module load) so requiring this file never fails without an API key -
// only actually calling processTurn() does. That's what lets AI_PROVIDER
// stay unset/mock in dev with zero Anthropic dependency.
const { betaZodTool } = require("@anthropic-ai/sdk/helpers/beta/zod");
const { z } = require("zod");
const actions = require("../BankReconAgentActions");
const { todayIso } = require("../PromptParser");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    const Anthropic = require("@anthropic-ai/sdk");
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cachedClient;
}

function buildTools(touched, user) {
  const listBankAccounts = betaZodTool({
    name: "listBankAccounts",
    description:
      "List the company's active bank accounts (bank code, bank name, account number) so you can figure out which account a phrase like 'BDO Account 001' or 'BPI Payroll Account' refers to.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await actions.listBankAccounts()),
  });

  const findOrCreateSession = betaZodTool({
    name: "findOrCreateSession",
    description:
      "Find the existing reconciliation session for a bank account + period, or create one if none exists yet. Provide either periodStart+periodEnd (YYYY-MM-DD) or month+year.",
    inputSchema: z.object({
      bankAccountId: z.number(),
      periodStart: z.string().optional(),
      periodEnd: z.string().optional(),
      month: z.number().optional(),
      year: z.number().optional(),
      dateToleranceDays: z.number().optional(),
      amountVarianceType: z.enum(["FIXED", "PERCENT"]).optional(),
      amountVarianceValue: z.number().optional(),
    }),
    run: async (input) => {
      const result = await actions.findOrCreateSession(input, user);
      touched.sessionId = result.session.id;
      return JSON.stringify(result);
    },
  });

  const getSessionSummary = betaZodTool({
    name: "getSessionSummary",
    description:
      "Get the reconciliation summary for a session: statement/book balance, outstanding checks, deposits in transit, adjusted balances, difference, and whether it's ready to finalize.",
    inputSchema: z.object({ sessionId: z.number() }),
    run: async (input) => {
      touched.sessionId = input.sessionId;
      return JSON.stringify(await actions.getSessionSummary(input.sessionId));
    },
  });

  const getOutstandingItems = betaZodTool({
    name: "getOutstandingItems",
    description: "Get outstanding checks and deposits in transit for a session.",
    inputSchema: z.object({ sessionId: z.number() }),
    run: async (input) => {
      touched.sessionId = input.sessionId;
      return JSON.stringify(await actions.getOutstandingItems(input.sessionId));
    },
  });

  const listAdjustments = betaZodTool({
    name: "listAdjustments",
    description:
      "List proposed adjusting entries (bank charges, interest income, unexplained items) for a session. These are suggestions only - never posted automatically.",
    inputSchema: z.object({ sessionId: z.number() }),
    run: async (input) => {
      touched.sessionId = input.sessionId;
      return JSON.stringify(await actions.listAdjustments(input.sessionId));
    },
  });

  const getLowConfidenceLines = betaZodTool({
    name: "getLowConfidenceLines",
    description: "List pending suggested matches below a given confidence percentage.",
    inputSchema: z.object({ sessionId: z.number(), thresholdPercent: z.number() }),
    run: async (input) => {
      touched.sessionId = input.sessionId;
      return JSON.stringify(
        await actions.getLowConfidenceLines(input.sessionId, input.thresholdPercent)
      );
    },
  });

  const runMatching = betaZodTool({
    name: "runMatching",
    description:
      "Run the deterministic matching engine against a session's unresolved statement lines. Safe to call repeatedly - only PENDING suggestions are recomputed.",
    inputSchema: z.object({ sessionId: z.number() }),
    run: async (input) => {
      touched.sessionId = input.sessionId;
      return JSON.stringify(await actions.runMatchingForSession(input.sessionId, user));
    },
  });

  const updateSessionTolerance = betaZodTool({
    name: "updateSessionTolerance",
    description:
      "Update a session's date tolerance (days) and/or amount variance, then you should call runMatching to re-score with the new settings. Never touches statement balances.",
    inputSchema: z.object({
      sessionId: z.number(),
      dateToleranceDays: z.number().optional(),
      amountVarianceType: z.enum(["FIXED", "PERCENT"]).optional(),
      amountVarianceValue: z.number().optional(),
    }),
    run: async (input) => {
      touched.sessionId = input.sessionId;
      const { sessionId, ...rest } = input;
      return JSON.stringify(await actions.updateSessionTolerance(sessionId, rest, user));
    },
  });

  const confirmMatch = betaZodTool({
    name: "confirmMatch",
    description:
      "Confirm one specific PENDING match by its match ID. Only call this when the user explicitly told you to confirm a match (an imperative instruction), never on your own initiative.",
    inputSchema: z.object({ matchId: z.number() }),
    run: async (input) => {
      const result = await actions.confirmMatch(input.matchId, user);
      return JSON.stringify(result);
    },
  });

  const bulkConfirmExact = betaZodTool({
    name: "bulkConfirmExact",
    description:
      "Confirm every PENDING EXACT-type match in a session at once. Only call this when the user explicitly said something like 'confirm all exact matches' - never on your own initiative.",
    inputSchema: z.object({ sessionId: z.number() }),
    run: async (input) => {
      touched.sessionId = input.sessionId;
      return JSON.stringify(await actions.bulkConfirmExact(input.sessionId, user));
    },
  });

  return [
    listBankAccounts,
    findOrCreateSession,
    getSessionSummary,
    getOutstandingItems,
    listAdjustments,
    getLowConfidenceLines,
    runMatching,
    updateSessionTolerance,
    confirmMatch,
    bulkConfirmExact,
  ];
}

function buildSystemPrompt() {
  return `You are the AI Reconciliation Assistant for a Philippine BIR-compliant accounting system's Bank Reconciliation module.

Today's date is ${todayIso()}.

You help an accountant drive an already-built, fully deterministic reconciliation engine through conversation, and explain its results in plain language. You never invent a match, a balance, or a number - every figure you state must come from a tool result you actually received this conversation. If a tool hasn't given you a number, say you don't have it yet rather than estimating.

Your tools are read-only or safely-reversible staging actions, plus two conditional ones (confirmMatch, bulkConfirmExact) that you may only call when the user's own message is an explicit imperative to confirm a match - never proactively. You cannot post a journal entry, finalize a reconciliation, or reopen one under any phrasing - those always require the accountant's own click in the workspace UI. If asked to do one of those, explain that you can get the session ready but the actual post/finalize step needs their approval in the workspace.

When the user names a bank account in natural language ("BDO Account 001", "BPI Payroll Account"), call listBankAccounts and pick the best match yourself. When they name a period ("July 2026", "as of July 31, 2026"), pass month+year or periodStart+periodEnd to findOrCreateSession as fits their phrasing.

Keep replies concise and concrete: state the number, the bucket it's in, and (when relevant) why.

Only your final text reply is kept in this conversation's history, not the tool calls behind it - so whenever you create or work with a reconciliation session, state its session ID explicitly in your reply (e.g. "session #12"), even if that feels redundant.`;
}

async function processTurn({ messages, user }) {
  const client = getClient();
  const touched = {};
  const tools = buildTools(touched, user);

  const finalMessage = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive" },
    tools,
    messages,
  });

  if (finalMessage.stop_reason === "refusal") {
    return {
      replyText:
        "I can't help with that request. If you think this is a mistake, try rephrasing, or use the workspace UI directly.",
      sessionId: touched.sessionId || null,
      mode: "anthropic",
    };
  }

  const replyText = finalMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return {
    replyText: replyText || "(no response text)",
    sessionId: touched.sessionId || null,
    mode: "anthropic",
  };
}

module.exports = { processTurn };
