import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
// 标准多文件构建（适合 OpenResty / nginx 静态托管）。
// 若部署到子目录（如 http://域名/poly/），把 base 改成 '/poly/' 即可。
export default defineConfig({
  base: "./",
  build: {
    assetsDir: "assets",
    chunkSizeWarningLimit: 1500,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 61616,
    host: true,
  },
});
