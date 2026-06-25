import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: path.resolve("ui"),
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4310"
    }
  },
  build: {
    outDir: path.resolve("public"),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/maximal-[hash].js",
        chunkFileNames: "assets/chunk-[hash].js",
        assetFileNames: "assets/maximal-[hash][extname]",
        manualChunks: {
          mui: ["@mui/material", "@mui/icons-material", "@emotion/react", "@emotion/styled"]
        }
      }
    }
  }
});
