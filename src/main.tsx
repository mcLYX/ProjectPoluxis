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

// 启动标记：供 index.html 的"看门狗"判断完整版是否真的跑起来了。
// 若模块脚本因语法过旧而解析失败（或资源被拦截），本文件根本不会执行、标记不会
// 置位，看门狗就会用兜底卡片提示——无需预先知道具体的 Chrome 版本号。
(window as unknown as { __POLUXIS_BOOTED__?: boolean }).__POLUXIS_BOOTED__ = true;
