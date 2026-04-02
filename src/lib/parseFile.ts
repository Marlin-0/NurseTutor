import mammoth from "mammoth";
import JSZip from "jszip";

/**
 * Extracts plain text from any supported file type.
 * Supports: .txt, .md, .csv, .rtf, .pdf, .docx, .pptx
 */
export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".docx")) return extractDocx(file);
  if (name.endsWith(".pptx")) return extractPptx(file);
  // Plain text formats
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function extractDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractPptx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Collect slide XML files in order
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
    // Extract all <a:t> text nodes
    const matches = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)];
    const text = matches.map((m) => m[1]).join(" ").trim();
    if (text) pages.push(text);
  }

  return pages.join("\n\n");
}
