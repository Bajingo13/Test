// Provider selection: AI_PROVIDER=mock|anthropic|local (default: mock).
//
// "local" is currently an alias for the same deterministic engine as
// "mock" - no local-LLM endpoint/protocol was specified for this project,
// so this is an honest placeholder for a future real integration (e.g.
// Ollama) rather than a fabricated one.
//
// When AI_PROVIDER=anthropic and the call fails for any reason (network,
// no credits, bad key, refusal, etc.), we fall back to the deterministic
// engine automatically instead of failing the request - the user still
// gets a working answer, just without the natural-language flexibility.
function getConfiguredProvider() {
  return (process.env.AI_PROVIDER || "mock").toLowerCase();
}

function isAnthropicKeyPresent() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function processTurn({ messages, sessionId, user }) {
  const configured = getConfiguredProvider();

  if (configured === "anthropic") {
    try {
      const anthropicProvider = require("./AnthropicProvider");
      const result = await anthropicProvider.processTurn({ messages, user });
      return result;
    } catch (err) {
      console.error("ANTHROPIC PROVIDER UNAVAILABLE, FALLING BACK TO RULE-BASED MODE:", err.message);
      const mockProvider = require("./MockProvider");
      const result = await mockProvider.processTurn({ messages, sessionId, user });
      return { ...result, mode: "fallback", fallbackReason: err.message };
    }
  }

  const mockProvider = require("./MockProvider");
  const result = await mockProvider.processTurn({ messages, sessionId, user });
  return { ...result, mode: configured === "local" ? "local" : "mock" };
}

module.exports = { processTurn, getConfiguredProvider, isAnthropicKeyPresent };
