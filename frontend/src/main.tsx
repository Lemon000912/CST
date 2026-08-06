import React from "react";
import ReactDOM from "react-dom/client";
import AuthGate from "./AuthGate";
import { ThemeProvider } from "./theme";
import "./index.css";

// 错误日志上报功能
const API_BASE_URL = '/api/v1';

async function reportError(level: string, message: string, stack?: string) {
  try {
    await fetch(`${API_BASE_URL}/client/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level,
        message,
        stack,
        userAgent: navigator.userAgent,
        url: window.location.href,
        timestamp: new Date().toISOString()
      })
    });
  } catch (e) {
    console.error('上报错误失败:', e);
  }
}

// 全局错误捕获
window.addEventListener('error', (event) => {
  reportError('error', event.message, event.error?.stack);
});

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason?.message || String(event.reason);
  const stack = event.reason?.stack;
  reportError('error', message, stack);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthGate />
    </ThemeProvider>
  </React.StrictMode>,
);
