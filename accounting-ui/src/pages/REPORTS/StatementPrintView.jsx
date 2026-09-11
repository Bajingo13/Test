import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { serializeStatement, formatScreenAmount, statementPrintNotes } from "./statementModel.mjs";
import "./StatementPrintView.css";

// Reports Phase E.2: the printable / PDF-ready Income Statement / Balance
// Sheet. It consumes the EXACT same serializeStatement(model) rows as the
// on-screen StatementView - no second layout engine, no financial math in
// print code. Backend owns values; the serializer owns ordering + labels;
// this component owns print markup only.
//
// It renders into a dedicated print root portaled onto <body> and is
// display:none on screen. While a print is in progress
// (window "beforeprint" -> body.printing-statement) print CSS hides every
// other direct child of <body> and shows only this root - a dedicated
// print container, never fragile per-element hiding. Browser Print dialog
// -> Save as PDF / physical printer; text stays selectable (no rasterising,
// no screenshots).

export default function StatementPrintView({ model }) {
  const s = useMemo(() => (model ? serializeStatement(model) : null), [model]);
  const notes = useMemo(() => (model ? statementPrintNotes(model) : []), [model]);

  useEffect(() => {
    const before = () => document.body.classList.add("printing-statement");
    const after = () => document.body.classList.remove("printing-statement");
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
      document.body.classList.remove("printing-statement");
    };
  }, []);

  if (!s || typeof document === "undefined") return null;

  const cols = s.columns;
  const span = 1 + cols.length;

  const body = (
    <div id="statement-print-root" aria-hidden="true">
      <div className="spv">
        <header className="spv-head">
          {s.companyName ? <div className="spv-company">{s.companyName}</div> : null}
          <div className="spv-title">{s.title}</div>
          {s.subtitleLines.map((line, i) => (
            <div className="spv-subtitle" key={i}>
              {line}
            </div>
          ))}
        </header>

        <table className="spv-table">
          <thead>
            <tr className="spv-band">
              <th />
              {cols.map((c) => (
                <th key={c.key} className="spv-num">
                  {c.band}
                </th>
              ))}
            </tr>
            <tr className="spv-period">
              <th>Description</th>
              {cols.map((c) => (
                <th key={c.key} className="spv-num">
                  {c.periodLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((row, i) => {
              if (row.type === "spacer") {
                return (
                  <tr className="spv-spacer" key={i}>
                    <td colSpan={span} />
                  </tr>
                );
              }
              if (row.type === "rule") {
                return (
                  <tr className="spv-rule" key={i}>
                    <td colSpan={span} />
                  </tr>
                );
              }
              // The final grand total of each statement (Net Income / Total
              // Liabilities & Shareholders' Equity) gets the template's
              // double-rule underline.
              const isGrandTotal =
                row.type === "computed-total" &&
                (row.id === "NET_INCOME" || row.id === "TOTAL_LIABILITIES_AND_EQUITY");
              const cls = [
                "spv-row",
                `spv-${row.type}`,
                isGrandTotal ? "spv-grand-total" : "",
                row.unclassified ? "spv-unclassified" : "",
                row.synthetic ? "spv-synthetic" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <tr className={cls} key={i}>
                  <th scope="row" className="spv-desc" style={{ paddingLeft: `${(row.indent || 0) * 14 + 2}px` }}>
                    {(row.label || "").trim()}
                  </th>
                  {cols.map((c) => {
                    const v = row.values ? row.values[c.key] : undefined;
                    return (
                      <td key={c.key} className={`spv-num${typeof v === "number" && v < 0 ? " spv-neg" : ""}`}>
                        {formatScreenAmount(v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>

        {notes.length ? (
          <div className="spv-notes">
            {notes.map((n, i) => (
              <p key={i}>{n}</p>
            ))}
          </div>
        ) : null}

        <div className="spv-signatures">
          {s.signatures.map((label, i) => (
            <div className="spv-sig" key={i}>
              <div className="spv-sig-line" />
              <div className="spv-sig-label">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
