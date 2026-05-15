import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Sidebar from "./components/Sidebar/Sidebar";
import Dashboard from "./pages/Dashboard/Dashboard";
import COA from "./pages/Filesetup/COA";
import GenLib from "./pages/Filesetup/GenLib";
import GroupCodes from "./pages/Filesetup/GroupCodes";
import Login from "./pages/login/login";

// TRANSACTIONS
import APV from "./pages/TRANSACTIONS/APV";
import CV from "./pages/TRANSACTIONS/CV";
import JV from "./pages/TRANSACTIONS/JV";
import OR from "./pages/TRANSACTIONS/OR";
import JournalEntry from "./pages/TRANSACTIONS/JournalEntry";

function PlaceholderPage({ title }) {
  return (
    <div>
      <h1>{title}</h1>
      <p>{title} page coming soon.</p>
    </div>
  );
}

function AppLayout() {
  const location = useLocation();
  const isLoginPage = location.pathname === "/login";

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: "Arial, sans-serif",
      }}
    >
      {!isLoginPage && <Sidebar />}

      <main
        style={{
          marginLeft: isLoginPage ? "0" : "270px",
          padding: isLoginPage ? "0" : "24px",
          flex: 1,
          background: isLoginPage ? "transparent" : "#f3f4f6",
          boxSizing: "border-box",
          minHeight: "100vh",
        }}
      >
        <Routes>
          {/* DEFAULT */}
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<Dashboard />} />

          {/* FILE SETUP */}
          <Route path="/coa" element={<COA />} />
          <Route path="/general-libraries" element={<GenLib />} />
          <Route path="/group-code" element={<GroupCodes />} />
          <Route path="/group-codes" element={<GroupCodes />} />
          <Route path="/industry" element={<PlaceholderPage title="Industry" />} />
          <Route path="/category-code" element={<PlaceholderPage title="Category Code" />} />
          <Route
            path="/beginning-balances"
            element={<PlaceholderPage title="Beginning Balances" />}
          />
          <Route
            path="/book-template"
            element={<PlaceholderPage title="Book Template" />}
          />
          <Route
            path="/particulars-template"
            element={<PlaceholderPage title="Particulars Template" />}
          />
          <Route path="/bank-codes" element={<PlaceholderPage title="Bank Codes" />} />
          <Route
            path="/transaction-setup"
            element={<PlaceholderPage title="Transaction Setup" />}
          />
          <Route
            path="/currency-file-setup"
            element={<PlaceholderPage title="Currency File Setup" />}
          />
          <Route
            path="/additional-file-setup"
            element={<PlaceholderPage title="Additional File Setup" />}
          />
          <Route
            path="/tax-file-setup"
            element={<PlaceholderPage title="Tax File Setup" />}
          />

          {/* TRANSACTIONS */}
          <Route path="/transactions/invoice" element={<PlaceholderPage title="Invoice" />} />
          <Route path="/transactions/cv" element={<CV />} />
          <Route path="/transactions/jv" element={<JV />} />
          <Route path="/transactions/or" element={<OR />} />
          <Route path="/transactions/apv" element={<APV />} />
          <Route
            path="/transactions/accounts-payable-voucher"
            element={<APV />}
          />
          <Route
            path="/transactions/petty-cash-voucher"
            element={<PlaceholderPage title="Petty Cash Voucher" />}
          />
          <Route
            path="/transactions/debit-credit-memo"
            element={<PlaceholderPage title="Debit Credit Memo" />}
          />
          <Route
            path="/transactions/journalization"
            element={<PlaceholderPage title="Journalization" />}
          />
          <Route path="/transactions/journal-entry" element={<JournalEntry />} />

          {/* ACCOUNTING / REPORTS */}
          <Route path="/posting" element={<PlaceholderPage title="Posting" />} />
          <Route path="/ledger" element={<PlaceholderPage title="Ledger" />} />
          <Route path="/reports" element={<PlaceholderPage title="Reports" />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}