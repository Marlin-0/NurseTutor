export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not configured" }), { status: 500 });
  }

  const body = await req.text();

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  const headers = new Headers({ "Content-Type": "application/json" });
  const retryAfter = groqRes.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);

  const data = await groqRes.text();
  return new Response(data, { status: groqRes.status, headers });
}
