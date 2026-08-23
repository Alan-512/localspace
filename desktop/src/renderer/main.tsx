import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { getDesktopApi } from "./api.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  document.body.textContent = "初始化失败：找不到挂载点。";
} else {
  createRoot(container).render(<App api={getDesktopApi()} />);
}
