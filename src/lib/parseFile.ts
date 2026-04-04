import mammoth from "mammoth";
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";

// Point the worker at the bundled worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).href;

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

/**
 * Extracts plain text from any supported file type.
 * Supports: .txt, .md, .csv, .rtf, .docx, .pptx, .png, .jpg, .jpeg, .webp, .gif
 */
export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".docx")) return extractDocx(file);
  if (name.endsWith(".pptx")) return extractPptx(file);
  if (name.endsWith(".pdf")) return extractPdf(file);
  if (IMAGE_EXTS.some((ext) => name.endsWith(ext))) return extractImage(file);

  // Plain text formats
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function extractPdf(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .trim();
    if (pageText) pages.push(pageText);
  }

  return pages.join("\n\n");
}

async function extractDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractPptx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] ?? "0");
      const numB = parseInt(b.match(/\d+/)?.[0] ?? "0");
      return numA - numB;
    });

  const pages: string[] = [];

  for (const slideName of slideFiles) {
    const xml = await zip.files[slideName].async("string");
    const matches = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)];
    const text = matches.map((m) => m[1]).join(" ").trim();
    if (text) pages.push(text);
  }

  return pages.join("\n\n");
}

async function extractImage(file: File): Promise<string> {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY as string;

  // Convert image to base64 data URL
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
            {
              type: "image_url",
              image_url: { url: base64 },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`OCR API error ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content as string;
}
