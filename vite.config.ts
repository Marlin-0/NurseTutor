import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import type { Plugin, IncomingMessage, ServerResponse } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Local dev proxy for Groq API calls ───────────────────────────────────────
// In production, /api/chat and /api/ocr are handled by Vercel serverless functions.
// In local dev, this Vite plugin intercepts those routes and proxies to Groq
// using GROQ_API_KEY from .env — the key never enters the browser bundle.
function groqProxyPlugin(): Plugin {
  let apiKey: string | undefined;
  return {
    name: "groq-proxy",
    config(_, { mode }) {
      const env = loadEnv(mode, process.cwd(), "");
      apiKey = env.GROQ_API_KEY;
    },
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        if (req.url !== "/api/chat" && req.url !== "/api/ocr") return next();
        if (!apiKey) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "GROQ_API_KEY not set in .env" }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", async () => {
          const body = Buffer.concat(chunks).toString();
          const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body,
          });

          res.writeHead(groqRes.status, {
            "Content-Type": "application/json",
            ...(groqRes.headers.get("retry-after")
              ? { "retry-after": groqRes.headers.get("retry-after")! }
              : {}),
          });
          res.end(await groqRes.text());
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), groqProxyPlugin()],
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 3000,
  },
});
