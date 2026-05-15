import { Link, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import "./Sidebar.css";

export default function Sidebar() {
  const location = useLocation();

  const fileSetupItems = [
    { name: "Chart of Accounts", path: "/coa" },
    { name: "General Libraries", path: "/general-libraries" },
    { name: "Group Code", path: "/group-code" },
    { name: "Industry", path: "/industry" },
    { name: "Category Code", path: "/category-code" },
    { name: "Beginning Balances", path: "/beginning-balances" },
    { name: "Book Template", path: "/book-template" },
    { name: "Particulars Template", path: "/particulars-template" },
    { name: "Bank Codes", path: "/bank-codes" },
    { name: "Transaction Setup", path: "/transaction-setup" },
    { name: "Currency File Setup", path: "/currency-file-setup" },
    { name: "Additional File Setup", path: "/additional-file-setup" },
    { name: "Tax File Setup", path: "/tax-file-setup" },
  ];

  const transactionVoucherItems = [
    { name: "Invoice", path: "/transactions/invoice" },
    { name: "Official Receipts", path: "/transactions/or" },
    { name: "Check Voucher", path: "/transactions/cv" },
    { name: "Journal Voucher", path: "/transactions/jv" },
    { name: "Accounts Payable Voucher", path: "/transactions/apv" },
    { name: "Petty Cash Voucher", path: "/transactions/petty-cash-voucher" },
    { name: "Debit Credit Memo", path: "/transactions/debit-credit-memo" },
  ];

  const isFileSetupActive = fileSetupItems.some(
    (item) => location.pathname === item.path
  );

  const isTransactionActive = location.pathname.startsWith("/transactions");

  const isVoucherActive = transactionVoucherItems.some(
    (item) => location.pathname.startsWith(item.path)
  );

  const [openFileSetup, setOpenFileSetup] = useState(isFileSetupActive);
  const [openTransactions, setOpenTransactions] = useState(isTransactionActive);
  const [openVoucherMenu, setOpenVoucherMenu] = useState(isVoucherActive);

  useEffect(() => {
    if (isFileSetupActive) setOpenFileSetup(true);
    if (isTransactionActive) setOpenTransactions(true);
    if (isVoucherActive) setOpenVoucherMenu(true);
  }, [isFileSetupActive, isTransactionActive, isVoucherActive]);

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">AstreaBlue</div>

      <nav className="sidebar-nav">
        <Link
          to="/dashboard"
          className={location.pathname === "/dashboard" ? "nav-link active" : "nav-link"}
        >
          Dashboard
        </Link>

        <button
          type="button"
          className={isFileSetupActive ? "nav-section-btn active" : "nav-section-btn"}
          onClick={() => setOpenFileSetup((prev) => !prev)}
        >
          <span>File Setup</span>
          <span>{openFileSetup ? "▾" : "▸"}</span>
        </button>

        {openFileSetup && (
          <div className="submenu">
            {fileSetupItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={
                  location.pathname.startsWith(item.path)
                    ? "submenu-link active-submenu"
                    : "submenu-link"
                }
              >
                {item.name}
              </Link>
            ))}
          </div>
        )}

        <button
          type="button"
          className={isTransactionActive ? "nav-section-btn active" : "nav-section-btn"}
          onClick={() => setOpenTransactions((prev) => !prev)}
        >
          <span>Transactions</span>
          <span>{openTransactions ? "▾" : "▸"}</span>
        </button>

        {openTransactions && (
          <div className="submenu">
            <button
              type="button"
              className={
                isVoucherActive
                  ? "submenu-link nested-toggle active-submenu"
                  : "submenu-link nested-toggle"
              }
              onClick={() => setOpenVoucherMenu((prev) => !prev)}
            >
              <span>Vouchers / Invoices / ORs</span>
              <span>{openVoucherMenu ? "▾" : "▸"}</span>
            </button>

            {openVoucherMenu && (
              <div className="nested-submenu">
                {transactionVoucherItems.map((item) => (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={
                      location.pathname === item.path
                        ? "submenu-link nested-link active-submenu"
                        : "submenu-link nested-link"
                    }
                  >
                    {item.name}
                  </Link>
                ))}
              </div>
            )}

            <Link
              to="/transactions/journalization"
              className={
                location.pathname === "/transactions/journalization"
                  ? "submenu-link active-submenu"
                  : "submenu-link"
              }
            >
              Journalization
            </Link>
          </div>
        )}

        <Link
          to="/posting"
          className={location.pathname === "/posting" ? "nav-link active" : "nav-link"}
        >
          Posting
        </Link>

        <Link
          to="/ledger"
          className={location.pathname === "/ledger" ? "nav-link active" : "nav-link"}
        >
          Ledger
        </Link>

        <Link
          to="/reports"
          className={location.pathname === "/reports" ? "nav-link active" : "nav-link"}
        >
          Reports
        </Link>
      </nav>
    </aside>
  );
}