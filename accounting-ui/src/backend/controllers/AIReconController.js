const pool = require("../db");
const aiProvider = require("../services/ai");
const AgentActions = require("../services/BankReconAgentActions");
const { assertSessionAccess } = require("../services/bankReconAccessService");

// A conversation belongs to the user who started it (Super Admin may open
// any). Anyone else gets the same 404 as a conversation that doesn't exist.
async function loadOwnConversation(id, user, columns) {
  const [rows] = await pool.execute(`SELECT ${columns}, created_by AS createdBy FROM ai_recon_conversations WHERE id = ?`, [id]);
  const conv = rows[0];
  if (!conv) return null;
  if (user?.roleCode !== "SUPER_ADMIN" && Number(conv.createdBy) !== Number(user?.id)) return null;
  delete conv.createdBy;
  return conv;
}

// The session a conversation is linked to must still be one the user may
// open (company access can change after the conversation started).
async function accessibleSessionId(sessionId, user) {
  if (!sessionId) return null;
  try {
    await assertSessionAccess(sessionId, user);
    return sessionId;
  } catch {
    return null;
  }
}

exports.getStatus = async (req, res) => {
  res.json({
    configuredProvider: aiProvider.getConfiguredProvider(),
    anthropicKeyPresent: aiProvider.isAnthropicKeyPresent(),
  });
};

exports.createConversation = async (req, res) => {
  try {
    const [result] = await pool.execute(
      "INSERT INTO ai_recon_conversations(created_by) VALUES (?)",
      [req.user?.id || null]
    );

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("CREATE AI CONVERSATION ERROR:", err);
    res.status(500).json({ message: "Failed to start conversation" });
  }
};

exports.getConversation = async (req, res) => {
  try {
    const { id } = req.params;

    const conv = await loadOwnConversation(id, req.user, "id, session_id AS sessionId, title, created_at AS createdAt");

    if (!conv) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    conv.sessionId = await accessibleSessionId(conv.sessionId, req.user);

    const [messages] = await pool.execute(
      `SELECT id, role, content, tool_calls AS toolCalls, tool_results AS toolResults, created_at AS createdAt
       FROM ai_recon_messages WHERE conversation_id = ? ORDER BY id ASC`,
      [id]
    );

    res.json({ ...conv, messages });
  } catch (err) {
    console.error("GET AI CONVERSATION ERROR:", err);
    res.status(500).json({ message: "Failed to load conversation" });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: "message is required" });
    }

    const conv = await loadOwnConversation(id, req.user, "id, session_id AS sessionId");

    if (!conv) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    const convSessionId = await accessibleSessionId(conv.sessionId, req.user);

    const [priorRows] = await pool.execute(
      "SELECT role, content FROM ai_recon_messages WHERE conversation_id = ? ORDER BY id ASC",
      [id]
    );

    const providerMessages = priorRows.map((r) => ({
      role: r.role,
      content: r.content,
    }));
    providerMessages.push({ role: "user", content: String(message) });

    await pool.execute(
      "INSERT INTO ai_recon_messages(conversation_id, role, content) VALUES (?, 'user', ?)",
      [id, String(message)]
    );

    // Every agent action in this turn runs as req.user (session guard +
    // Bank Reconciliation VIEW/CREATE permissions - see BankReconAgentActions).
    const result = await AgentActions.runAs(req.user, () =>
      aiProvider.processTurn({
        messages: providerMessages,
        sessionId: convSessionId,
        user: req.user,
      })
    );

    await pool.execute(
      "INSERT INTO ai_recon_messages(conversation_id, role, content) VALUES (?, 'assistant', ?)",
      [id, result.replyText]
    );

    if (result.sessionId && result.sessionId !== conv.sessionId) {
      await pool.execute("UPDATE ai_recon_conversations SET session_id = ? WHERE id = ?", [
        result.sessionId,
        id,
      ]);
    }

    res.json({
      success: true,
      reply: result.replyText,
      sessionId: result.sessionId,
      mode: result.mode,
      fallbackReason: result.fallbackReason || null,
    });
  } catch (err) {
    // Refusals from the agent guard (403 permission, 404 out-of-scope
    // session, 400 missing company) are answered as such, not as a 500.
    if (err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    console.error("SEND AI MESSAGE ERROR:", err);
    res.status(500).json({ message: "Failed to process message" });
  }
};
