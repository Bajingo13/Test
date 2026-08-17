const { BapExchangeRateProvider } = require("./bapProvider");
const { BspExchangeRateProvider } = require("./bspProvider");
const { ManualExchangeRateProvider } = require("./manualProvider");
const { FixedExchangeRateProvider } = require("./fixedProvider");
const { ExternalExchangeRateProvider } = require("./externalProvider");

// Single registry so the resolver (and anything else) looks providers up
// by code instead of importing each class directly - adding a new
// provider later means adding one line here, not touching the resolver's
// priority logic.
const PROVIDERS = {
  BAP: new BapExchangeRateProvider(),
  BSP: new BspExchangeRateProvider(),
  MANUAL: new ManualExchangeRateProvider(),
  FIXED: new FixedExchangeRateProvider(),
  EXTERNAL: new ExternalExchangeRateProvider(),
};

function getProvider(code) {
  const provider = PROVIDERS[String(code || "").toUpperCase()];
  if (!provider) throw new Error(`Unknown exchange rate provider: ${code}`);
  return provider;
}

module.exports = { PROVIDERS, getProvider };
