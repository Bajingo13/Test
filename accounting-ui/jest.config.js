module.exports = {
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/src/backend/**/__tests__/**/*.test.js",
    // Phase 7B: pure-function frontend logic tests (voucherToolbarRules.js -
    // no JSX, no ESM import/export, so no babel/jsdom transform is needed
    // to run it under this same node-environment Jest config).
    "<rootDir>/src/pages/TRANSACTIONS/__tests__/**/*.test.js",
    // Phase 1 print-completeness checkpoint: amountInWords.js is a pure
    // function too, but (unlike voucherToolbarRules.js) uses real ESM
    // import/export syntax to match the rest of src/print/pdf/ (which Vite
    // transforms at build time). src/print/pdf/package.json marks that one
    // directory "type": "module" so Node's native ESM loader (enabled here
    // via the existing --experimental-vm-modules flag already on the
    // test/test:integration npm scripts - not a new dependency) can load it
    // directly, with no babel/transform step and no new package installed.
    "<rootDir>/src/print/pdf/__tests__/**/*.test.js",
    // Phase 5: shared pure-function utilities (dateRangeFilter.mjs) reused
    // across multiple pages (TRANSACTIONS, FILESETUP) - same real-ESM
    // dynamic-import pattern as transactionListFilters.test.js above.
    "<rootDir>/src/utils/__tests__/**/*.test.js",
  ],
};
