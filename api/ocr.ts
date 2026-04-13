export const config = { runtime: "edge" };

// Adapter: accepts OpenAI-compatible vision requests from parseFile.ts,
// translates to Gemini format, and returns an OpenAI-compatible response.

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured" }), { status: 500 });
  }

  // ── Parse incoming OpenAI-format request ─────────────────────────────────────
  let body: {
    max_tokens?: number;
    messages: Array<{
      role: string;
      content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
    }>;
  };

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const userContent = body.messages?.[0]?.content ?? [];
  const textPart   = userContent.find((p) => p.type === "text") as { type: "text"; text: string } | undefined;
  const imagePart  = userContent.find((p) => p.type === "image_url") as { type: "image_url"; image_url: { url: string } } | undefined;

  if (!textPart || !imagePart) {
    return new Response(JSON.stringify({ error: "Missing text or image content" }), { status: 400 });
  }

  // ── Strip data URI prefix to get raw base64 + mime type ──────────────────────
  const dataUrl  = imagePart.image_url.url;              // e.g. "data:image/jpeg;base64,/9j/..."
  const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
  const mimeType  = mimeMatch?.[1] ?? "image/jpeg";
  const rawBase64 = mimeMatch ? dataUrl.slice(mimeMatch[0].length) : dataUrl;

  // ── Build Gemini request ──────────────────────────────────────────────────────
  const geminiBody = {
    contents: [{
      parts: [
        { text: textPart.text },
        { inline_data: { mime_type: mimeType, data: rawBase64 } },
      ],
    }],
    generationConfig: {
      maxOutputTokens: body.max_tokens ?? 4096,
    },
  };

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    }
  );

  const headers = new Headers({ "Content-Type": "application/json" });

  // ── Handle rate limits (Gemini returns 429 too) ───────────────────────────────
  if (geminiRes.status === 429) {
    const retryAfter = geminiRes.headers.get("retry-after") ?? "4";
    headers.set("retry-after", retryAfter);
    return new Response(JSON.stringify({ error: "Rate limited" }), { status: 429, headers });
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => "");
    return new Response(JSON.stringify({ error: `Gemini error ${geminiRes.status}`, detail: errText }), {
      status: geminiRes.status,
      headers,
    });
  }

  // ── Translate Gemini response → OpenAI-compatible format ─────────────────────
  const geminiData = await geminiRes.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const extractedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  return new Response(
    JSON.stringify({
      choices: [{ message: { content: extractedText } }],
    }),
    { status: 200, headers }
  );
}
