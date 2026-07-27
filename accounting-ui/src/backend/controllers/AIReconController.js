const pool = require("../db");
const aiProvider = require("../services/ai");

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

    const [convRows] = await pool.execute(
      "SELECT id, session_id AS sessionId, title, created_at AS createdAt FROM ai_recon_conversations WHERE id = ?",
      [id]
    );

    if (convRows.length === 0) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const [messages] = await pool.execute(
      `SELECT id, role, content, tool_calls AS toolCalls, tool_results AS toolResults, created_at AS createdAt
       FROM ai_recon_messages WHERE conversation_id = ? ORDER BY id ASC`,
      [id]
    );

    res.json({ ...convRows[0], messages });
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

    const [convRows] = await pool.execute(
      "SELECT id, session_id AS sessionId FROM ai_recon_conversations WHERE id = ?",
      [id]
    );

    if (convRows.length === 0) {
      return res.status(404).json({ message: "Conversation not found" });
    }

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

    const result = await aiProvider.processTurn({
      messages: providerMessages,
      sessionId: convRows[0].sessionId,
      user: req.user,
    });

    await pool.execute(
      "INSERT INTO ai_recon_messages(conversation_id, role, content) VALUES (?, 'assistant', ?)",
      [id, result.replyText]
    );

    if (result.sessionId && result.sessionId !== convRows[0].sessionId) {
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
    console.error("SEND AI MESSAGE ERROR:", err);
    res.status(500).json({ message: "Failed to process message" });
  }
};
