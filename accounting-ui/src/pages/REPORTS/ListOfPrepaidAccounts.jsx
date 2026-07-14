import PrepaidListReportBase from "./PrepaidListReportBase";

export default function ListOfPrepaidAccounts() {
  return (
    <PrepaidListReportBase
      title="List of Prepaid Accounts"
      reportTitle="LIST OF PREPAID ACCOUNTS"
      endpoint="/api/reports/prepaid-list"
    />
  );
}
