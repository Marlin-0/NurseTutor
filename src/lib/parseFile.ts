import mammoth from "mammoth";
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).href;

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const OCR_THRESHOLD = 100;  // chars — below this, fall back to vision OCR
const OCR_DELAY_MS  = 10000; // ms between OCR calls — 6 RPM, conservative for free tier
const OCR_RETRY_MS  = 60000; // fallback wait if Retry-After header is missing (full minute reset)

// ─── Progress callback ────────────────────────────────────────────────────────

export type ProgressCallback = (
  message: string,
  current: number,
  total: number,
  warn?: boolean   // true when OCR failed and fell back to pdfjs text (or nothing)
) => void;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocChunk {
  label: string;
  text: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractText(file: File): Promise<string> {
  const chunks = await extractChunks(file);
  return chunks.map((c) => c.text).join("\n\n");
}

export async function extractChunks(
  file: File,
  onProgress?: ProgressCallback
): Promise<DocChunk[]> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf"))  return extractPdf(file, onProgress);
  if (name.endsWith(".pptx")) return extractPptx(file, onProgress);
  if (name.endsWith(".docx")) return extractDocx(file);
  if (IMAGE_EXTS.some((ext) => name.endsWith(ext))) return extractImage(file);

  return extractPlainText(file);
}

// ─── PDF ─────────────────────────────────────────────────────────────────────
// Text extraction per page; pages below OCR_THRESHOLD fall back to vision OCR.

async function extractPdf(file: File, onProgress?: ProgressCallback): Promise<DocChunk[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const total = pdf.numPages;
  const chunks: DocChunk[] = [];

  for (let i = 1; i <= total; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();

    if (text.length >= OCR_THRESHOLD) {
      onProgress?.(`Reading page ${i} of ${total}`, i, total);
      chunks.push({ label: `Page ${i}`, text });
    } else {
      onProgress?.(`OCR: page ${i} of ${total}`, i, total);
      try {
        const ocrText = await ocrPdfPageWithDelay(page);
        const combined = [text, ocrText].filter(Boolean).join(" ").trim();
        if (combined.length > 0) {
          chunks.push({ label: `Page ${i}`, text: combined });
        }
      } catch {
        onProgress?.(`OCR failed: page ${i} of ${total} — using extracted text only`, i, total, true);
        if (text.length > 0) {
          chunks.push({ label: `Page ${i}`, text });
        }
      }
    }
  }

  return chunks;
}

const MAX_PAGE_WIDTH = 1200; // px — wide enough for fine print, small enough for Groq's payload limit

async function ocrPdfPageWithDelay(page: pdfjsLib.PDFPageProxy): Promise<string> {
  await sleep(OCR_DELAY_MS);

  // Calculate scale so the rendered width never exceeds MAX_PAGE_WIDTH
  const baseViewport = page.getViewport({ scale: 1.0 });
  const scale = Math.min(1.5, MAX_PAGE_WIDTH / baseViewport.width);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  const base64 = canvas.toDataURL("image/jpeg", 0.8);
  return ocrWithRetry(base64);
}

// ─── PPTX ────────────────────────────────────────────────────────────────────
// Text from slide XML; slides below OCR_THRESHOLD have embedded images OCR'd.

async function extractPptx(file: File, onProgress?: ProgressCallback): Promise<DocChunk[]> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] ?? "0");
      const numB = parseInt(b.match(/\d+/)?.[0] ?? "0");
      return numA - numB;
    });

  const total = slideFiles.length;
  const chunks: DocChunk[] = [];

  for (let i = 0; i < total; i++) {
    const slideFile = slideFiles[i];
    const xml = await zip.files[slideFile].async("string");
    const matches = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)];
    const text = matches.map((m) => m[1]).join(" ").trim();
    const slideNum = parseInt(slideFile.match(/slide(\d+)/)?.[1] ?? `${i + 1}`);

    if (text.length >= OCR_THRESHOLD) {
      onProgress?.(`Reading slide ${i + 1} of ${total}`, i + 1, total);
      chunks.push({ label: `Slide ${i + 1}`, text });
    } else {
      onProgress?.(`OCR: slide ${i + 1} of ${total}`, i + 1, total);
      try {
        const ocrText = await ocrPptxSlide(zip, slideNum);
        const combined = [text, ocrText].filter(Boolean).join(" ").trim();
        if (combined.length > 0) {
          chunks.push({ label: `Slide ${i + 1}`, text: combined });
        }
      } catch {
        onProgress?.(`OCR failed: slide ${i + 1} of ${total} — using extracted text only`, i + 1, total, true);
        if (text.length > 0) {
          chunks.push({ label: `Slide ${i + 1}`, text });
        }
      }
    }
  }

  return chunks;
}

async function ocrPptxSlide(zip: JSZip, slideNum: number): Promise<string> {
  const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
  const relsFile = zip.files[relsPath];
  if (!relsFile) return "";

  const relsXml = await relsFile.async("string");

  // Parse all image relationships
  const imageTargets: string[] = [];
  const relMatches = [...relsXml.matchAll(/<Relationship[^/]*\/>/g)];
  for (const m of relMatches) {
    if (!m[0].includes("/image")) continue;
    const target = m[0].match(/Target="\.\.\/media\/([^"]+)"/)?.[1];
    if (target) imageTargets.push(`ppt/media/${target}`);
  }

  if (imageTargets.length === 0) return "";

  // OCR each image and combine results
  const ocrResults: string[] = [];
  for (const imgPath of imageTargets) {
    const imgFile = zip.files[imgPath];
    if (!imgFile) continue;
    try {
      const bytes = await imgFile.async("uint8array");
      const ext = imgPath.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
      const base64 = `data:${mime};base64,` + uint8ToBase64(bytes);
      await sleep(OCR_DELAY_MS);
      const result = await ocrWithRetry(base64);
      if (result.trim()) ocrResults.push(result.trim());
    } catch {
      // skip failed image
    }
  }

  return ocrResults.join("\n");
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

// ─── Shared OCR via Groq vision ───────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls the Groq vision API with automatic retry on 429.
 * Reads the Retry-After header so we wait exactly as long as Groq asks.
 * Retries up to MAX_RETRIES times before giving up.
 */
const MAX_RETRIES = 3;

async function ocrWithRetry(base64: string, attempt = 0): Promise<string> {
  const res = await fetch("/api/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
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
    // Respect Groq's Retry-After header; fall back to OCR_RETRY_MS if missing
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
    if (!/^[A-Z0-9]/.test(t)) return false;
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
      currentLabel = `Section ${sectionIndex++}: ${line.trim()}`;
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

function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
