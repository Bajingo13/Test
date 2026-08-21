module.exports = {
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/src/backend/**/__tests__/**/*.test.js",
    // Phase 7B: pure-function frontend logic tests (voucherToolbarRules.js -
    // no JSX, no ESM import/export, so no babel/jsdom transform is needed
    // to run it under this same node-environment Jest config).
    "<rootDir>/src/pages/TRANSACTIONS/__tests__/**/*.test.js",
  ],
};
