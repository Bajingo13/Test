import { Link, useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import NavTree from "./NavTree";
import { REPORTS_MENU } from "./reportsMenuConfig";
import { FILE_SETUP_MENU } from "./fileSetupMenuConfig";
import { TRANSACTIONS_MENU } from "./transactionsMenuConfig";
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
  const [openTransactions, setOpenTransactions] = useState(false);
  const [openReports, setOpenReports] = useState(false);

  const closeAllDropdowns = () => {
    setOpenFileSetup(false);
    setOpenTransactions(false);
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

  const toggleTransactions = () => {
    setOpenTransactions((prev) => !prev);
    setOpenFileSetup(false);
    setOpenReports(false);
  };

  const toggleReports = () => {
    setOpenReports((prev) => !prev);
    setOpenFileSetup(false);
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
            <div className="submenu rt-submenu">
              <NavTree nodes={FILE_SETUP_MENU} namespace="file-setup" />
            </div>
          )}

          <button type="button" className="nav-section-btn" onClick={toggleTransactions}>
            <span>Transactions</span>
            <span>{openTransactions ? "▾" : "▸"}</span>
          </button>

          {openTransactions && (
            <div className="submenu rt-submenu">
              <NavTree nodes={TRANSACTIONS_MENU} namespace="transactions" />
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
