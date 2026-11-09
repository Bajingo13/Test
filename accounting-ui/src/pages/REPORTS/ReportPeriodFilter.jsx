import { AS_OF, RANGE, reportPeriodLines } from "./reportPeriod.mjs";
import "./ReportPeriodFilter.css";

// The one reporting-period control for the Reports module: exactly two
// options, Range and Date / As Of, with the matching date inputs below them.
export default function ReportPeriodFilter({ period, idPrefix }) {
  const isRange = period.mode === RANGE;

  return (
    <fieldset className="rpf">
      <legend className="rpf-legend">Report Period</legend>

      <div className="rpf-options">
        <label className="rpf-option" htmlFor={`${idPrefix}-mode-range`}>
          <input
            id={`${idPrefix}-mode-range`}
            type="radio"
            name={`${idPrefix}-date-mode`}
            checked={isRange}
            onChange={() => period.setMode(RANGE)}
          />
          <span>Range</span>
        </label>
        <label className="rpf-option" htmlFor={`${idPrefix}-mode-asof`}>
          <input
            id={`${idPrefix}-mode-asof`}
            type="radio"
            name={`${idPrefix}-date-mode`}
            checked={!isRange}
            onChange={() => period.setMode(AS_OF)}
          />
          <span>Date / As Of</span>
        </label>
      </div>

      <div className="rpf-dates">
        {isRange ? (
          <>
            <div>
              <label htmlFor={`${idPrefix}-from`}>Date From</label>
              <input
                id={`${idPrefix}-from`}
                type="date"
                required
                value={period.from}
                onChange={(e) => period.setFrom(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-to`}>Date To</label>
              <input
                id={`${idPrefix}-to`}
                type="date"
                required
                value={period.to}
                onChange={(e) => period.setTo(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div>
            <label htmlFor={`${idPrefix}-asof`}>As Of Date</label>
            <input
              id={`${idPrefix}-asof`}
              type="date"
              required
              value={period.asOf}
              onChange={(e) => period.setAsOf(e.target.value)}
            />
          </div>
        )}
      </div>

      {period.error ? (
        <div className="rpf-error" role="alert">
          {period.error}
        </div>
      ) : null}
    </fieldset>
  );
}

// The report's period as it appears on screen, in print and in the PDF. Takes
// the applied snapshot (period.applied), so it always matches the figures.
export function ReportPeriodLabel({ period }) {
  const { primary, secondary } = reportPeriodLines(period);
  if (!primary) return null;
  return (
    <div className="rpl">
      <div className="rpl-primary">{primary}</div>
      {secondary ? <div className="rpl-secondary">{secondary}</div> : null}
    </div>
  );
}
