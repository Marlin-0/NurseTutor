import mammoth from "mammoth";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const OCR_RETRY_MS  = 15000; // fallback wait if Retry-After header is missing

// ─── Progress callback ────────────────────────────────────────────────────────

export type ProgressCallback = (
  message: string,
  current: number,
  total: number,
  warn?: boolean
) => void;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocChunk {
  label: string;
  text: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    // Return raw mammoth text for DOCX — bypasses splitIntoTopics so
    // week labels ("Week 1", "Week 2") aren't silently discarded as empty-body headings.
    // parseSyllabus needs the full unmodified text to extract the course schedule correctly.
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }
  const chunks = await extractChunks(file);
  return chunks.map((c) => c.text).join("\n\n");
}

export async function extractChunks(
  file: File,
  onProgress?: ProgressCallback
): Promise<DocChunk[]> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf") || name.endsWith(".pptx")) return extractViaLlamaParse(file, onProgress);
  if (name.endsWith(".docx")) return extractDocx(file);
  if (IMAGE_EXTS.some((ext) => name.endsWith(ext))) return extractImage(file);

  return extractPlainText(file);
}

// ─── LlamaParse (PDF + PPTX) ──────────────────────────────────────────────────

async function extractViaLlamaParse(file: File, onProgress?: ProgressCallback): Promise<DocChunk[]> {
  // Step 1: Upload file, get job ID
  onProgress?.("Uploading to LlamaParse...", 0, 1);
  const formData = new FormData();
  formData.append("file", file);

  const uploadRes = await fetch("/api/parse", { method: "POST", body: formData });
  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({})) as { error?: string };
    throw new Error(`Parse upload failed: ${err.error ?? uploadRes.status}`);
  }
  const { jobId } = await uploadRes.json() as { jobId: string };

  // Step 2: Poll for completion — max 150s (50 polls × 3s)
  const MAX_POLLS = 50;
  const POLL_INTERVAL = 3000;
  let markdown = "";

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL);
    const elapsed = Math.round((i + 1) * POLL_INTERVAL / 1000);
    onProgress?.(`Parsing document... (${elapsed}s)`, i + 1, MAX_POLLS);

    const resultRes = await fetch(`/api/parse-result?id=${jobId}`);
    if (!resultRes.ok) throw new Error(`Parse result failed: ${resultRes.status}`);
    const result = await resultRes.json() as { status: string; markdown?: string };

    if (result.status === "SUCCESS") { markdown = result.markdown ?? ""; break; }
    if (result.status === "ERROR")   { throw new Error("LlamaParse processing failed"); }
    // PENDING — keep polling
  }

  if (!markdown) throw new Error("LlamaParse timed out after 150 seconds");

  // Step 3: Split markdown into chunks
  onProgress?.("Processing...", 1, 1);
  return splitMarkdownIntoChunks(markdown);
}

// ─── Markdown → chunks ────────────────────────────────────────────────────────
// LlamaParse separates pages with "\n---\n" and uses # headings within pages.

function splitMarkdownIntoChunks(markdown: string): DocChunk[] {
  const pages = markdown.split(/\n---\n/).map((p) => p.trim()).filter((p) => p.length > 0);

  if (pages.length > 1) {
    // Multi-page document — one chunk per page
    return pages.map((text, i) => ({ label: `Page ${i + 1}`, text }));
  }

  // Single block (short doc) — fall back to heading-based splitting
  return splitIntoTopics(markdown);
}

// ─── DOCX ────────────────────────────────────────────────────────────────────

async function extractDocx(file: File): Promise<DocChunk[]> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return splitIntoTopics(result.value);
}

// ─── Plain text ───────────────────────────────────────────────────────────────

async function extractPlainText(file: File): Promise<DocChunk[]> {
  const text = await readAsText(file);
  return splitIntoTopics(text);
}

// ─── Image (standalone upload) ────────────────────────────────────────────────

async function extractImage(file: File): Promise<DocChunk[]> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const text = await ocrWithRetry(base64);
  return [{ label: file.name, text }];
}

// ─── Shared OCR via Gemini (standalone images only) ──────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;

async function ocrWithRetry(base64: string, attempt = 0): Promise<string> {
  const res = await fetch("/api/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemini-2.0-flash",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "This is a page from a medical or nursing educational document. Extract every piece of text you can see — headings, bullet points, labels, captions, annotations, and body text. Preserve the structure. If there are diagrams or images, describe what they show in 1–2 sentences. Output only the extracted text and descriptions — no commentary.",
            },
            { type: "image_url", image_url: { url: base64 } },
          ],
        },
      ],
    }),
  });

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfterSec = parseFloat(res.headers.get("retry-after") ?? "");
    const waitMs = (Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : OCR_RETRY_MS) + 500;
    await sleep(waitMs);
    return ocrWithRetry(base64, attempt + 1);
  }

  if (!res.ok) throw new Error(`OCR error ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content as string;
}

// ─── Topic splitting (DOCX / plain text) ─────────────────────────────────────

function splitIntoTopics(text: string): DocChunk[] {
  const lines = text.split("\n");
  const chunks: DocChunk[] = [];
  let currentLabel = "Introduction";
  let currentLines: string[] = [];
  let sectionIndex = 1;

  const isHeading = (line: string): boolean => {
    const t = line.trim();
    if (t.length === 0 || t.length > 80) return false;
    if (/[.!?]$/.test(t)) return false;
    if (!/^[A-Z0-9#]/.test(t)) return false;
    if (t.split(/\s+/).length > 12) return false;
    return true;
  };

  const flush = () => {
    const body = currentLines.join("\n").trim();
    if (body.length > 0) chunks.push({ label: currentLabel, text: body });
  };

  for (const line of lines) {
    if (isHeading(line)) {
      flush();
      currentLabel = `Section ${sectionIndex++}: ${line.trim().replace(/^#+\s*/, "")}`;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  if (chunks.length <= 1 && text.length > 500) {
    return groupByWordCount(text, 300);
  }

  return chunks;
}

function groupByWordCount(text: string, targetWords: number): DocChunk[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const chunks: DocChunk[] = [];
  let current: string[] = [];
  let wordCount = 0;
  let chunkIndex = 1;

  const flush = () => {
    const body = current.join("\n\n").trim();
    if (body.length > 0) chunks.push({ label: `Section ${chunkIndex++}`, text: body });
    current = [];
    wordCount = 0;
  };

  for (const para of paragraphs) {
    const words = para.split(/\s+/).length;
    if (wordCount + words > targetWords && current.length > 0) flush();
    current.push(para);
    wordCount += words;
  }
  flush();

  return chunks;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
