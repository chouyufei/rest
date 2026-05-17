import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (err) => {
            // 后端未启动 / 重启时的常见瞬态错误，静默忽略
            if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
                (err as NodeJS.ErrnoException).code === "EPIPE") return;
            console.warn("[proxy /api]", err.message);
          });
        },
      },
      "/ws": {
        target: "ws://localhost:8000",
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
                (err as NodeJS.ErrnoException).code === "EPIPE") return;
            console.warn("[proxy /ws]", err.message);
          });
        },
      },
    },
  },
});
