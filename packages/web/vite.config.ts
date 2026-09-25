import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-ignore - vite-plugin-monaco-editor 类型定义不完整
import monacoEditorPlugin from "vite-plugin-monaco-editor";

export default defineConfig({
  plugins: [
    react(),
    (monacoEditorPlugin as any).default({
      languageWorkers: ["editorWorkerService", "typescript", "json"],
    }),
  ],
  server: {
    port: 3000,
    host: "0.0.0.0",
    // 浏览器经预览代理访问 web(3000)，无法直连 orchestrator(3001)。
    // 通过 Vite 代理把 /ws、/preview/* 转发到同主机的 orchestrator。
    proxy: {
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
        changeOrigin: true,
      },
      "/preview": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
