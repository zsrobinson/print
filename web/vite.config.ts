import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  optimizeDeps: {
    // Shell ships TypeScript source; keep its entry points in one module graph.
    exclude: ["@zsrobinson/shell"],
    include: [
      "use-sync-external-store/shim",
      "use-sync-external-store/shim/with-selector",
    ],
  },
  server: {
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 8787}` },
  },
  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunks stay cached across app deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return
          if (
            id.includes("recharts") ||
            id.includes("d3-") ||
            id.includes("victory-vendor")
          )
            return "charts"
          if (id.includes("@base-ui") || id.includes("@floating-ui"))
            return "base-ui"
          if (id.includes("@tanstack")) return "tanstack"
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return "react"
        },
      },
    },
  },
})
