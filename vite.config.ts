import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    host: "127.0.0.1",
    // Proxy API + health to the Hono dev server so the Vite-served UI can
    // reach the backend during `bun run client:dev`. Run `bun run dev` too.
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/health": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
})
