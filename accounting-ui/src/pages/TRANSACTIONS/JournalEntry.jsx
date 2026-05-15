import { useMemo, useState } from "react";

const sampleAccounts = [
  { id: 1, code: "1010", name: "Cash on Hand", type: "Asset" },
  { id: 2, code: "1011", name: "Cash in Bank", type: "Asset" },
  { id: 3, code: "1100", name: "Accounts Receivable", type: "Asset" },
  { id: 4, code: "2000", name: "Accounts Payable", type: "Liability" },
  { id: 5, code: "3000", name: "Owner's Equity", type: "Equity" },
  { id: 6, code: "4000", name: "Sales Revenue", type: "Revenue" },
  { id: 7, code: "5000", name: "Office Supplies Expense", type: "Expense" },
  { id: 8, code: "5100", name: "Salary Expense", type: "Expense" },
];

const transactionTypes = [
  "Journal Voucher",
  "Cash Receipt",
  "Cash Disbursement",
  "Sales Invoice",
  "Purchase Voucher",
];

function createEmptyLine() {
  return {
    id: crypto.randomUUID(),
    accountId: "",
    description: "",
    debit: "",
    credit: "",
  };
}

function peso(value) {
  const num = Number(value || 0);
  return num.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function JournalEntry() {
  const [form, setForm] = useState({
    transactionType: "Journal Voucher",
    transactionDate: new Date().toISOString().split("T")[0],
    referenceNo: "",
    payee: "",
    memo: "",
    status: "Draft",
  });

  const [lines, setLines] = useState([createEmptyLine(), createEmptyLine()]);
  const [errors, setErrors] = useState("");

  const totals = useMemo(() => {
    const totalDebit = lines.reduce(
      (sum, line) => sum + Number(line.debit || 0),
      0
    );
    const totalCredit = lines.reduce(
      (sum, line) => sum + Number(line.credit || 0),
      0
    );
    return {
      totalDebit,
      totalCredit,
      balanced: totalDebit === totalCredit && totalDebit > 0,
      difference: totalDebit - totalCredit,
    };
  }, [lines]);

  function updateForm(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function updateLine(id, field, value) {
    setLines((prev) =>
      prev.map((line) => {
        if (line.id !== id) return line;

        const updated = { ...line, [field]: value };

        if (field === "debit" && value !== "") {
          updated.credit = "";
        }

        if (field === "credit" && value !== "") {
          updated.debit = "";
        }

        return updated;
      })
    );
  }

  function addLine() {
    setLines((prev) => [...prev, createEmptyLine()]);
  }

  function removeLine(id) {
    if (lines.length <= 2) return;
    setLines((prev) => prev.filter((line) => line.id !== id));
  }

  function validateForm() {
    if (!form.transactionDate) {
      return "Transaction date is required.";
    }

    if (!form.referenceNo.trim()) {
      return "Reference number is required.";
    }

    const filledLines = lines.filter(
      (line) =>
        line.accountId ||
        line.description.trim() ||
        Number(line.debit || 0) > 0 ||
        Number(line.credit || 0) > 0
    );

    if (filledLines.length < 2) {
      return "At least 2 journal lines are required.";
    }

    for (const line of filledLines) {
      if (!line.accountId) {
        return "Every used line must have an account selected.";
      }

      const debit = Number(line.debit || 0);
      const credit = Number(line.credit || 0);

      if (debit > 0 && credit > 0) {
        return "A line cannot have both debit and credit.";
      }

      if (debit <= 0 && credit <= 0) {
        return "Each used line must have either a debit or a credit amount.";
      }
    }

    if (!totals.balanced) {
      return "Total debit and total credit must be equal.";
    }

    return "";
  }

  function handleSave(status) {
    const validationError = validateForm();

    if (validationError) {
      setErrors(validationError);
      return;
    }

    setErrors("");

    const payload = {
      ...form,
      status,
      lines: lines
        .filter(
          (line) =>
            line.accountId &&
            (Number(line.debit || 0) > 0 || Number(line.credit || 0) > 0)
        )
        .map((line) => ({
          account_id: Number(line.accountId),
          description: line.description,
          debit: Number(line.debit || 0),
          credit: Number(line.credit || 0),
        })),
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
    };

    console.log("SAVE THIS TO BACKEND:", payload);
    alert(`${status} saved successfully.`);
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <div style={styles.headerRow}>
          <div>
            <h1 style={styles.title}>Transaction Entry</h1>
            <p style={styles.subtitle}>
              Modern double-entry transaction form for journal posting
            </p>
          </div>

          <div style={styles.statusWrap}>
            <span
              style={{
                ...styles.statusBadge,
                backgroundColor:
                  form.status === "Posted" ? "#dcfce7" : "#f3f4f6",
                color: form.status === "Posted" ? "#166534" : "#374151",
              }}
            >
              {form.status}
            </span>
          </div>
        </div>

        <div style={styles.card}>
          <div style={styles.grid}>
            <div style={styles.field}>
              <label style={styles.label}>Transaction Type</label>
              <select
                style={styles.input}
                value={form.transactionType}
                onChange={(e) =>
                  updateForm("transactionType", e.target.value)
                }
              >
                {transactionTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Transaction Date</label>
              <input
                type="date"
                style={styles.input}
                value={form.transactionDate}
                onChange={(e) =>
                  updateForm("transactionDate", e.target.value)
                }
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Reference No.</label>
              <input
                type="text"
                style={styles.input}
                placeholder="JV-000001"
                value={form.referenceNo}
                onChange={(e) => updateForm("referenceNo", e.target.value)}
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label}>Payee / Customer / Supplier</label>
              <input
                type="text"
                style={styles.input}
                placeholder="Enter party name"
                value={form.payee}
                onChange={(e) => updateForm("payee", e.target.value)}
              />
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <label style={styles.label}>Memo</label>
            <textarea
              style={styles.textarea}
              rows={3}
              placeholder="Transaction explanation or narration"
              value={form.memo}
              onChange={(e) => updateForm("memo", e.target.value)}
            />
          </div>
        </div>

        <div style={styles.card}>
          <div style={styles.linesHeader}>
            <div>
              <h2 style={styles.sectionTitle}>Journal Lines</h2>
              <p style={styles.sectionSub}>
                Total debit must always equal total credit
              </p>
            </div>

            <button style={styles.addBtn} onClick={addLine}>
              + Add Line
            </button>
          </div>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Account</th>
                  <th style={styles.th}>Line Description</th>
                  <th style={styles.thRight}>Debit</th>
                  <th style={styles.thRight}>Credit</th>
                  <th style={styles.thCenter}>Action</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td style={styles.td}>
                      <select
                        style={styles.tableInput}
                        value={line.accountId}
                        onChange={(e) =>
                          updateLine(line.id, "accountId", e.target.value)
                        }
                      >
                        <option value="">Select account</option>
                        {sampleAccounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} - {account.name}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td style={styles.td}>
                      <input
                        type="text"
                        style={styles.tableInput}
                        placeholder="Description"
                        value={line.description}
                        onChange={(e) =>
                          updateLine(line.id, "description", e.target.value)
                        }
                      />
                    </td>

                    <td style={styles.td}>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        style={styles.tableInputRight}
                        placeholder="0.00"
                        value={line.debit}
                        onChange={(e) =>
                          updateLine(line.id, "debit", e.target.value)
                        }
                      />
                    </td>

                    <td style={styles.td}>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        style={styles.tableInputRight}
                        placeholder="0.00"
                        value={line.credit}
                        onChange={(e) =>
                          updateLine(line.id, "credit", e.target.value)
                        }
                      />
                    </td>

                    <td style={styles.tdCenter}>
                      <button
                        style={styles.removeBtn}
                        onClick={() => removeLine(line.id)}
                        disabled={lines.length <= 2}
                        title="Remove line"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>

              <tfoot>
                <tr>
                  <td colSpan={2} style={styles.totalLabel}>
                    Totals
                  </td>
                  <td style={styles.totalValueRight}>
                    ₱ {peso(totals.totalDebit)}
                  </td>
                  <td style={styles.totalValueRight}>
                    ₱ {peso(totals.totalCredit)}
                  </td>
                  <td style={styles.totalStatusCell}>
                    <span
                      style={{
                        ...styles.balanceBadge,
                        backgroundColor: totals.balanced ? "#dcfce7" : "#fee2e2",
                        color: totals.balanced ? "#166534" : "#991b1b",
                      }}
                    >
                      {totals.balanced
                        ? "Balanced"
                        : `Difference: ₱ ${peso(Math.abs(totals.difference))}`}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {errors ? <div style={styles.errorBox}>{errors}</div> : null}
        </div>

        <div style={styles.footerBar}>
          <div style={styles.footerLeft}>
            <div style={styles.summaryCard}>
              <span style={styles.summaryLabel}>Debit</span>
              <strong style={styles.summaryValue}>
                ₱ {peso(totals.totalDebit)}
              </strong>
            </div>

            <div style={styles.summaryCard}>
              <span style={styles.summaryLabel}>Credit</span>
              <strong style={styles.summaryValue}>
                ₱ {peso(totals.totalCredit)}
              </strong>
            </div>
          </div>

          <div style={styles.footerRight}>
            <button
              style={styles.secondaryBtn}
              onClick={() => handleSave("Draft")}
            >
              Save Draft
            </button>

            <button
              style={styles.primaryBtn}
              onClick={() => handleSave("Posted")}
            >
              Post Transaction
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f6f8fb",
    padding: "24px",
    fontFamily: "Arial, sans-serif",
    color: "#1f2937",
  },
  container: {
    maxWidth: "1400px",
    margin: "0 auto",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
    marginBottom: "20px",
    flexWrap: "wrap",
  },
  title: {
    margin: 0,
    fontSize: "30px",
    fontWeight: "700",
    color: "#111827",
  },
  subtitle: {
    margin: "6px 0 0",
    fontSize: "14px",
    color: "#6b7280",
  },
  statusWrap: {
    display: "flex",
    alignItems: "center",
  },
  statusBadge: {
    padding: "10px 14px",
    borderRadius: "999px",
    fontSize: "13px",
    fontWeight: "700",
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "18px",
    padding: "20px",
    boxShadow: "0 10px 24px rgba(0,0,0,0.05)",
    marginBottom: "20px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "16px",
  },
  field: {
    display: "flex",
    flexDirection: "column",
  },
  label: {
    fontSize: "13px",
    fontWeight: "700",
    color: "#374151",
    marginBottom: "8px",
  },
  input: {
    height: "44px",
    borderRadius: "12px",
    border: "1px solid #d1d5db",
    padding: "0 14px",
    fontSize: "14px",
    outline: "none",
    background: "#fff",
    transition: "border-color 0.2s",
  },
  textarea: {
    width: "100%",
    borderRadius: "12px",
    border: "1px solid #d1d5db",
    padding: "12px 14px",
    fontSize: "14px",
    resize: "vertical",
    outline: "none",
    boxSizing: "border-box",
  },
  linesHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
    gap: "12px",
    flexWrap: "wrap",
  },
  sectionTitle: {
    margin: 0,
    fontSize: "20px",
    fontWeight: "700",
    color: "#111827",
  },
  sectionSub: {
    margin: "6px 0 0",
    fontSize: "13px",
    color: "#6b7280",
  },
  addBtn: {
    height: "42px",
    border: "none",
    borderRadius: "12px",
    padding: "0 16px",
    background: "#2563eb",
    color: "#fff",
    fontWeight: "700",
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
  tableWrap: {
    width: "100%",
    overflowX: "auto",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    minWidth: "980px",
  },
  th: {
    textAlign: "left",
    padding: "12px",
    fontSize: "13px",
    color: "#6b7280",
    borderBottom: "1px solid #e5e7eb",
    background: "#f9fafb",
  },
  thRight: {
    textAlign: "right",
    padding: "12px",
    fontSize: "13px",
    color: "#6b7280",
    borderBottom: "1px solid #e5e7eb",
    background: "#f9fafb",
  },
  thCenter: {
    textAlign: "center",
    padding: "12px",
    fontSize: "13px",
    color: "#6b7280",
    borderBottom: "1px solid #e5e7eb",
    background: "#f9fafb",
  },
  td: {
    padding: "10px 12px",
    borderBottom: "1px solid #f1f5f9",
    verticalAlign: "middle",
  },
  tdCenter: {
    padding: "10px 12px",
    borderBottom: "1px solid #f1f5f9",
    verticalAlign: "middle",
    textAlign: "center",
  },
  tableInput: {
    width: "100%",
    height: "42px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    padding: "0 12px",
    fontSize: "14px",
    boxSizing: "border-box",
  },
  tableInputRight: {
    width: "100%",
    height: "42px",
    borderRadius: "10px",
    border: "1px solid #d1d5db",
    padding: "0 12px",
    fontSize: "14px",
    textAlign: "right",
    boxSizing: "border-box",
  },
  removeBtn: {
    height: "38px",
    border: "1px solid #fecaca",
    borderRadius: "10px",
    padding: "0 12px",
    background: "#fff1f2",
    color: "#b91c1c",
    cursor: "pointer",
    fontWeight: "700",
    transition: "all 0.2s",
  },
  totalLabel: {
    textAlign: "right",
    padding: "14px 12px",
    fontWeight: "700",
    fontSize: "14px",
    color: "#111827",
    background: "#f9fafb",
    borderTop: "1px solid #e5e7eb",
  },
  totalValueRight: {
    textAlign: "right",
    padding: "14px 12px",
    fontWeight: "700",
    fontSize: "14px",
    color: "#111827",
    background: "#f9fafb",
    borderTop: "1px solid #e5e7eb",
  },
  totalStatusCell: {
    textAlign: "center",
    padding: "14px 12px",
    background: "#f9fafb",
    borderTop: "1px solid #e5e7eb",
  },
  balanceBadge: {
    display: "inline-block",
    padding: "8px 12px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: "700",
  },
  errorBox: {
    marginTop: "16px",
    padding: "12px 14px",
    borderRadius: "12px",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#991b1b",
    fontSize: "14px",
    fontWeight: "600",
  },
  footerBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "16px",
    flexWrap: "wrap",
  },
  footerLeft: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
  },
  summaryCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: "16px",
    padding: "14px 18px",
    minWidth: "180px",
    boxShadow: "0 8px 18px rgba(0,0,0,0.04)",
  },
  summaryLabel: {
    display: "block",
    fontSize: "12px",
    color: "#6b7280",
    marginBottom: "6px",
    fontWeight: "700",
  },
  summaryValue: {
    fontSize: "20px",
    color: "#111827",
  },
  footerRight: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
  },
  secondaryBtn: {
    height: "46px",
    border: "1px solid #d1d5db",
    borderRadius: "12px",
    padding: "0 18px",
    background: "#fff",
    color: "#374151",
    fontWeight: "700",
    cursor: "pointer",
    transition: "all 0.2s",
  },
  primaryBtn: {
    height: "46px",
    border: "none",
    borderRadius: "12px",
    padding: "0 18px",
    background: "#111827",
    color: "#fff",
    fontWeight: "700",
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
};