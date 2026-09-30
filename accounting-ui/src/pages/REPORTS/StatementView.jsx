import { useMemo } from "react";
import { serializeStatement, formatScreenAmount } from "./statementModel.mjs";
import "./StatementView.css";

// Reports Phase E.1: the ONE on-screen renderer for a structured Income
// Statement / Balance Sheet. It renders the exact presentation rows the
// Phase D serializer produces for CSV - no second layout engine, no
// financial math in JSX. Backend owns values; serializer owns ordering and
// labels; this component owns markup only.
//
// Signature rows (Prepared/Checked/Approved By) are intentionally NOT shown
// on the interactive screen - they stay in the serializer for CSV and for
// Phase E.2 print.

export default function StatementView({ model, onAccountClick }) {
  const s = useMemo(() => (model ? serializeStatement(model) : null), [model]);
  if (!s) return null;

  const cols = s.columns;
  const span = 1 + cols.length;

  return (
    <div className="stmt" role="region" aria-label={s.title}>
      <header className="stmt-head">
        {s.companyName ? <div className="stmt-company">{s.companyName}</div> : null}
        <div className="stmt-title">{s.title}</div>
        {s.subtitleLines.map((line, i) => (
          <div className="stmt-subtitle" key={i}>
            {line}
          </div>
        ))}
      </header>

      <div className="stmt-scroll">
        <table className="stmt-table">
          <caption className="stmt-sr-only">{s.title}</caption>
          <thead>
            <tr className="stmt-band">
              <th scope="col" />
              {cols.map((c) => (
                <th scope="col" key={c.key} className="stmt-num">
                  {c.band}
                </th>
              ))}
            </tr>
            <tr className="stmt-period">
              <th scope="col">Description</th>
              {cols.map((c) => (
                <th scope="col" key={c.key} className="stmt-num">
                  {c.periodLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((row, i) => {
              if (row.type === "spacer") {
                return (
                  <tr className="stmt-spacer" key={i} aria-hidden="true">
                    <td colSpan={span} />
                  </tr>
                );
              }
              if (row.type === "rule") {
                return (
                  <tr className="stmt-rule" key={i} aria-hidden="true">
                    <td colSpan={span} />
                  </tr>
                );
              }

              const cls = [
                "stmt-row",
                `stmt-${row.type}`,
                row.unclassified ? "stmt-unclassified" : "",
                row.synthetic ? "stmt-synthetic" : "",
              ]
                .filter(Boolean)
                .join(" ");

              const label = (row.label || "").trim();
              const clickable = row.type === "account" && row.accountCode && typeof onAccountClick === "function";

              return (
                <tr className={cls} key={i}>
                  <th scope="row" className="stmt-desc" style={{ paddingLeft: `${(row.indent || 0) * 1.25 + 0.25}rem` }}>
                    {clickable ? (
                      <button type="button" className="stmt-link" onClick={() => onAccountClick(row.accountCode)}>
                        {label}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                  {cols.map((c) => {
                    const v = row.values ? row.values[c.key] : undefined;
                    const text = formatScreenAmount(v);
                    return (
                      <td key={c.key} className={`stmt-num${typeof v === "number" && v < 0 ? " stmt-neg" : ""}`}>
                        {text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
