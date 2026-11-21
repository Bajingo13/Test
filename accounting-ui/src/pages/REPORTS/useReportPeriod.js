import { useState } from "react";
import { AS_OF, RANGE, resolvePeriod, validatePeriod } from "./reportPeriod.mjs";
import { withBranch } from "./reportBranch.mjs";
import useReportBranch from "./useReportBranch";

// The Range / Date-As-Of selection for one report page. `apply()` validates
// the inputs and returns the snapshot to request (null when invalid); labels
// and exports read `applied`, so a date edited after generating can never
// relabel the report still on screen.
//
// fromDate / toDate / asOfDate are the applied dates once a report has been
// generated, otherwise the dates currently selected.
export default function useReportPeriod({ defaultMode = RANGE, defaultFrom, defaultTo, asOfStart = "beginning" } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  const [mode, setModeState] = useState(defaultMode);
  const [from, setFrom] = useState(defaultFrom ?? `${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(defaultTo ?? today);
  const [asOf, setAsOf] = useState(defaultTo ?? today);
  const [attempted, setAttempted] = useState(false);
  const [applied, setApplied] = useState(null);
  // Multi-Branch Phase C-2A: the Branch selector. The applied snapshot carries
  // the branch (params.branch), so every page that requests with
  // applied.params / periodModeQuery(applied) sends it - and the label shows it.
  const branch = useReportBranch();

  const problem = validatePeriod({ mode, from, to, asOf });
  const current = problem ? null : resolvePeriod({ mode, from, to, asOf }, { asOfStart });
  const dates = applied || current || { fromDate: from, toDate: mode === AS_OF ? asOf : to, asOfDate: mode === AS_OF ? asOf : to };

  function setMode(next) {
    setModeState(next);
    setAttempted(false);
  }

  function apply() {
    setAttempted(true);
    if (problem) return null;
    const snapshot = withBranch(current, branch.value, branch.label);
    setApplied(snapshot);
    return snapshot;
  }

  // Selects and applies a period from outside the filter (a drill-down link).
  function select(next) {
    setModeState(next.mode);
    if (next.mode === AS_OF) {
      setAsOf(next.asOf);
    } else {
      setFrom(next.from);
      setTo(next.to);
    }
    const snapshot = withBranch(resolvePeriod(next, { asOfStart }), branch.value, branch.label);
    setApplied(snapshot);
    return snapshot;
  }

  return {
    mode,
    setMode,
    from,
    setFrom,
    to,
    setTo,
    asOf,
    setAsOf,
    select,
    apply,
    applied,
    current,
    fromDate: dates.fromDate,
    toDate: dates.toDate,
    asOfDate: dates.asOfDate,
    error: problem && (attempted || problem.code === "FROM_AFTER_TO") ? problem.message : null,
    branchOptions: branch.options,
    branch: branch.value,
    setBranch: branch.setValue,
    branchLabel: branch.label,
  };
}
