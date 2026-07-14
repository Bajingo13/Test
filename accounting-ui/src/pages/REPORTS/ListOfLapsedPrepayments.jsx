import PrepaidListReportBase from "./PrepaidListReportBase";

export default function ListOfLapsedPrepayments() {
  return (
    <PrepaidListReportBase
      title="List of Lapsed Prepayments"
      reportTitle="LIST OF LAPSED PREPAYMENTS"
      endpoint="/api/reports/lapsed-prepayments"
    />
  );
}
