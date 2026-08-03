import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
// 标准多文件构建（适合 OpenResty / nginx 静态托管）。
//
// 部署说明：
// - 默认根目录部署：base 用 './'（相对路径），PWA 的 start_url/scope 也走相对，
//   子目录下同样可正常注册 Service Worker 与 manifest。
// - 若部署到子目录（如 http://域名/poluxis/），把 base 改成 '/poluxis/' 即可；
//   其余 PWA 配置（manifest.start_url、scope、SW 注册路径）都会被插件按 base 自动处理，
//   无需逐处手动加前缀。
export default defineConfig({
  base: "./",
  build: {
    assetsDir: "assets",
    chunkSizeWarningLimit: 1500,
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 自动在页面注入 manifest 链接与 SW 注册脚本（全版本 SPA 入口）。
      registerType: "autoUpdate",
      // 把静态资源（图标）纳入预缓存清单。
      includeAssets: ["icons/icon.svg", "icons/icon-maskable.svg"],
      manifest: {
        name: "Project:Poluxis",
        short_name: "Poluxis",
        description: "简约风格 3D 音乐节奏游戏",
        theme_color: "#0b1120",
        background_color: "#0a0d12",
        display: "standalone",
        // 相对 start_url：根目录或子目录部署都能正确作为 PWA 起点。
        start_url: ".",
        scope: ".",
        icons: [
          {
            src: "icons/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "icons/icon-maskable.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // 预缓存应用外壳（JS/CSS/HTML/字体/图标）。
        globPatterns: ["**/*.{js,css,html,svg,woff2,ttf}"],
        // 外部内容（谱面 / 音效）体积可能较大且不固定，走运行时缓存而非预缓存。
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/beatmaps/"),
            handler: "CacheFirst",
            options: {
              cacheName: "poluxis-beatmaps",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes("/sounds/"),
            handler: "CacheFirst",
            options: {
              cacheName: "poluxis-sounds",
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
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
