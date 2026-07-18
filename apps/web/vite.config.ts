import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Canonical shadcn/ui alias — `@/` resolves to apps/web/src. Mirrored in
    // tsconfig.json (paths) and vitest.config.ts (test resolve) so imports
    // resolve identically under the app build, typecheck, and unit tests.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Keep the heavy markdown/katex/highlight chunks OUT of the entry's
    // <link rel="modulepreload"> list. They're only reachable through the lazy
    // MarkdownImpl import, so Vite would otherwise eagerly preload them on first
    // paint — defeating the split. Dropping the hint defers the fetch to the
    // moment a transcript first renders (the dynamic import still pulls them in),
    // which is exactly the on-demand behavior we want.
    modulePreload: {
      resolveDependencies: (_filename, deps) =>
        deps.filter((d) => !/vendor-(katex|highlight|markdown)/.test(d)),
    },
    rollupOptions: {
      output: {
        // Split big, rarely-changing vendor code into its own cacheable chunks so
        // the app shell stays small and a dependency bump doesn't bust the whole
        // bundle's cache. Each heavy group is keyed off its node_modules path; the
        // markdown stack (react-markdown + remark/rehype + katex + highlight.js)
        // already lazy-loads from src/components/MarkdownImpl, so these land in
        // their own on-demand chunks rather than the initial paint.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "vendor-react";
          }
          // Just the raw KaTeX engine — the big, self-contained typesetter. Its
          // rehype glue (rehype-katex) stays with the markdown chunk below to
          // avoid a circular import between the two vendor chunks.
          if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) {
            return "vendor-katex";
          }
          if (/[\\/]node_modules[\\/](highlight\.js|lowlight|rehype-highlight)[\\/]/.test(id)) {
            return "vendor-highlight";
          }
          if (
            /[\\/]node_modules[\\/](react-markdown|rehype-katex|remark-gfm|remark-math|remark-.*|mdast-.*|micromark.*|unified|unist-.*|hast-.*|vfile.*|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities.*|trim-lines|ccount|markdown-table|escape-string-regexp|html-url-attributes|trough|bail|devlop|is-plain-obj|zwitch|longest-streak|estree-.*)[\\/]/.test(
              id,
            )
          ) {
            return "vendor-markdown";
          }
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) {
            return "vendor-icons";
          }
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true, // upgrade the live-chat WebSocket (/api/ws/session)
        // keep SSE streaming (no buffering)
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
            }
          });
        },
      },
    },
  },
});
