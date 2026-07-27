export default function BankReconAuditLogPanel({ entries }) {
  return (
    <div className="brc-table-wrap">
      <table className="brc-table">
        <thead>
          <tr>
            <th>When</th>
            <th>User</th>
            <th>Action</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan="4" className="brc-empty">
                No audit history yet.
              </td>
            </tr>
          ) : (
            entries.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleString("en-PH")}</td>
                <td>{entry.username || "-"}</td>
                <td>{entry.action}</td>
                <td>{entry.description}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
