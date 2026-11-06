import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const consoleUrl = process.env.CONSOLE_DEV_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    proxy: {
      // Host inchangé : la console refuse les requêtes dont l'Origin ne correspond pas à l'hôte demandé.
      "/api": { target: consoleUrl, changeOrigin: false },
      "/status": { target: consoleUrl, changeOrigin: false },
    },
  },
});
