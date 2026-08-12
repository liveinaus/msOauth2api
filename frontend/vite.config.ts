import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const backend = `http://${process.env.BACKEND_HOST ?? "localhost"}:${process.env.BACKEND_PORT ?? 3000}`;

export default defineConfig({
  plugins: [vue()],
  server: {
    allowedHosts: true,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
