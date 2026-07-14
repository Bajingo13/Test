import { Link, useLocation } from "react-router-dom";
import { useState } from "react";
import "./Sidebar.css";

export default function Sidebar({ sidebarOpen, setSidebarOpen }) {
  const location = useLocation();

  const [openFileSetup, setOpenFileSetup] = useState(false);
  const [openBeginningBalances, setOpenBeginningBalances] = useState(false);
  const [openTransactions, setOpenTransactions] = useState(false);
  const [openReports, setOpenReports] = useState(false);
  const [openPrepaidReports, setOpenPrepaidReports] = useState(false);

  const fileSetupItems = [
    { name: "Chart of Accounts", path: "/coa" },
    { name: "General Libraries", path: "/general-libraries" },
    { name: "Group Code", path: "/group-code" },
    { name: "Industry", path: "/industry" },
    { name: "Category Code", path: "/category-code" },
    { name: "Book Template", path: "/book-template" },
    { name: "Particulars Template", path: "/particulars-template" },
    { name: "Bank Codes", path: "/bank-codes" },
    { name: "Transaction Setup", path: "/transaction-setup" },
    { name: "Currency File Setup", path: "/currency-file-setup" },
    { name: "Additional File Setup", path: "/additional-file-setup" },
    { name: "Tax File Setup", path: "/tax-file-setup" },
    { name: "EWT Library", path: "/ewt-library" },
    { name: "Fixed Asset Setup", path: "/fixed-asset-setup" },
    { name: "Prepaid Account Setup", path: "/prepaid-account-setup" },
  ];

  const beginningBalanceItems = [
    { name: "GL Beginning Balance", path: "/beginning-balances/gl" },
    { name: "AR Beginning Balance", path: "/beginning-balances/ar" },
    { name: "AP Beginning Balance", path: "/beginning-balances/ap" },
  ];

  const transactionItems = [
    { name: "Invoice", path: "/transactions/invoice" },
    { name: "Official Receipts", path: "/transactions/or" },
    { name: "Check Voucher", path: "/transactions/cv" },
    { name: "Journal Voucher", path: "/transactions/jv" },
    { name: "Accounts Payable Voucher", path: "/transactions/apv" },
    { name: "Purchase Order", path: "/transactions/purchase-order" },
    { name: "Petty Cash Voucher", path: "/transactions/petty-cash-voucher" },
    { name: "Debit Credit Memo", path: "/transactions/debit-credit-memo" },
  ];

  const reportItems = [
    { name: "Trial Balance", path: "/reports/trial-balance" },
    { name: "Account Analysis", path: "/reports/account-analysis" },
    { name: "AR-Aging", path: "/reports/ar-aging" },
    { name: "AP-Aging", path: "/reports/ap-aging" },
    { name: "Bank Reconciliation", path: "/reports/bank-reconciliation" },
    { name: "Balance Sheet", path: "/reports/balance-sheet" },
    { name: "Income Statement", path: "/reports/income-statement" },
    { name: "Cash Flow Statement", path: "/reports/cash-flow-statement" },
    { name: "General Ledger", path: "/reports/general-ledger" },
    { name: "Subsidiary Ledger", path: "/reports/subsidiary-ledger" },
    { name: "Fixed Asset Account Reports", path: "/reports/fixed-asset-register" },
    { name: "expanded withholding tax report", path: "/reports/expanded-withholding-tax-report" },
    { name: "final withholding tax report", path: "/reports/final-withholding-tax-report" },
    { name: "input vat report", path: "/reports/input-vat-report" },
    { name: "output vat report", path: "/reports/output-vat-report" },
  ];

  const prepaidReportItems = [
    { name: "Prepayment Lapsing Report", path: "/reports/prepayment-lapsing" },
    { name: "List of Prepaid Accounts", path: "/reports/prepaid-accounts-list" },
    { name: "Prepaid Subsidiary", path: "/reports/prepaid-subsidiary" },
    { name: "List of Lapsed Prepayments", path: "/reports/lapsed-prepayments" },
  ];

  const isBeginningBalanceActive = beginningBalanceItems.some(
    (item) => location.pathname === item.path
  );

  const isPrepaidReportActive = prepaidReportItems.some(
    (item) => location.pathname === item.path
  );

  const closeAllDropdowns = () => {
    setOpenFileSetup(false);
    setOpenBeginningBalances(false);
    setOpenTransactions(false);
    setOpenReports(false);
    setOpenPrepaidReports(false);
  };

  const toggleSidebar = () => {
    setSidebarOpen((prev) => {
      const next = !prev;
      if (!next) closeAllDropdowns();
      return next;
    });
  };

  const toggleFileSetup = () => {
    setOpenFileSetup((prev) => !prev);
    setOpenTransactions(false);
    setOpenReports(false);
  };

  const toggleBeginningBalances = () => {
    setOpenBeginningBalances((prev) => !prev);
  };

  const toggleTransactions = () => {
    setOpenTransactions((prev) => !prev);
    setOpenFileSetup(false);
    setOpenBeginningBalances(false);
    setOpenReports(false);
  };

  const toggleReports = () => {
    setOpenReports((prev) => !prev);
    setOpenFileSetup(false);
    setOpenBeginningBalances(false);
    setOpenTransactions(false);
  };

  const togglePrepaidReports = () => {
    setOpenPrepaidReports((prev) => !prev);
  };

  return (
    <aside className={`sidebar ${sidebarOpen ? "expanded" : "collapsed"}`}>
      <div className="sidebar-logo-box" onClick={toggleSidebar}>
        <img
          src="/all_image/astrea-logo.png"
          alt="AstreaBlue"
          className="sidebar-logo-image"
        />
      </div>

      {sidebarOpen && (
        <nav className="sidebar-nav">
          <Link
            to="/dashboard"
            onClick={closeAllDropdowns}
            className={location.pathname === "/dashboard" ? "nav-link active" : "nav-link"}
          >
            Dashboard
          </Link>

          <button type="button" className="nav-section-btn" onClick={toggleFileSetup}>
            <span>File Setup</span>
            <span>{openFileSetup ? "▾" : "▸"}</span>
          </button>

          {openFileSetup && (
            <div className="submenu">
              {fileSetupItems.slice(0, 5).map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={location.pathname === item.path ? "submenu-link active-submenu" : "submenu-link"}
                >
                  {item.name}
                </Link>
              ))}

              <button
                type="button"
                className={`submenu-link submenu-parent ${
                  isBeginningBalanceActive ? "active-submenu" : ""
                }`}
                onClick={toggleBeginningBalances}
              >
                <span>Beginning Balances</span>
                <span>{openBeginningBalances ? "▾" : "▸"}</span>
              </button>

              {openBeginningBalances && (
                <div className="nested-submenu">
                  {beginningBalanceItems.map((item) => (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={
                        location.pathname === item.path
                          ? "nested-submenu-link active-nested-submenu"
                          : "nested-submenu-link"
                      }
                    >
                      {item.name}
                    </Link>
                  ))}
                </div>
              )}

              {fileSetupItems.slice(5).map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={location.pathname === item.path ? "submenu-link active-submenu" : "submenu-link"}
                >
                  {item.name}
                </Link>
              ))}
            </div>
          )}

          <button type="button" className="nav-section-btn" onClick={toggleTransactions}>
            <span>Transactions</span>
            <span>{openTransactions ? "▾" : "▸"}</span>
          </button>

          {openTransactions && (
            <div className="submenu">
              {transactionItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={location.pathname === item.path ? "submenu-link active-submenu" : "submenu-link"}
                >
                  {item.name}
                </Link>
              ))}
            </div>
          )}

          <Link to="/posting" onClick={closeAllDropdowns} className={location.pathname === "/posting" ? "nav-link active" : "nav-link"}>
            Posting
          </Link>

          <Link to="/ledger" onClick={closeAllDropdowns} className={location.pathname === "/ledger" ? "nav-link active" : "nav-link"}>
            Ledger
          </Link>

          <button type="button" className="nav-section-btn" onClick={toggleReports}>
            <span>Reports</span>
            <span>{openReports ? "▾" : "▸"}</span>
          </button>

          {openReports && (
            <div className="submenu">
              {reportItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className={location.pathname === item.path ? "submenu-link active-submenu" : "submenu-link"}
                >
                  {item.name}
                </Link>
              ))}

              <button
                type="button"
                className={`submenu-link submenu-parent ${
                  isPrepaidReportActive ? "active-submenu" : ""
                }`}
                onClick={togglePrepaidReports}
              >
                <span>Prepaid Accounts Reports</span>
                <span>{openPrepaidReports ? "▾" : "▸"}</span>
              </button>

              {openPrepaidReports && (
                <div className="nested-submenu">
                  {prepaidReportItems.map((item) => (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={
                        location.pathname === item.path
                          ? "nested-submenu-link active-nested-submenu"
                          : "nested-submenu-link"
                      }
                    >
                      {item.name}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </nav>
      )}
    </aside>
  );
}
