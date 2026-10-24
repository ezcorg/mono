import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/ — tailored for Tauri (fixed port, ignore src-tauri).
export default defineConfig(async () => ({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
