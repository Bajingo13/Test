// Jest setupFiles entry (jest.config.js) - runs before every test file.
//
// Maker-Checker Release 1 refuses "create as Posted" and self-posting. Many
// suites written before it post their own fixtures directly through the API;
// for those, the separation-of-duties checks are switched off - in the TEST
// environment only (lib/postingControl.js honours the flag only when
// NODE_ENV === "test"; production and development always enforce).
//
// Suites that test Maker-Checker itself set POSTING_SOD_TEST_BYPASS = "0" at
// the top of the file. A whole run can be forced to enforce everything with
// POSTING_SOD_FORCE_ENFORCE=1 (used to measure which legacy suites depend on
// direct posting).
if (process.env.POSTING_SOD_FORCE_ENFORCE === "1") {
  process.env.POSTING_SOD_TEST_BYPASS = "0";
} else {
  process.env.POSTING_SOD_TEST_BYPASS = "1";
}
