import { useActiveBranch } from "../../context/ActiveBranchContext";
import { ALL, labelFor, reportScope } from "../../utils/activeBranch.mjs";
import { branchOptions, branchLabel } from "./reportBranch.mjs";

// The report Branch selector, driven by the system-wide Active Branch
// (context/ActiveBranchContext) instead of a per-page selection:
//   - options are unchanged (reportBranch.mjs: "All Branches" only for users
//     allowed to consolidate - REPORTS.ALL_BRANCHES);
//   - the value follows the active branch; a user who may not consolidate and
//     has the aggregate selected gets NO branch (value "") and `required` +
//     `note`: the report cannot be generated until one branch is chosen
//     (nothing is substituted);
//   - choosing a branch here changes the active branch everywhere.
// The server re-checks the branch on every report request.
export default function useReportBranch() {
  const ab = useActiveBranch();
  // The consolidated option is named for what it covers: "All Branches" only
  // when the user holds every branch of the company, otherwise "All Assigned
  // Branches" - so the report's branch label matches the data's scope.
  const aggregateLabel = labelFor(ab.options, ALL);
  const options = branchOptions({ branches: ab.branches, canConsolidate: ab.canConsolidate }).map((o) =>
    o.value === ALL && aggregateLabel ? { ...o, label: aggregateLabel } : o
  );
  const scope = reportScope({ value: ab.value, options: ab.options, canConsolidate: ab.canConsolidate });
  const value = scope.needsBranch ? "" : options.some((o) => o.value === scope.param) ? scope.param : "";
  return {
    options,
    value,
    setValue: (next) => ab.requestChange(next),
    label: value ? branchLabel(options, value) || scope.label : "",
    note: scope.note,
    required: scope.needsBranch,
    loaded: ab.ready,
  };
}
