/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/~oauth/],
      },
      manifest: {
        name: "守護神 — 物流コンプライアンス管理",
        short_name: "守護神",
        description: "2026年物流法改正対応。特定荷主規制・60日支払いルールを自動管理。",
        start_url: "/",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
        shortcuts: [
          {
            name: "組織設定",
            short_name: "設定",
            description: "組織情報の管理画面を開く",
            url: "/organization-settings",
          },
          {
            name: "新規発注",
            short_name: "発注",
            description: "新しい発注を作成する",
            url: "/orders",
          },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  optimizeDeps: {
    include: ["@tanstack/react-query"],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
}));
