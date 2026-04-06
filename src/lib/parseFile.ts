import mammoth from "mammoth";
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).href;

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocChunk {
  label: string;   // e.g. "Page 3", "Section: Neurological Assessment", "Slide 7"
  text: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extracts structured chunks from a file.
 * Each chunk has a label (page/section/slide) and its text.
 */
export async function extractChunks(file: File): Promise<DocChunk[]> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".docx")) return extractDocxChunks(file);
  if (name.endsWith(".pptx")) return extractPptxChunks(file);
  if (name.endsWith(".pdf"))  return extractPdfChunks(file);
  if (IMAGE_EXTS.some((ext) => name.endsWith(ext))) return extractImageChunks(file);

  // Plain text — split by headings/sections
  const raw = await readAsText(file);
  return splitTextIntoChunks(raw);
}

/**
 * Flat text fallback — joins all chunks for cases that still need a string.
 */
export async function extractText(file: File): Promise<string> {
  const chunks = await extractChunks(file);
  return chunks.map((c) => `[${c.label}]\n${c.text}`).join("\n\n");
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function extractPdfChunks(file: File): Promise<DocChunk[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const chunks: DocChunk[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
    if (text.length > 20) {
      chunks.push({ label: `Page ${i}`, text });
    }
  }

  return chunks;
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────

async function extractDocxChunks(file: File): Promise<DocChunk[]> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return splitTextIntoChunks(result.value);
}

// ─── PPTX ─────────────────────────────────────────────────────────────────────

async function extractPptxChunks(file: File): Promise<DocChunk[]> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] ?? "0");
      const numB = parseInt(b.match(/\d+/)?.[0] ?? "0");
      return numA - numB;
    });

  const chunks: DocChunk[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async("string");
    const matches = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)];
    const text = matches.map((m) => m[1]).join(" ").trim();
    if (text.length > 10) {
      chunks.push({ label: `Slide ${i + 1}`, text });
    }
  }

  return chunks;
}

// ─── Image OCR ────────────────────────────────────────────────────────────────

async function extractImageChunks(file: File): Promise<DocChunk[]> {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY as string;

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract all text from this image exactly as it appears. Preserve headings, bullet points, and structure. Output only the extracted text — no commentary, no explanations.",
            },
            { type: "image_url", image_url: { url: base64 } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`OCR API error ${res.status}`);
  const data = await res.json();
  const text = data.choices[0].message.content as string;

  // Split the OCR result into sections too
  return splitTextIntoChunks(text, "Image");
}

// ─── Text section splitter ────────────────────────────────────────────────────

/**
 * Splits plain text into labelled section chunks.
 * Detects headings: ALL CAPS lines, lines ending with ":", numbered headings,
 * markdown headings (# / ##), and chapter/section markers.
 */
function splitTextIntoChunks(text: string, fallbackLabel = "Section"): DocChunk[] {
  const lines = text.split("\n");
  const chunks: DocChunk[] = [];

  let currentLabel = fallbackLabel;
  let currentLines: string[] = [];
  let sectionIndex = 1;

  const isHeading = (line: string): boolean => {
    const t = line.trim();
    if (!t || t.length > 120) return false;
    if (/^#{1,3}\s/.test(t)) return true;                          // markdown heading
    if (/^(chapter|section|unit|topic|part)\s+\d+/i.test(t)) return true;
    if (/^\d+[\.\)]\s+[A-Z]/.test(t)) return true;                 // "1. Heading" or "1) Heading"
    if (/^[A-Z][A-Z\s\-:]{4,}$/.test(t)) return true;              // ALL CAPS LINE
    if (/^[A-Z][^.!?]{3,60}:$/.test(t)) return true;               // "Heading:"
    return false;
  };

  for (const line of lines) {
    if (isHeading(line)) {
      // Save previous section if it has content
      const body = currentLines.join("\n").trim();
      if (body.length > 30) {
        chunks.push({ label: currentLabel, text: body });
      }
      currentLabel = line.trim().replace(/^#+\s*/, "");
      currentLines = [];
      sectionIndex++;
    } else {
      currentLines.push(line);
    }
  }

  // Push final section
  const body = currentLines.join("\n").trim();
  if (body.length > 30) {
    chunks.push({ label: currentLabel, text: body });
  }

  // If nothing was split (no headings found), fall back to paragraph chunks
  if (chunks.length <= 1) {
    return splitByParagraphs(text, fallbackLabel);
  }

  return chunks;
}

function splitByParagraphs(text: string, fallbackLabel: string): DocChunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40);

  return paragraphs.map((text, i) => ({
    label: `${fallbackLabel} ${i + 1}`,
    text,
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
