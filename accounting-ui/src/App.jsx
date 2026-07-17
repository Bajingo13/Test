import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import Sidebar from "./components/sidebar/sidebar";
import Dashboard from "./pages/DASHBOARD/dashboard";
import COA from "./pages/FILESETUP/COA";
import GenLib from "./pages/FILESETUP/GenLib";
import GroupCodes from "./pages/FILESETUP/GroupCodes";
import Login from "./pages/login/login";

// FILE SETUP
import Industry from "./pages/FILESETUP/Industry";
import CategoryCode from "./pages/FILESETUP/CategoryCode";
import BeginningBalance from "./pages/FILESETUP/BeginningBalance";
import BeginningBalanceGL from "./pages/FILESETUP/BeginningBalanceGL";
import BeginningBalanceAR from "./pages/FILESETUP/BeginningBalanceAR";
import BeginningBalanceAP from "./pages/FILESETUP/BeginningBalanceAP";
import BookTemplate from "./pages/FILESETUP/BookTemplate";
import ParticularsTemplate from "./pages/FILESETUP/ParticularsTemplate";
import BankCodes from "./pages/FILESETUP/BankCodes";
import TransactionSetup from "./pages/FILESETUP/TransactionSetup";
import AdditionalFileSetup from "./pages/FILESETUP/AdditionalFileSetup";
import TaxFileSetup from "./pages/FILESETUP/TaxFileSetup";
import EWTLibrary from "./pages/FILESETUP/EWTLibrary";
import FixedAssetSetup from "./pages/FILESETUP/FixedAssetSetup";
import PrepaidAccountSetup from "./pages/FILESETUP/PrepaidAccountSetup";
import CompanyProfile from "./pages/FILESETUP/CompanyProfile";


// TRANSACTIONS
import Invoice from "./pages/TRANSACTIONS/Invoice";
import APV from "./pages/TRANSACTIONS/APV";
import CV from "./pages/TRANSACTIONS/CV";
import JV from "./pages/TRANSACTIONS/JV";
import OR from "./pages/TRANSACTIONS/OR";
import JournalEntry from "./pages/TRANSACTIONS/JournalEntry";
import PettyCashVoucher from "./pages/TRANSACTIONS/PettyCashVoucher";
import DebitCreditMemo from "./pages/TRANSACTIONS/DebitCreditMemo";
import PurchaseOrder from "./pages/TRANSACTIONS/PurchaseOrder";
import Quotation from "./pages/TRANSACTIONS/Quotation";

// POSTING
import Posting from "./pages/POSTING/Posting";


// REPORTS
import ReportPage from "./pages/REPORTS/ReportPage";
import TrialBalance from "./pages/REPORTS/TrialBalance";
import AccountAnalysis from "./pages/REPORTS/AccountAnalysis";
import { IncomeStatement } from "./pages/REPORTS/IncomeStatement.jsx";
import BalanceSheet from "./pages/REPORTS/BalanceSheet.jsx";
import BankReconciliation from "./pages/REPORTS/BankReconciliation.jsx";
import ComparativeIncomeStatement from "./pages/REPORTS/ComparativeIncomeStatement.jsx";
import ARAgingReport from "./pages/REPORTS/ARAging.jsx";
import APAgingReport from "./pages/REPORTS/APAging.jsx";
import InputVAT from "./pages/REPORTS/InputVAT.jsx";
import OutputVAT from "./pages/REPORTS/OutputVAT.jsx";
import SubsidiaryLedger from "./pages/REPORTS/SubsidiaryLedger.jsx";
import FixedAssetReport from "./pages/REPORTS/FixedAssetReport.jsx";
import ListOfPrepaidAccounts from "./pages/REPORTS/ListOfPrepaidAccounts.jsx";
import PrepaymentLapsingReport from "./pages/REPORTS/PrepaymentLapsingReport.jsx";
import PrepaidSubsidiary from "./pages/REPORTS/PrepaidSubsidiary.jsx";
import ListOfLapsedPrepayments from "./pages/REPORTS/ListOfLapsedPrepayments.jsx";
import MonthlyFinalTaxAlphalist from "./pages/REPORTS/MonthlyFinalTaxAlphalist.jsx";
import MonthlyExpandedTaxAlphalist from "./pages/REPORTS/MonthlyExpandedTaxAlphalist.jsx";
import Form2307 from "./pages/REPORTS/Form2307.jsx";

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

  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: "Arial, sans-serif",
      }}
    >
      {!isLoginPage && (
        <Sidebar sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen} />
      )}

      <main
        style={{
          marginLeft: isLoginPage ? "0" : sidebarOpen ? "270px" : "110px",
          padding: isLoginPage ? "0" : "24px",
          flex: 1,
          background: isLoginPage ? "transparent" : "#f3f4f6",
          boxSizing: "border-box",
          minHeight: "100vh",
          transition: "margin-left 0.3s ease",
        }}
      >
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<Dashboard />} />

          <Route path="/coa" element={<COA />} />
          <Route path="/general-libraries" element={<GenLib />} />
          <Route path="/group-code" element={<GroupCodes />} />
          <Route path="/group-codes" element={<GroupCodes />} />
          <Route path="/industry" element={<Industry />} />
          <Route path="/category-code" element={<CategoryCode />} />
          <Route path="/beginning-balances" element={<BeginningBalance />} />
          <Route path="/book-template" element={<BookTemplate />} />
          <Route path="/particulars-template" element={<ParticularsTemplate />} />
          <Route path="/bank-codes" element={<BankCodes />} />
          <Route path="/transaction-setup" element={<TransactionSetup />} />
          <Route path="/additional-file-setup" element={<AdditionalFileSetup />} />
          <Route path="/tax-file-setup" element={<TaxFileSetup />} />
          <Route path="/ewt-library" element={<EWTLibrary />} />
          <Route path="/fixed-asset-setup" element={<FixedAssetSetup />} />
          <Route path="/prepaid-account-setup" element={<PrepaidAccountSetup />} />
          <Route path="/company-profile" element={<CompanyProfile />} />

          <Route path="/transactions/invoice" element={<Invoice />} />
          <Route path="/transactions/cv" element={<CV />} />
          <Route path="/transactions/jv" element={<JV />} />
          <Route path="/transactions/or" element={<OR />} />
          <Route path="/transactions/apv" element={<APV />} />
          <Route path="/transactions/accounts-payable-voucher" element={<APV />} />
          <Route path="/transactions/petty-cash-voucher" element={<PettyCashVoucher />} />
          <Route path="/transactions/debit-credit-memo" element={<DebitCreditMemo />} />
          <Route path="/transactions/journalization" element={<PlaceholderPage title="Journalization" />} />
          <Route path="/transactions/journal-entry" element={<JournalEntry />} />
          <Route path="/transactions/purchase-order" element={<PurchaseOrder />} />
          <Route path="/transactions/quotation" element={<Quotation />} />

          <Route path="/posting" element={<Posting />} />
          <Route path="/ledger" element={<PlaceholderPage title="Ledger" />} />

          <Route path="/reports" element={<Navigate to="/reports/trial-balance" replace />} />
          <Route path="/reports/trial-balance" element={<TrialBalance />} />
          <Route path="/reports/account-analysis" element={<AccountAnalysis />} />
          <Route path="/reports/bank-reconciliation" element={<ReportPage title="Bank Reconciliation" />} />
          <Route path="/reports/balance-sheet" element={<BalanceSheet />} />
          <Route path="/reports/income-statement" element={<IncomeStatement />} />
          <Route path="/reports/ar-aging" element={<ARAgingReport />} />
          <Route path="/reports/ap-aging" element={<APAgingReport />} />
          <Route path="/reports/input-vat-report" element={<InputVAT />} />
          <Route path="/reports/output-vat-report" element={<OutputVAT />} />
          <Route path="/reports/subsidiary-ledger" element={<SubsidiaryLedger />} />
          <Route path="/reports/fixed-asset-register" element={<FixedAssetReport />} />
          <Route path="/reports/prepaid-accounts-list" element={<ListOfPrepaidAccounts />} />
          <Route path="/reports/prepayment-lapsing" element={<PrepaymentLapsingReport />} />
          <Route path="/reports/prepaid-subsidiary" element={<PrepaidSubsidiary />} />
          <Route path="/reports/lapsed-prepayments" element={<ListOfLapsedPrepayments />} />
          <Route path="/reports/final-withholding-tax-report" element={<MonthlyFinalTaxAlphalist />} />
          <Route path="/reports/2307" element={<Form2307 />} />
          <Route path="/reports/expanded-withholding-tax-report" element={<MonthlyExpandedTaxAlphalist />} />

          <Route
  path="/beginning-balances/gl"
  element={<BeginningBalanceGL />}
/>

<Route
  path="/beginning-balances/ar"
  element={<BeginningBalanceAR />}
/>

<Route
  path="/beginning-balances/ap"
  element={<BeginningBalanceAP />}
/>
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