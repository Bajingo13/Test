import { activeBranches, branchFieldMode, branchName } from "../pages/TRANSACTIONS/transactionBranch.mjs";

// Multi-Branch Phase C-3 - the Branch field of the Beginning Balance screens
// (GL / AR / AP), same rules as the transaction screens:
//   no branches      -> nothing rendered (legacy company-level balances);
//   one active branch -> shown read-only, used automatically;
//   several          -> the user must choose (no silent default).
// Display only: the server re-resolves and re-validates the branch on save,
// import and template download.
export default function BeginningBalanceBranchField({ branches, value, onChange, error, id = "bb-branch" }) {
  const mode = branchFieldMode(branches);
  if (mode === "none") return null;
  return (
    <div className="bb-branch-field">
      <label htmlFor={id}>Branch</label>
      {mode === "choose" ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select branch...</option>
          {activeBranches(branches).map((b) => (
            <option key={b.id} value={String(b.id)}>{b.name}</option>
          ))}
        </select>
      ) : (
        <input id={id} value={branchName(value, branches)} readOnly />
      )}
      {error ? <div className="bb-branch-error" role="alert">{error}</div> : null}
    </div>
  );
}
