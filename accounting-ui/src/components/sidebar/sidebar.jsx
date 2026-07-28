import { Link, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import NavTree from "./NavTree";
import { REPORTS_MENU } from "./reportsMenuConfig";
import "./Sidebar.css";

export default function Sidebar({ sidebarOpen, setSidebarOpen }) {
  const location = useLocation();
  const navigate = useNavigate();

  function handleLogout() {
    if (!window.confirm("Log out of the accounting system?")) return;
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    navigate("/login");
  }

  const [openFileSetup, setOpenFileSetup] = useState(false);
  const [openBeginningBalances, setOpenBeginningBalances] = useState(false);
  const [openTransactions, setOpenTransactions] = useState(false);
  const [openInvoice, setOpenInvoice] = useState(false);
  const [openReports, setOpenReports] = useState(false);

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
    { name: "Company Profile", path: "/company-profile" },
  ];

  const beginningBalanceItems = [
    { name: "GL Beginning Balance", path: "/beginning-balances/gl" },
    { name: "AR Beginning Balance", path: "/beginning-balances/ar" },
    { name: "AP Beginning Balance", path: "/beginning-balances/ap" },
  ];

  const invoiceItems = [
    { name: "Invoice", path: "/transactions/invoice" },
    { name: "Quotation", path: "/transactions/quotation" },
  ];

  const transactionItems = [
    { name: "Official Receipts", path: "/transactions/or" },
    { name: "Check Voucher", path: "/transactions/cv" },
    { name: "Journal Voucher", path: "/transactions/jv" },
    { name: "Accounts Payable Voucher", path: "/transactions/apv" },
    { name: "Purchase Order", path: "/transactions/purchase-order" },
    { name: "Petty Cash Voucher", path: "/transactions/petty-cash-voucher" },
    { name: "Debit Credit Memo", path: "/transactions/debit-credit-memo" },
  ];

  const isBeginningBalanceActive = beginningBalanceItems.some(
    (item) => location.pathname === item.path
  );

  const isInvoiceActive = invoiceItems.some(
    (item) => location.pathname === item.path
  );

  const closeAllDropdowns = () => {
    setOpenFileSetup(false);
    setOpenBeginningBalances(false);
    setOpenTransactions(false);
    setOpenInvoice(false);
    setOpenReports(false);
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

  const toggleInvoice = () => {
    setOpenInvoice((prev) => !prev);
  };

  const toggleReports = () => {
    setOpenReports((prev) => !prev);
    setOpenFileSetup(false);
    setOpenBeginningBalances(false);
    setOpenTransactions(false);
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
              <button
                type="button"
                className={`submenu-link submenu-parent ${
                  isInvoiceActive ? "active-submenu" : ""
                }`}
                onClick={toggleInvoice}
              >
                <span>Invoice</span>
                <span>{openInvoice ? "▾" : "▸"}</span>
              </button>

              {openInvoice && (
                <div className="nested-submenu">
                  {invoiceItems.map((item) => (
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
            <div className="submenu rt-submenu">
              <NavTree nodes={REPORTS_MENU} namespace="reports" />
            </div>
          )}

          <button type="button" className="nav-link sidebar-logout-button" onClick={handleLogout}>
            Logout
          </button>
        </nav>
      )}
    </aside>
  );
}
