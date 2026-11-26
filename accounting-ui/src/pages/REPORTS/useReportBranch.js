import { useActiveBranch } from "../../context/ActiveBranchContext";
import { reportScope } from "../../utils/activeBranch.mjs";
import { branchOptions, branchLabel } from "./reportBranch.mjs";

// The report Branch selector, now driven by the system-wide Active Branch
// (context/ActiveBranchContext) instead of a per-page selection:
//   - options are unchanged (reportBranch.mjs: "All Branches" only for users
//     allowed to consolidate - REPORTS.ALL_BRANCHES);
//   - the value follows the active branch; for a user who may not consolidate
//     and has the aggregate selected, the report runs for their FIRST assigned
//     branch and `note` says so (reportScope) - never a wider scope;
//   - choosing a branch here changes the active branch everywhere.
// The server re-checks the branch on every report request.
export default function useReportBranch() {
  const ab = useActiveBranch();
  const options = branchOptions({ branches: ab.branches, canConsolidate: ab.canConsolidate });
  const scope = reportScope({ value: ab.value, options: ab.options, canConsolidate: ab.canConsolidate });
  const value = options.some((o) => o.value === scope.param) ? scope.param : options[0]?.value || "";
  return {
    options,
    value,
    setValue: (next) => ab.requestChange(next),
    label: branchLabel(options, value) || scope.label,
    note: scope.note,
    loaded: ab.ready,
  };
}
