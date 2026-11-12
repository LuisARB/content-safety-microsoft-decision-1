import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist", sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@azure/")) return "identity-vendor";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react-vendor";
        },
      },
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
