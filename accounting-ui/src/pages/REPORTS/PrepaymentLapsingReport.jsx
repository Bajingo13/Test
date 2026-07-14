import PrepaidListReportBase from "./PrepaidListReportBase";

export default function PrepaymentLapsingReport() {
  return (
    <PrepaidListReportBase
      title="Prepayment Lapsing Report"
      reportTitle="PREPAYMENT LAPSING REPORT"
      endpoint="/api/reports/prepayment-lapsing"
      showMonthsElapsed
    />
  );
}
