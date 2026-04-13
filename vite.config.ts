import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import type { Plugin, IncomingMessage, ServerResponse } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Local dev proxy ──────────────────────────────────────────────────────────
// In production, /api/chat and /api/ocr are Vercel serverless functions.
// In local dev, this Vite plugin intercepts those routes:
//   /api/chat → Groq (GROQ_API_KEY)
//   /api/ocr  → Gemini Flash (GEMINI_API_KEY), with OpenAI↔Gemini format translation
function apiProxyPlugin(): Plugin {
  let groqKey: string | undefined;
  let geminiKey: string | undefined;
  return {
    name: "api-proxy",
    config(_, { mode }) {
      const env = loadEnv(mode, process.cwd(), "");
      groqKey   = env.GROQ_API_KEY;
      geminiKey = env.GEMINI_API_KEY;
    },
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        // ── /api/chat → Groq ────────────────────────────────────────────────
        if (req.url === "/api/chat") {
          if (!groqKey) {
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
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
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
          return;
        }

        // ── /api/ocr → Gemini Flash (OpenAI↔Gemini adapter) ────────────────
        if (req.url === "/api/ocr") {
          if (!geminiKey) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "GEMINI_API_KEY not set in .env" }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", async () => {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const userContent = body.messages?.[0]?.content ?? [];
            const textPart  = userContent.find((p: { type: string }) => p.type === "text");
            const imagePart = userContent.find((p: { type: string }) => p.type === "image_url");

            if (!textPart || !imagePart) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing text or image content" }));
              return;
            }

            const dataUrl   = imagePart.image_url.url;
            const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
            const mimeType  = mimeMatch?.[1] ?? "image/jpeg";
            const rawBase64 = mimeMatch ? dataUrl.slice(mimeMatch[0].length) : dataUrl;

            const geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [
                    { text: textPart.text },
                    { inline_data: { mime_type: mimeType, data: rawBase64 } },
                  ]}],
                  generationConfig: { maxOutputTokens: body.max_tokens ?? 4096 },
                }),
              }
            );

            if (geminiRes.status === 429) {
              const retryAfter = geminiRes.headers.get("retry-after") ?? "4";
              res.writeHead(429, { "Content-Type": "application/json", "retry-after": retryAfter });
              res.end(JSON.stringify({ error: "Rate limited" }));
              return;
            }

            if (!geminiRes.ok) {
              const errText = await geminiRes.text().catch(() => "");
              res.writeHead(geminiRes.status, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Gemini error ${geminiRes.status}`, detail: errText }));
              return;
            }

            const geminiData = await geminiRes.json() as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            };
            const extractedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: extractedText } }] }));
          });
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiProxyPlugin()],
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
