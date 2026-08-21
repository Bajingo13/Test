import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { installAuthFetchGuard } from "./utils/installAuthFetchGuard";
import './theme.css'
import './index.css'

installAuthFetchGuard();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);