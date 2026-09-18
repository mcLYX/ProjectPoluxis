import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { I18nProvider } from "./i18n";
import { PlatformProvider } from "./platform/PlatformContext";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlatformProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </PlatformProvider>
  </StrictMode>
);
