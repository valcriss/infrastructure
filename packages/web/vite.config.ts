import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const consoleUrl = process.env.CONSOLE_DEV_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    proxy: {
      "/api": consoleUrl,
      "/status": consoleUrl,
    },
  },
});
