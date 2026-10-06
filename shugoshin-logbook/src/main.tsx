import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// PWA Service Worker guard: prevent SW interference when embedded in an iframe
const isInIframe = (() => {
  try { return window.self !== window.top; } catch { return true; }
})();
if (isInIframe) {
  navigator.serviceWorker?.getRegistrations().then(r => r.forEach(sw => sw.unregister()));
}

createRoot(document.getElementById("root")!).render(<App />);
