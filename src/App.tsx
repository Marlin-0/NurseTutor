import React, { useState, useRef, useEffect, useCallback } from "react";

// ─── Dark mode hook ───────────────────────────────────────────────────────────

function useDarkMode(): [boolean, () => void] {
  const [isDark, setIsDark] = useState<boolean>(() => {
    const saved = localStorage.getItem("nursetutor-dark");
    if (saved !== null) return saved === "true";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    localStorage.setItem("nursetutor-dark", String(isDark));
  }, [isDark]);

  return [isDark, () => setIsDark((d) => !d)];
}
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import TeacherDashboard from "./TeacherDashboard";
import CaseStudyMode from "./cases/CaseStudyMode";
import { extractChunks, type ProgressCallback } from "./lib/parseFile";
import type { CaseTree } from "./types/case";
import { loadMediaDataUrl } from "./types/case";
import CaseTreeReveal from "./cases/CaseTreeReveal";

// ─── Types ────────────────────────────────────────────────────────────────────

type Role = "user" | "assistant";

interface TextMessage {
  id: string;
  role: Role;
  type: "text";
  content: string;
  sources?: Array<{ source: string; label: string; tier: "student" | "teacher" }>;
  createdAt?: number;
}

interface MCQMessage {
  id: string;
  role: "assistant";
  type: "mcq";
  question: string;
  options: Record<"A" | "B" | "C" | "D", string>;
  answer: "A" | "B" | "C" | "D";
  explanation: string;
  chosen?: "A" | "B" | "C" | "D";
}

interface SATAMessage {
  id: string;
  role: "assistant";
  type: "sata";
  question: string;
  options: Record<"A" | "B" | "C" | "D" | "E", string>;
  answers: Array<"A" | "B" | "C" | "D" | "E">;
  explanation: string;
  selected: Array<"A" | "B" | "C" | "D" | "E">;
  submitted: boolean;
}

interface MediaMessage {
  id: string;
  role: "assistant";
  type: "media";
  caption: string;
  mediaType: "image" | "audio";
  dataUrl: string;
  name: string;
  createdAt?: number;
}

type Message = TextMessage | MCQMessage | SATAMessage | MediaMessage;

interface ConversationTurn {
  role: Role;
  content: string;
}

/** Entry in the shared localStorage chunk pool */
interface PooledChunk {
  source: string;  // originating filename
  label: string;   // "Page 3", "Slide 7", "Section: Cardiac Meds"
  text: string;
}

/** Lightweight display record — full chunks live in the pool */
interface UploadedDoc {
  name: string;
  count: number; // number of chunks contributed to the pool
}

// ─── Chunk pool (localStorage) ────────────────────────────────────────────────

const POOL_KEY = "nursetutor-chunk-pool";
const PUBLISHED_POOL_KEY = "nursetutor-published-pool";

function loadPool(): PooledChunk[] {
  try {
    return JSON.parse(localStorage.getItem(POOL_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function loadPublishedPool(): PooledChunk[] {
  try {
    return JSON.parse(localStorage.getItem(PUBLISHED_POOL_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function savePool(pool: PooledChunk[]): void {
  localStorage.setItem(POOL_KEY, JSON.stringify(pool));
}

// ─── Case shared pool (doc files from the published case) ────────────────────

const CASE_SHARED_POOL_KEY = "nursetutor-case-shared-pool";

function loadCaseSharedPool(): PooledChunk[] {
  try {
    return JSON.parse(localStorage.getItem(CASE_SHARED_POOL_KEY) ?? "[]");
  } catch {
    return [];
  }
}

// ─── Case library (localStorage) ─────────────────────────────────────────────
// Used in Phase 3 (branch evaluation) — defined here so StudentTutor can access case trees

const CASE_LIBRARY_KEY = "nursetutor-case-library";

export function loadCaseLibrary(): CaseTree[] {
  try {
    return JSON.parse(localStorage.getItem(CASE_LIBRARY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveCaseLibrary(trees: CaseTree[]): void {
  localStorage.setItem(CASE_LIBRARY_KEY, JSON.stringify(trees));
}

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: "Explain a topic", prompt: "Explain a topic from my uploaded material in detail, with clinical context" },
  { label: "Summarize material", prompt: "Give me a concise summary of the key topics covered in my uploaded material" },
  { label: "MCQ quiz", prompt: "Give me a hard MCQ clinical nursing question" },
  { label: "SATA quiz", prompt: "Give me a SATA nursing question" },
  { label: "Case scenario", prompt: "Give me a clinical nursing case scenario" },
];

// ─── Keyword retrieval ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","is","it","in","on","at","to","for","of","and","or","but",
  "with","this","that","are","was","be","do","does","did","have","has","had",
  "will","would","can","could","should","may","might","what","which","who",
  "how","when","where","why","not","from","by","as","if","then","than","so",
  "just","about","also","their","there","they","you","your","me","my","we",
  "our","its","was","were","been","being","am","get","got","give","make",
]);

function queryKeywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w) && (w.length > 3 || /^\d+$/.test(w)))
  );
}

// Per-chunk character cap for standard retrieval (mcq / sata / general)
const CHUNK_CHAR_CAP = 700;

type Intent = "explain" | "mcq" | "sata" | "case" | "general";

function detectIntent(message: string): Intent {
  const m = message.toLowerCase();
  if (/\b(sata|select all)\b/.test(m)) return "sata";
  if (/\b(mcq|multiple.?choice)\b/.test(m)) return "mcq";
  if (/\b(case|scenario)\b/.test(m)) return "case";
  if (/\b(explain|what is|what are|summarize|summarise|describe|tell me about|overview|how does|how do|define|clarify|break down|walk me through|go through|look at|review|read through|go over|cover|what does|what did|teach me|show me)\b/.test(m)) return "explain";
  // Natural quiz requests without explicit "MCQ" keyword → treat as MCQ
  if (/\b(quiz|question|questions|practice|test me|give me a q|generate a|make a|create a|another question|one more|a few questions|some questions)\b/.test(m)) return "mcq";
  return "general";
}

function scoreChunk(chunk: PooledChunk, keywords: Set<string>): number {
  const bodyWords = queryKeywords(chunk.text);
  const labelWords = queryKeywords(chunk.label);
  const sourceWords = queryKeywords(chunk.source);
  let score = 0;
  for (const kw of keywords) {
    if (labelWords.has(kw)) {
      score += /^\d+$/.test(kw) ? 10 : 3;
    } else if ([...labelWords].some((w) => w.startsWith(kw) || kw.startsWith(w))) {
      score += 1.5;
    }
    // Boost source filename matches strongly — so "seminar 5 ppt" pulls from the right file
    if (sourceWords.has(kw)) score += 4;
    if (bodyWords.has(kw)) score += 1;
    else if ([...bodyWords].some((w) => w.startsWith(kw) || kw.startsWith(w))) score += 0.5;
  }
  return score;
}

function getTopChunks(
  studentPool: PooledChunk[],
  publishedPool: PooledChunk[],
  query: string,
  intent: Intent
): { studentChunks: PooledChunk[]; teacherChunks: PooledChunk[] } {
  const keywords = queryKeywords(query);
  const sortAndScore = (pool: PooledChunk[]) =>
    pool
      .map((c) => ({ c, score: keywords.size > 0 ? scoreChunk(c, keywords) : 0 }))
      .sort((a, b) => b.score - a.score)
      .map(({ c }) => c);

  if (intent === "explain") {
    const pickByBudget = (pool: PooledChunk[], budget: number) => {
      const selected: PooledChunk[] = [];
      let rem = budget;
      for (const c of sortAndScore(pool)) {
        if (rem <= 0) break;
        selected.push(c);
        rem -= c.text.length;
      }
      return selected;
    };
    return {
      studentChunks: pickByBudget(studentPool, 6_000),
      teacherChunks: pickByBudget(publishedPool, 3_000),
    };
  }
  return {
    studentChunks: sortAndScore(studentPool).slice(0, 2),
    teacherChunks: sortAndScore(publishedPool).slice(0, 1),
  };
}

function getRelevantChunks(
  studentPool: PooledChunk[],
  publishedPool: PooledChunk[],
  query: string,
  intent: Intent = "general"
): string {
  const { studentChunks, teacherChunks } = getTopChunks(studentPool, publishedPool, query, intent);

  if (intent === "explain") {
    const parts: string[] = [];
    if (studentChunks.length > 0)
      parts.push(`── YOUR UPLOADED FILES ──\n` +
        studentChunks.map((c) => `[${c.source} — ${c.label}]\n${c.text}`).join("\n\n"));
    if (teacherChunks.length > 0)
      parts.push(`── TEACHER COURSE MATERIALS ──\n` +
        teacherChunks.map((c) => `[${c.source} — ${c.label}]\n${c.text}`).join("\n\n"));
    return parts.join("\n\n");
  }

  return [
    ...studentChunks.map((c) => `[YOUR FILE — ${c.source} — ${c.label}]\n${c.text.slice(0, CHUNK_CHAR_CAP)}`),
    ...teacherChunks.map((c) => `[TEACHER — ${c.source} — ${c.label}]\n${c.text.slice(0, CHUNK_CHAR_CAP)}`),
  ].join("\n\n");
}

// ─── System prompt ────────────────────────────────────────────────────────────

interface ActiveCaseContext {
  tree: CaseTree;
  currentNodeId: string;
  turnsAtCurrentNode: number;
}

function buildSystemPrompt(
  customInstructions?: string,
  query?: string,
  intent: Intent = "general",
  activeCaseCtx?: ActiveCaseContext | null
): string {
  const studentPool   = loadPool();
  const publishedPool = loadPublishedPool();
  const caseSharedPool = loadCaseSharedPool();
  const hasFiles = studentPool.length > 0 || publishedPool.length > 0 || caseSharedPool.length > 0;

  // Build doc context — case shared pool is highest priority (injected first)
  let docContext = "";
  if (hasFiles) {
    const parts: string[] = [];
    if (caseSharedPool.length > 0) {
      parts.push(`── CASE STUDY MATERIALS ──\n` +
        caseSharedPool.map((c) => `[${c.source} — ${c.label}]\n${c.text}`).join("\n\n"));
    }
    const generalContext = getRelevantChunks(studentPool, publishedPool, query ?? "", intent);
    if (generalContext) parts.push(generalContext);
    docContext = `\n\nCourse material is available below in priority order — case materials first, then student files, then teacher materials:\n\n` +
      parts.join("\n\n") + "\n";
  }

  const customContext = customInstructions?.trim()
    ? `\n\n━━━ CUSTOM INSTRUCTIONS FROM STUDENT ━━━\n${customInstructions.trim()}\nAlways follow the above instructions for every response.\n`
    : "";

  const groundingRules = hasFiles
    ? `\n\n━━━ SOURCE PRIORITY ━━━
Answer using sources in this exact order:
1. YOUR UPLOADED FILES — the student's own notes and slides. Always check these first. Reference by label (e.g. "From your Slide 5..." or "From your Page 3...").
2. TEACHER COURSE MATERIALS — published course content from the teacher. Use when the student's files don't cover the topic.
3. If the topic is clinical/nursing — you may draw on general nursing knowledge, but you MUST preface it with: "This isn't in your uploaded files, but from general nursing knowledge..."
4. If the topic is course admin (dates, grades, schedules, instructor info) and it's not in the files — say exactly: "That information isn't in your uploaded materials." Then STOP. Do not add suggestions, generic advice, or filler. One sentence, done.
- Never present general knowledge as if it came from an uploaded file.
- Never invent specific details (drug doses, lab values, procedures) and attribute them to a document.`
    : `\n\n━━━ SOURCE RULES ━━━
- No study materials are uploaded. If the student asks about a specific document, tell them to upload it first.
- Answers draw from general nursing and NCLEX knowledge only — do not imply you have seen their specific course content.`;

  const explanationSection = `
━━━ EXPLANATION MODE ━━━
When a student asks you to explain a topic, summarize material, or asks a question about course content:
- Start immediately with the content — no preamble, no "I'll now explain...", no announcing what you're about to do.
- Draw directly from the uploaded study material above. Reference specific sections, pages, or slides by name when relevant.
- Structure your explanation clearly: core concept first, then clinical detail, then key points to remember.
- Use bullet points, numbered steps, or short paragraphs — whichever best fits the content.
- If the topic spans multiple sections, synthesize across them.
- Do not add a closing sentence about NCLEX relevance or clinical importance unless it adds something specific and non-obvious.`;

  const quizPhilosophy = `
━━━ QUIZ PHILOSOPHY ━━━
- Questions MUST be clinical and scenario-based — always describe a real patient (age, chief complaint, relevant vitals/labs/history). Never ask pure recall questions like "What is the normal range of X?"
- Distractors must be sophisticated and plausible. A good distractor is something a reasonable but less experienced nurse might actually choose. Avoid obviously wrong answers.
- Target application and analysis level (Bloom's). The student should have to reason, not just remember.
- When study material is uploaded, derive questions directly from that content.
- Do NOT refer to or suggest selecting a topic — there is no topic selector in the interface. Just generate questions directly.
- Do NOT use **bold** or any markdown formatting inside question text, options, or explanations — plain text only.`;

  const mcqFormat = `
━━━ MCQ FORMAT ━━━
When asked for a multiple-choice question, respond EXACTLY in this format (no preamble, no extra text):

MCQ
Question: [Rich clinical scenario with patient age, presenting complaint, relevant vitals/labs/context. End with a focused nursing question.]
A: [Option — plausible]
B: [Option — plausible]
C: [Option — plausible]
D: [Option — plausible, correct or distractor]
ANSWER: [Single letter: A, B, C, or D]
EXPLANATION: [2–3 sentences: why the correct answer is right, why each distractor is wrong or less appropriate, and the clinical rationale.]`;

  const sataFormat = `
━━━ SATA FORMAT ━━━
When asked for a Select All That Apply question, respond EXACTLY in this format (no preamble, no extra text):

SATA
Question: [Rich clinical scenario with patient context. End with "Select all that apply."]
A: [Option]
B: [Option]
C: [Option]
D: [Option]
E: [Option]
ANSWERS: [Comma-separated correct letters, e.g. A,C,E — always 2–4 correct answers out of 5]
EXPLANATION: [2–3 sentences: why each correct answer applies, why the distractors do not fit the clinical picture.]`;

  const multipleQuestionsFormat = `
━━━ MULTIPLE QUESTIONS ━━━
When the student asks for more than one question, you MUST generate EXACTLY the number requested — no more, no less. Never stop early.
Separate each question with a line containing only three dashes:

---

Output ONLY the questions separated by ---. No preamble, no numbering, no summary text. Do not add any closing remarks after the last question.`;

  const tutorMode = `
━━━ TUTOR MODE ━━━
For all non-quiz requests: explain clearly, use bullet points for lists, and keep answers clinically relevant and NCLEX-focused. Be encouraging, concise, and precise.`;

  const sections = {
    explain: explanationSection + tutorMode,
    mcq:     quizPhilosophy + mcqFormat + multipleQuestionsFormat + tutorMode,
    sata:    quizPhilosophy + sataFormat + multipleQuestionsFormat + tutorMode,
    case:    quizPhilosophy + tutorMode,
    general: explanationSection + quizPhilosophy + tutorMode,
  };

  // ── Branch evaluation injection (only when active simulation has a case tree) ──
  let branchBlock = "";
  if (activeCaseCtx && (intent === "case" || intent === "general")) {
    const { tree, currentNodeId, turnsAtCurrentNode } = activeCaseCtx;
    const currentNode = tree.nodes.find((n) => n.id === currentNodeId);
    const availableBranches = tree.branches.filter((b) => b.fromNodeId === currentNodeId);

    if (currentNode) {
      branchBlock = `\n\n━━━ CASE SIMULATION CONTEXT ━━━`;

      // Patient profile
      const p = tree.patientProfile;
      if (p) {
        const vitals = p.vitals;
        const pLines: string[] = [];
        if (p.name || p.age || p.gender)
          pLines.push(`Patient: ${[p.name, p.age ? `${p.age}yo` : "", p.gender].filter(Boolean).join(", ")}`);
        if (p.chiefComplaint)   pLines.push(`CC: ${p.chiefComplaint}`);
        if (p.primaryDiagnosis) pLines.push(`Dx: ${p.primaryDiagnosis}`);
        if (p.medications)      pLines.push(`Meds: ${p.medications}`);
        if (p.allergies)        pLines.push(`Allergies: ${p.allergies}`);
        const vParts = [
          vitals.bp   && `BP ${vitals.bp}`,
          vitals.hr   && `HR ${vitals.hr}`,
          vitals.spo2 && `SpO₂ ${vitals.spo2}`,
          vitals.temp && `Temp ${vitals.temp}`,
        ].filter(Boolean);
        if (vParts.length > 0) pLines.push(`Vitals: ${vParts.join(" | ")}`);
        if (p.imagingNotes) pLines.push(`Imaging: ${p.imagingNotes}`);
        if (p.labNotes)     pLines.push(`Labs: ${p.labNotes}`);
        if (pLines.length > 0) branchBlock += `\n\nPATIENT\n${pLines.join("\n")}`;
      }

      // Node situation
      if (currentNode.situation) {
        branchBlock += `\nCurrent situation: ${currentNode.situation}`;
      }

      // Completion criteria
      if (currentNode.completionCriteria) {
        branchBlock += `\nFor the student to complete this checkpoint they must: ${currentNode.completionCriteria}`;
      }

      // Completion narration
      if (currentNode.completionNarration) {
        branchBlock += `\nWhen the student completes this checkpoint, narrate: "${currentNode.completionNarration}"`;
      }

      // Active deterioration consequences
      const activeConsequences = (currentNode.consequences ?? [])
        .filter((c) => turnsAtCurrentNode >= c.afterTurns);
      if (activeConsequences.length > 0) {
        branchBlock += `\n\nACTIVE DETERIORATION EVENTS (weave these naturally into your narrative — do not read them out verbatim):\n` +
          activeConsequences.map((c) =>
            `- [${c.severity.toUpperCase()}] ${c.description}`
          ).join("\n");
      }

      // Branch evaluation
      if (availableBranches.length > 0) {
        branchBlock +=
          `\n\n━━━ BRANCH EVALUATION ━━━` +
          `\nStudent is at: "${currentNode.label}"` +
          `\nAvailable next steps — pick the one the student's message matches:\n` +
          availableBranches.map((b) => `Branch ID "${b.id}": "${b.triggerPhrase}"`).join("\n") +
          `\n\nAfter your narrative response, append ONE tag on its own line:` +
          `\n[BRANCH: <branch_id> confidence=<0-100>]   — if a branch matches` +
          `\n[BRANCH: null]                               — if no branch matches or you are unsure` +
          `\nDo NOT mention branches in your narrative. This tag is internal only.`;
      }

      // Available media
      const availableMedia = tree.mediaFiles ?? [];
      if (availableMedia.length > 0) {
        branchBlock += `\n\nAVAILABLE SIMULATION MEDIA:\n` +
          availableMedia.map((m) =>
            `- keyword "${m.triggerKeyword}" (${m.type}) — mode: ${m.triggerMode}${m.description ? ` — "${m.description}"` : ""}`
          ).join("\n") +
          `\n\nMedia rules:` +
          `\n- "student-asks" mode: ONLY display when student explicitly requests it` +
          `\n- "ai-auto" mode: proactively surface when clinically appropriate` +
          `\nWhen displaying media, write your narrative AND append on its own line: [MEDIA: keyword]` +
          `\nExample: student asks to auscultate → narrate findings → append [MEDIA: lung-sounds]`;
      }
    }
  }

  return `You are NurseTutor, a nursing classroom assistant. Your primary role is to help students understand course material — explain topics, answer questions about uploaded content, and summarize key concepts. You also generate challenging NCLEX-style practice questions when asked.${docContext}${customContext}${groundingRules}${sections[intent]}${branchBlock}`;
}

// ─── API ──────────────────────────────────────────────────────────────────────

interface GroqResponse {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function callGroq(
  history: ConversationTurn[],
  customInstructions?: string,
  attempt = 0,
  activeCaseCtx?: ActiveCaseContext | null
): Promise<GroqResponse> {
  const lastUserMsg = [...history].reverse().find((t) => t.role === "user")?.content ?? "";
  const intent = detectIntent(lastUserMsg);

  // Case simulations use a larger model and full history for state continuity
  const isSimulation = intent === "case" || (activeCaseCtx != null);
  const model = isSimulation || intent === "sata"
    ? "llama-3.3-70b-versatile"
    : "llama-3.1-8b-instant";

  const messageHistory = isSimulation
    ? history.map((t) => ({ role: t.role, content: t.content }))
    : history.slice(-2).map((t) => ({ role: t.role, content: t.content.slice(0, 500) }));

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: isSimulation ? 1200 : 4000,
      messages: [
        { role: "system", content: buildSystemPrompt(customInstructions, lastUserMsg, intent, activeCaseCtx) },
        ...messageHistory,
      ],
    }),
  });

  if (res.status === 429 && attempt < 3) {
    const retryAfterSec = parseFloat(res.headers.get("retry-after") ?? "");
    const waitMs = (Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 15000) + 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    return callGroq(history, customInstructions, attempt + 1, activeCaseCtx);
  }

  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return {
    content: data.choices[0].message.content as string,
    usage: data.usage,
  };
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseMCQ(
  raw: string
): Omit<MCQMessage, "id" | "role" | "type" | "chosen"> | null {
  const start = raw.search(/\bMCQ\b/);
  if (start === -1) return null;
  const trimmed = raw.slice(start);
  try {
    const q = trimmed.match(/Question:\s*([\s\S]+?)(?=\nA:)/)?.[1]?.trim();
    const a = trimmed.match(/^A:\s*(.+)/m)?.[1]?.trim();
    const b = trimmed.match(/^B:\s*(.+)/m)?.[1]?.trim();
    const c = trimmed.match(/^C:\s*(.+)/m)?.[1]?.trim();
    const d = trimmed.match(/^D:\s*(.+)/m)?.[1]?.trim();
    const ans = trimmed.match(/ANSWER:\s*([ABCD])/)?.[1]?.trim() as
      | "A"
      | "B"
      | "C"
      | "D"
      | undefined;
    const exp = trimmed.match(/EXPLANATION:\s*([\s\S]+)/)?.[1]?.trim();
    if (!q || !a || !b || !c || !d || !ans || !exp) return null;
    return {
      question: q,
      options: { A: a, B: b, C: c, D: d },
      answer: ans,
      explanation: exp,
    };
  } catch {
    return null;
  }
}

function parseSATA(
  raw: string
): Omit<SATAMessage, "id" | "role" | "type" | "selected" | "submitted"> | null {
  const start = raw.search(/\bSATA\b/);
  if (start === -1) return null;
  const trimmed = raw.slice(start);
  try {
    const q = trimmed.match(/Question:\s*([\s\S]+?)(?=\nA:)/)?.[1]?.trim();
    const a = trimmed.match(/^A:\s*(.+)/m)?.[1]?.trim();
    const b = trimmed.match(/^B:\s*(.+)/m)?.[1]?.trim();
    const c = trimmed.match(/^C:\s*(.+)/m)?.[1]?.trim();
    const d = trimmed.match(/^D:\s*(.+)/m)?.[1]?.trim();
    const e = trimmed.match(/^E:\s*(.+)/m)?.[1]?.trim();
    const ansRaw = trimmed.match(/ANSWERS:\s*([A-E,\s]+)/)?.[1]?.trim();
    const exp = trimmed.match(/EXPLANATION:\s*([\s\S]+)/)?.[1]?.trim();
    if (!q || !a || !b || !c || !d || !e || !ansRaw || !exp) return null;
    const answers = ansRaw
      .split(",")
      .map((x) => x.trim())
      .filter((x) => ["A", "B", "C", "D", "E"].includes(x)) as Array<
      "A" | "B" | "C" | "D" | "E"
    >;
    if (answers.length < 2) return null;
    return {
      question: q,
      options: { A: a, B: b, C: c, D: d, E: e },
      answers,
      explanation: exp,
    };
  } catch {
    return null;
  }
}

function parseBatch(raw: string): Message[] {
  // Split on separator lines, try to parse each block as MCQ or SATA
  const blocks = raw.split(/\n---\n/).map((b) => b.trim()).filter(Boolean);
  const results: Message[] = [];

  for (const block of blocks) {
    const sata = parseSATA(block);
    if (sata) {
      results.push({ id: uid(), role: "assistant", type: "sata", ...sata, selected: [], submitted: false });
      continue;
    }
    const mcq = parseMCQ(block);
    if (mcq) {
      results.push({ id: uid(), role: "assistant", type: "mcq", ...mcq });
      continue;
    }
  }

  // Fallback: try the whole response as a single question
  if (results.length === 0) {
    const sata = parseSATA(raw);
    if (sata) return [{ id: uid(), role: "assistant", type: "sata", ...sata, selected: [], submitted: false }];
    const mcq = parseMCQ(raw);
    if (mcq) return [{ id: uid(), role: "assistant", type: "mcq", ...mcq }];
  }

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatText(text: string): React.ReactNode {
  return text.split("\n").map((line, i, arr) => {
    const parts = line.split(/\*\*(.+?)\*\*/g);
    const formatted = parts.map((p, j) =>
      j % 2 === 1 ? <strong key={j}>{p}</strong> : p
    );
    return (
      <span key={i}>
        {formatted}
        {i < arr.length - 1 && <br />}
      </span>
    );
  });
}

function uid() {
  return Math.random().toString(36).slice(2);
}

// Regex for parsing/stripping the AI's [BRANCH: ...] tag in simulation mode
const BRANCH_REGEX = /\[BRANCH:\s*([\w-]+|null)\s*(?:confidence=(\d+))?\]/;

// Regex for parsing/stripping the AI's [MEDIA: keyword] tag
const MEDIA_REGEX = /\[MEDIA:\s*([\w-]+)\s*\]/;

// ─── Sub-components ───────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function LoadingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

function MCQCard({
  msg,
  onAnswer,
}: {
  msg: MCQMessage;
  onAnswer: (id: string, letter: "A" | "B" | "C" | "D") => void;
}) {
  const answered = msg.chosen !== undefined;
  return (
    <div className="space-y-3">
      <Badge
        variant="outline"
        className="text-xs border-amber-400 text-amber-600 dark:text-amber-400"
      >
        MCQ
      </Badge>
      <p className="text-sm leading-relaxed font-medium">{msg.question}</p>
      <div className="space-y-2">
        {(["A", "B", "C", "D"] as const).map((letter) => {
          const isCorrect = letter === msg.answer;
          const isChosen = letter === msg.chosen;
          return (
            <button
              key={letter}
              disabled={answered}
              onClick={() => onAnswer(msg.id, letter)}
              className={cn(
                "w-full text-left text-sm px-3 py-2.5 rounded-lg border transition-all",
                "flex items-start gap-2.5 cursor-pointer",
                !answered &&
                  "border-border bg-card hover:border-brand-400 hover:bg-brand-50 dark:hover:bg-brand-950/20",
                answered &&
                  isCorrect &&
                  "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200",
                answered &&
                  isChosen &&
                  !isCorrect &&
                  "border-red-400 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200",
                answered && !isChosen && !isCorrect && "border-border opacity-40"
              )}
            >
              {!answered && (
                <span className="shrink-0 text-[9px] text-muted-foreground/40 font-mono w-3 text-right mt-1">
                  {(["A","B","C","D"] as const).indexOf(letter) + 1}
                </span>
              )}
              <span
                className={cn(
                  "shrink-0 w-5 h-5 rounded-full border text-xs flex items-center justify-center font-semibold mt-0.5",
                  !answered && "border-muted-foreground/40 text-muted-foreground",
                  answered &&
                    isCorrect &&
                    "border-emerald-500 bg-emerald-500 text-white",
                  answered &&
                    isChosen &&
                    !isCorrect &&
                    "border-red-500 bg-red-500 text-white",
                  answered &&
                    !isChosen &&
                    !isCorrect &&
                    "border-muted-foreground/30 text-muted-foreground/40"
                )}
              >
                {letter}
              </span>
              <span>{msg.options[letter]}</span>
            </button>
          );
        })}
      </div>
      {answered && (
        <div className="mt-1 p-3 rounded-lg bg-muted/50 border border-border text-xs text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground">Rationale: </span>
          {msg.explanation}
        </div>
      )}
    </div>
  );
}

function SATACard({
  msg,
  onToggle,
  onSubmit,
}: {
  msg: SATAMessage;
  onToggle: (id: string, letter: "A" | "B" | "C" | "D" | "E") => void;
  onSubmit: (id: string) => void;
}) {
  const { submitted, selected, answers } = msg;
  const numCorrectSelected = selected.filter((l) => answers.includes(l)).length;
  const allCorrect =
    submitted &&
    selected.length === answers.length &&
    selected.every((l) => answers.includes(l));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className="text-xs border-red-400 text-red-600 dark:text-red-400"
        >
          SATA
        </Badge>
        <span className="text-xs text-muted-foreground">Select all that apply</span>
      </div>
      <p className="text-sm leading-relaxed font-medium">{msg.question}</p>
      <div className="space-y-2">
        {(["A", "B", "C", "D", "E"] as const).map((letter) => {
          const isSelected = selected.includes(letter);
          const isCorrectAnswer = answers.includes(letter);
          return (
            <button
              key={letter}
              disabled={submitted}
              onClick={() => onToggle(msg.id, letter)}
              className={cn(
                "w-full text-left text-sm px-3 py-2.5 rounded-lg border transition-all",
                "flex items-start gap-2.5 cursor-pointer",
                !submitted &&
                  isSelected &&
                  "border-red-500 bg-red-50 dark:bg-red-950/30",
                !submitted &&
                  !isSelected &&
                  "border-border bg-card hover:border-red-300 hover:bg-red-50/50 dark:hover:bg-red-950/10",
                submitted &&
                  isCorrectAnswer &&
                  "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200",
                submitted &&
                  isSelected &&
                  !isCorrectAnswer &&
                  "border-red-400 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200",
                submitted &&
                  !isSelected &&
                  !isCorrectAnswer &&
                  "border-border opacity-40"
              )}
            >
              <span
                className={cn(
                  "shrink-0 w-5 h-5 rounded border text-xs flex items-center justify-center font-semibold mt-0.5 transition-all",
                  !submitted &&
                    isSelected &&
                    "border-red-500 bg-red-500 text-white",
                  !submitted &&
                    !isSelected &&
                    "border-muted-foreground/40 text-muted-foreground",
                  submitted &&
                    isCorrectAnswer &&
                    "border-emerald-500 bg-emerald-500 text-white",
                  submitted &&
                    isSelected &&
                    !isCorrectAnswer &&
                    "border-red-500 bg-red-500 text-white",
                  submitted &&
                    !isSelected &&
                    !isCorrectAnswer &&
                    "border-muted-foreground/30 text-muted-foreground/40"
                )}
              >
                {submitted && isCorrectAnswer
                  ? "✓"
                  : submitted && isSelected && !isCorrectAnswer
                  ? "✗"
                  : letter}
              </span>
              <span>{msg.options[letter]}</span>
            </button>
          );
        })}
      </div>

      {!submitted && (
        <Button
          size="sm"
          onClick={() => onSubmit(msg.id)}
          disabled={selected.length === 0}
          className="bg-red-600 hover:bg-red-700 text-white text-xs"
        >
          Submit answer
        </Button>
      )}

      {submitted && (
        <div className="space-y-2">
          <div
            className={cn(
              "text-xs font-semibold px-3 py-1.5 rounded-md inline-block",
              allCorrect
                ? "bg-brand-100 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            )}
          >
            {allCorrect
              ? "Perfect — all correct!"
              : `${numCorrectSelected} of ${answers.length} correct answers selected`}
          </div>
          <div className="p-3 rounded-lg bg-muted/50 border border-border text-xs text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground">Rationale: </span>
            {msg.explanation}
          </div>
        </div>
      )}
    </div>
  );
}

function ScoreBadge({ correct, total }: { correct: number; total: number }) {
  const pct = total > 0 ? Math.round((correct / total) * 100) : null;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Score</span>
      <span className="font-semibold text-foreground">
        {correct}/{total}
      </span>
      {pct !== null && (
        <span
          className={cn(
            "px-1.5 py-0.5 rounded font-semibold",
            pct >= 75
              ? "bg-brand-100 text-brand-700 dark:bg-brand-950/40 dark:text-brand-300"
              : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          )}
        >
          {pct}%
        </span>
      )}
    </div>
  );
}

// ─── Landing Screen ───────────────────────────────────────────────────────────

function LandingScreen({ onSelect, isDark, onToggleDark }: {
  onSelect: (role: "student" | "teacher") => void;
  isDark: boolean;
  onToggleDark: () => void;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-white dark:from-slate-900 dark:via-slate-800 dark:to-slate-900 font-sans flex flex-col items-center justify-center px-6">

      {/* Dark mode toggle — top right */}
      <button
        onClick={onToggleDark}
        className="fixed top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center border border-border bg-background/80 backdrop-blur hover:bg-muted transition-colors shadow-sm"
        title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      >
        {isDark ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM18.894 6.166a.75.75 0 00-1.06-1.06l-1.591 1.59a.75.75 0 101.06 1.061l1.591-1.59zM21.75 12a.75.75 0 01-.75.75h-2.25a.75.75 0 010-1.5H21a.75.75 0 01.75.75zM17.834 18.894a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 10-1.061 1.06l1.59 1.591zM12 18a.75.75 0 01.75.75V21a.75.75 0 01-1.5 0v-2.25A.75.75 0 0112 18zM7.166 17.834a.75.75 0 00-1.06 1.06l1.59 1.591a.75.75 0 001.061-1.06l-1.59-1.591zM6 12a.75.75 0 01-.75.75H3a.75.75 0 010-1.5h2.25A.75.75 0 016 12zM6.166 6.166a.75.75 0 011.06-1.06l1.591 1.59a.75.75 0 01-1.06 1.061L6.166 6.166z" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-slate-600" viewBox="0 0 24 24" fill="currentColor">
            <path fillRule="evenodd" d="M9.528 1.718a.75.75 0 01.162.819A8.97 8.97 0 009 6a9 9 0 009 9 8.97 8.97 0 003.463-.69.75.75 0 01.981.98 10.503 10.503 0 01-9.694 6.46c-5.799 0-10.5-4.701-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 01.818.162z" clipRule="evenodd" />
          </svg>
        )}
      </button>

      {/* Decorative blobs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-slate-200/50 dark:bg-slate-700/30 blur-3xl" />
        <div className="absolute -bottom-32 -right-32 w-96 h-96 rounded-full bg-gray-100/80 dark:bg-slate-600/20 blur-3xl" />
      </div>

      {/* Hero */}
      <div className="relative flex flex-col items-center gap-3 mb-12 text-center">
        <div className="w-24 h-24 rounded-2xl overflow-hidden shadow-xl ring-4 ring-white mb-1">
          <img src="/nurse-avatar.png" alt="NurseTutor" className="w-full h-full object-cover" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-foreground">NurseTutor</h1>
        <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
          AI-powered NCLEX prep that is tailored to your course material
        </p>
      </div>

      <p className="relative text-sm font-medium text-foreground mb-6">
        Which role suits you best?
      </p>

      <div className="relative flex flex-col sm:flex-row gap-5 w-full max-w-lg">
        {/* Student card */}
        <button
          onClick={() => onSelect("student")}
          className="flex-1 group rounded-2xl border border-border/60 bg-card shadow-md hover:shadow-xl hover:border-brand-300 hover:-translate-y-0.5 transition-all duration-200 p-7 text-left space-y-4"
        >
          <div className="w-12 h-12 rounded-xl bg-brand-50 dark:bg-brand-950/30 border border-brand-100 dark:border-brand-900 flex items-center justify-center text-2xl shadow-sm">
            🎓
          </div>
          <div>
            <p className="font-bold text-base text-foreground group-hover:text-brand-700 transition-colors">I'm a Student</p>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              Practice with MCQ &amp; SATA questions, upload your notes, and get instant explanations.
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 group-hover:gap-2 transition-all">
            Start studying <span>→</span>
          </span>
        </button>

        {/* Teacher card */}
        <button
          onClick={() => onSelect("teacher")}
          className="flex-1 group rounded-2xl border border-border/60 bg-card shadow-md hover:shadow-xl hover:border-brand-300 hover:-translate-y-0.5 transition-all duration-200 p-7 text-left space-y-4"
        >
          <div className="w-12 h-12 rounded-xl bg-muted border border-border flex items-center justify-center text-2xl shadow-sm">
            📋
          </div>
          <div>
            <p className="font-bold text-base text-foreground group-hover:text-brand-700 transition-colors">I'm a Teacher</p>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              Build weekly question banks from your course material and export them for exams.
            </p>
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 group-hover:gap-2 transition-all">
            Open dashboard <span>→</span>
          </span>
        </button>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<"landing" | "student" | "teacher" | "case" | "preview">("landing");
  const [previewCase, setPreviewCase] = useState<CaseTree | null>(null);
  const [isDark, toggleDark] = useDarkMode();

  if (view === "landing") return <LandingScreen onSelect={(v) => setView(v)} isDark={isDark} onToggleDark={toggleDark} />;
  if (view === "teacher") return (
    <TeacherDashboard
      onBack={() => setView("landing")}
      isDark={isDark}
      onToggleDark={toggleDark}
      onPreviewCase={(tree) => { setPreviewCase(tree); setView("preview"); }}
    />
  );
  if (view === "case") return <CaseStudyMode onBack={() => setView("student")} isDark={isDark} onToggleDark={toggleDark} />;
  if (view === "preview") return (
    <CaseStudyMode
      onBack={() => { setPreviewCase(null); setView("teacher"); }}
      isDark={isDark}
      onToggleDark={toggleDark}
      previewCase={previewCase}
    />
  );
  return <StudentTutor onBack={() => setView("landing")} onOpenCase={() => setView("case")} isDark={isDark} onToggleDark={toggleDark} />;
}

// ─── Student Tutor ────────────────────────────────────────────────────────────

function DarkToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center border border-border hover:bg-muted transition-colors"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM18.894 6.166a.75.75 0 00-1.06-1.06l-1.591 1.59a.75.75 0 101.06 1.061l1.591-1.59zM21.75 12a.75.75 0 01-.75.75h-2.25a.75.75 0 010-1.5H21a.75.75 0 01.75.75zM17.834 18.894a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 10-1.061 1.06l1.59 1.591zM12 18a.75.75 0 01.75.75V21a.75.75 0 01-1.5 0v-2.25A.75.75 0 0112 18zM7.166 17.834a.75.75 0 00-1.06 1.06l1.59 1.591a.75.75 0 001.061-1.06l-1.59-1.591zM6 12a.75.75 0 01-.75.75H3a.75.75 0 010-1.5h2.25A.75.75 0 016 12zM6.166 6.166a.75.75 0 011.06-1.06l1.591 1.59a.75.75 0 01-1.06 1.061L6.166 6.166z" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="currentColor">
          <path fillRule="evenodd" d="M9.528 1.718a.75.75 0 01.162.819A8.97 8.97 0 009 6a9 9 0 009 9 8.97 8.97 0 003.463-.69.75.75 0 01.981.98 10.503 10.503 0 01-9.694 6.46c-5.799 0-10.5-4.701-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 01.818.162z" clipRule="evenodd" />
        </svg>
      )}
    </button>
  );
}

function StudentTutor({ onBack, onOpenCase, isDark, onToggleDark }: { onBack: () => void; onOpenCase: () => void; isDark: boolean; onToggleDark: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [tokenUsage, setTokenUsage] = useState({ last: 0, session: 0 });
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [uploadingFile, setUploadingFile] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ message: string; pct: number } | null>(null);
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [customInstructions, setCustomInstructions] = useState<string>(
    () => localStorage.getItem("nursetutor-instructions") ?? ""
  );
  const [showInstructions, setShowInstructions] = useState(false);
  const [draftInstructions, setDraftInstructions] = useState(customInstructions);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [questionMinimized, setQuestionMinimized] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Case tree simulation state ──
  const [activeCaseTree, setActiveCaseTree] = useState<CaseTree | null>(null);
  const [activeCaseNodeId, setActiveCaseNodeId] = useState<string | null>(null);
  const [turnsAtCurrentNode, setTurnsAtCurrentNode] = useState(0);
  const [branchPath, setBranchPath] = useState<string[]>([]); // node IDs visited in order
  const [showCaseTree, setShowCaseTree] = useState(false);    // post-case tree reveal

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const questionMessages = messages.filter(
    (m): m is MCQMessage | SATAMessage => m.role === "assistant" && (m.type === "mcq" || m.type === "sata")
  );

  // When new questions arrive, jump to the oldest unanswered question
  useEffect(() => {
    if (questionMessages.length === 0) return;
    const firstUnanswered = questionMessages.findIndex(
      (m) => (m.type === "mcq" && m.chosen === undefined) ||
              (m.type === "sata" && !m.submitted)
    );
    setQuestionIndex(firstUnanswered >= 0 ? firstUnanswered : questionMessages.length - 1);
    setQuestionMinimized(false);
  }, [questionMessages.length]);

  // Restore uploaded doc list from the pool on mount
  useEffect(() => {
    const pool = loadPool();
    if (pool.length === 0) return;
    const sourceMap = new Map<string, number>();
    for (const c of pool) {
      sourceMap.set(c.source, (sourceMap.get(c.source) ?? 0) + 1);
    }
    setUploadedDocs(
      [...sourceMap.entries()].map(([name, count]) => ({ name, count }))
    );
  }, []);

  useEffect(() => {
    const welcome: TextMessage = {
      id: uid(),
      role: "assistant",
      type: "text",
      content:
        "Welcome! I'm NurseTutor — your nursing classroom assistant.\n\nI can:\n• Explain any topic from your course material\n• Answer questions about specific content\n• Summarize key concepts\n• Generate NCLEX-style practice questions (MCQ & SATA)\n\nYour professor may have already loaded course materials — just ask me anything. You can also upload your own notes or slides using the panel on the left.\n\nTip: Use the Instructions button in the top right to set your focus area, difficulty level, or any other preferences.",
      createdAt: Date.now(),
    };
    setMessages([welcome]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || loading) return;
      setInput("");

      const userMsg: TextMessage = {
        id: uid(),
        role: "user",
        type: "text",
        content: text,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      const newHistory: ConversationTurn[] = [
        ...history,
        { role: "user", content: text },
      ];
      setHistory(newHistory);
      setLoading(true);

      try {
        // Build active case context for branch injection
        const caseCtx: ActiveCaseContext | null =
          activeCaseTree && activeCaseNodeId
            ? { tree: activeCaseTree, currentNodeId: activeCaseNodeId, turnsAtCurrentNode }
            : null;

        const { content: rawFull, usage } = await callGroq(newHistory, customInstructions, 0, caseCtx);
        setTokenUsage(prev => ({ last: usage.total_tokens, session: prev.session + usage.total_tokens }));

        // ── Parse and strip [BRANCH: ...] tag ──
        const branchMatch = BRANCH_REGEX.exec(rawFull);
        // ── Parse and strip [MEDIA: ...] tag ──
        const mediaMatch = MEDIA_REGEX.exec(rawFull);
        const raw = rawFull.replace(BRANCH_REGEX, "").replace(MEDIA_REGEX, "").trim();

        setHistory((h) => [...h, { role: "assistant", content: raw }]);

        // Advance branch state if valid match with confidence ≥ 60
        let branchAdvanced = false;
        if (branchMatch && activeCaseTree && activeCaseNodeId) {
          const branchId = branchMatch[1];
          const confidence = parseInt(branchMatch[2] ?? "0", 10);
          if (branchId !== "null" && confidence >= 60) {
            const branch = activeCaseTree.branches.find(
              (b) => b.id === branchId && b.fromNodeId === activeCaseNodeId
            );
            if (branch) {
              setActiveCaseNodeId(branch.toNodeId);
              setBranchPath((prev) => [...prev, branch.toNodeId]);
              setTurnsAtCurrentNode(0);
              branchAdvanced = true;
            }
          } else if (!branchMatch[2]) {
            console.debug("[NurseTutor] Branch tag missing confidence:", branchMatch[0]);
          }
        }
        // Increment turn counter if still on same node
        if (!branchAdvanced && activeCaseTree) {
          setTurnsAtCurrentNode((t) => t + 1);
        }

        // ── Handle media display ──
        if (mediaMatch && activeCaseTree) {
          const keyword = mediaMatch[1];
          const mediaFile = activeCaseTree.mediaFiles?.find((m) => m.triggerKeyword === keyword);
          if (mediaFile) {
            const dataUrl = loadMediaDataUrl(activeCaseTree.id, mediaFile.id);
            if (dataUrl) {
              setMessages((prev) => [
                ...prev,
                {
                  id: uid(),
                  role: "assistant" as const,
                  type: "media" as const,
                  caption: mediaFile.description ?? mediaFile.name,
                  mediaType: mediaFile.type,
                  dataUrl,
                  name: mediaFile.name,
                  createdAt: Date.now(),
                },
              ]);
            }
          }
        }

        // Detect case ending — show tree reveal
        if (raw.includes("CASE SUMMARY") && activeCaseTree) {
          setShowCaseTree(true);
        }

        // Detect case start — wire up the published case tree from library if available
        if (raw.includes("CASE START") && !activeCaseTree) {
          const library = loadCaseLibrary();
          // Prefer published case, fall back to first case
          const tree = library.find((c) => c.publishedToStudents) ?? library[0];
          if (tree) {
            const root = tree.nodes.find((n) => n.isRoot);
            if (root) {
              setActiveCaseTree(tree);
              setActiveCaseNodeId(root.id);
              setTurnsAtCurrentNode(0);
              setBranchPath([root.id]);
              setShowCaseTree(false);
            }
          }
        }

        // Compute citation pills — only show if the top chunk has a meaningful relevance score
        const CITATION_MIN_SCORE = 3;
        const _studentPool = loadPool();
        const _publishedPool = loadPublishedPool();
        let usedSources: NonNullable<TextMessage["sources"]> = [];
        if (_studentPool.length > 0 || _publishedPool.length > 0) {
          const _kw = queryKeywords(text);
          const topScored = (pool: PooledChunk[], tier: "student" | "teacher") => {
            if (pool.length === 0 || _kw.size === 0) return [];
            const best = pool
              .map((c) => ({ c, score: scoreChunk(c, _kw) }))
              .sort((a, b) => b.score - a.score)[0];
            if (!best || best.score < CITATION_MIN_SCORE) return [];
            return [{ source: best.c.source, label: best.c.label, tier }];
          };
          usedSources = [...topScored(_studentPool, "student"), ...topScored(_publishedPool, "teacher")];
        }

        const batch = parseBatch(raw);
        if (batch.length > 0) {
          setMessages((prev) => [...prev, ...batch]);
        } else {
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "assistant", type: "text", content: raw, sources: usedSources.length > 0 ? usedSources : undefined, createdAt: Date.now() },
          ]);
        }
      } catch (err) {
        console.error("NurseTutor error:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: "assistant",
            type: "text",
            content: errMsg.includes("429")
              ? "You're sending requests too quickly — please wait a few seconds and try again."
              : `Sorry, I had trouble connecting. (${errMsg})`,
            createdAt: Date.now(),
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, history, customInstructions, activeCaseTree, activeCaseNodeId, turnsAtCurrentNode]
  );

  const answerMCQ = useCallback(
    (id: string, letter: "A" | "B" | "C" | "D") => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== id || m.type !== "mcq" || m.chosen !== undefined) return m;
          const correct = letter === m.answer;
          setScore((s) => ({
            correct: s.correct + (correct ? 1 : 0),
            total: s.total + 1,
          }));
          return { ...m, chosen: letter };
        })
      );
    },
    []
  );

  const toggleSATA = useCallback(
    (id: string, letter: "A" | "B" | "C" | "D" | "E") => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== id || m.type !== "sata" || m.submitted) return m;
          const selected = m.selected.includes(letter)
            ? m.selected.filter((l) => l !== letter)
            : [...m.selected, letter];
          return { ...m, selected };
        })
      );
    },
    []
  );

  const submitSATA = useCallback((id: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id || m.type !== "sata" || m.submitted) return m;
        const correct =
          m.selected.length === m.answers.length &&
          m.selected.every((l) => m.answers.includes(l));
        setScore((s) => ({
          correct: s.correct + (correct ? 1 : 0),
          total: s.total + 1,
        }));
        return { ...m, submitted: true };
      })
    );
  }, []);

  // Keyboard shortcuts: 1/2/3/4 for MCQ, 1-5 + Enter for SATA
  // Must be declared after answerMCQ, toggleSATA, submitSATA
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (questionMinimized || questionMessages.length === 0) return;

      const current = questionMessages[questionIndex];

      if (current?.type === "mcq" && current.chosen === undefined) {
        const map: Record<string, "A" | "B" | "C" | "D"> = { "1": "A", "2": "B", "3": "C", "4": "D" };
        if (map[e.key]) { e.preventDefault(); answerMCQ(current.id, map[e.key]); }
      }

      if (current?.type === "sata" && !current.submitted) {
        const sataMap: Record<string, "A" | "B" | "C" | "D" | "E"> = {
          "1": "A", "2": "B", "3": "C", "4": "D", "5": "E",
        };
        if (sataMap[e.key]) { e.preventDefault(); toggleSATA(current.id, sataMap[e.key]); }
        if (e.key === "Enter" && current.selected.length > 0) { e.preventDefault(); submitSATA(current.id); }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [questionMessages, questionIndex, questionMinimized, answerMCQ, toggleSATA, submitSATA]);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      e.target.value = "";

      const added: UploadedDoc[] = [];
      let ocrFailCount = 0;
      for (const file of files) {
        setUploadingFile(file.name);
        setUploadProgress(null);
        const onProgress: ProgressCallback = (message, current, total, warn) => {
          setUploadProgress({ message, pct: Math.round((current / total) * 100) });
          if (warn) ocrFailCount++;
        };
        try {
          const chunks = await extractChunks(file, onProgress);
          // Merge into the shared pool, replacing any existing entry for this file
          const pooled: PooledChunk[] = chunks.map((c) => ({
            source: file.name,
            label: c.label,
            text: c.text,
          }));
          const pool = loadPool();
          savePool([...pool.filter((c) => c.source !== file.name), ...pooled]);
          added.push({ name: file.name, count: chunks.length });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error("File upload error:", reason);
          setMessages((prev) => [...prev, { id: uid(), role: "assistant", type: "text",
            content: `Sorry, I couldn't read ${file.name}: ${reason}` }]);
        }
      }
      setUploadingFile(null);
      setUploadProgress(null);

      if (added.length === 0) return;

      setUploadedDocs((prev) => {
        const names = new Set(prev.map(d => d.name));
        return [...prev, ...added.filter(d => !names.has(d.name))];
      });

      const names = added.map(d => d.name).join(", ");
      const msgs: Message[] = [
        { id: uid(), role: "assistant", type: "text",
          content: `Got it — I've added ${names} to your file bank. I'll draw on all your uploaded files when generating questions. Want me to quiz you, explain a concept, or work through a case?` },
      ];
      if (ocrFailCount > 0) {
        msgs.push({ id: uid(), role: "assistant", type: "text",
          content: `⚠️ Heads up: OCR couldn't process ${ocrFailCount} page${ocrFailCount !== 1 ? "s" : ""} — those fell back to basic text extraction, which may be limited. This usually means the image was too large or a rate limit was hit. You can re-upload the file to retry.` });
      }
      setMessages((prev) => [...prev, ...msgs]);
    },
    []
  );

  return (
    <div className="flex flex-col h-screen bg-background font-sans">
      {/* ── Header ── */}
      <div className="shrink-0 border-b border-border px-5 py-3 flex items-center gap-3 w-full">
        <div className="w-9 h-9 rounded-full overflow-hidden shrink-0">
          <img src="/nurse-avatar.png" alt="NurseTutor" className="w-full h-full object-cover" />
        </div>
        <div>
          <h1 className="text-sm font-semibold tracking-tight">NurseTutor</h1>
          <p className="text-xs text-muted-foreground">NCLEX-focused clinical tutor</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ScoreBadge correct={score.correct} total={score.total} />
          {tokenUsage.last > 0 && (
            <div className="flex flex-col items-end gap-0.5" title="Groq token usage (free tier: 6,000 TPM)">
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground">Last</span>
                <span className={cn(
                  "text-[10px] font-semibold",
                  tokenUsage.last > 5000 ? "text-red-500" : tokenUsage.last > 3500 ? "text-amber-500" : "text-emerald-600"
                )}>{tokenUsage.last.toLocaleString()}</span>
                <span className="text-[10px] text-muted-foreground">/ 6k</span>
              </div>
              <div className="w-16 h-1 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    tokenUsage.last > 5000 ? "bg-red-500" : tokenUsage.last > 3500 ? "bg-amber-400" : "bg-emerald-500"
                  )}
                  style={{ width: `${Math.min(100, (tokenUsage.last / 6000) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-muted-foreground">Session: {tokenUsage.session.toLocaleString()}</span>
            </div>
          )}
          <DarkToggle isDark={isDark} onToggle={onToggleDark} />
          <button
            onClick={onOpenCase}
            className="shrink-0 flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg px-2.5 h-8 hover:bg-red-50 dark:hover:bg-red-950/30 transition-all"
            title="Open Case Study mode"
          >
            🏥 Case Study
          </button>
          <button
            onClick={onBack}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 h-8 transition-all hover:border-brand-400"
            title="Back to home"
          >
            ← Home
          </button>
          {uploadedDocs.length > 0 && (
            <button
              onClick={() => setShowFiles(v => !v)}
              className={cn(
                "shrink-0 flex items-center gap-1.5 px-2.5 h-8 rounded-lg border text-xs font-medium transition-all",
                showFiles
                  ? "border-brand-500 bg-brand-50 text-brand-600"
                  : "border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600"
              )}
            >
              📁 {uploadedDocs.length} file{uploadedDocs.length !== 1 ? "s" : ""}
            </button>
          )}
          <button
            onClick={() => { setDraftInstructions(customInstructions); setShowInstructions(v => !v); }}
            title="Custom instructions"
            className={cn(
              "shrink-0 flex items-center gap-1.5 px-2.5 h-8 rounded-lg border text-xs font-medium transition-all",
              customInstructions.trim()
                ? "border-brand-500 bg-brand-50 text-brand-600"
                : "border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600"
            )}
          >
            <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 shrink-0">
              <path d="M2 4h12M2 8h8M2 12h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Instructions
          </button>
        </div>
      </div>

      {/* ── Upload loading bar ── */}
      {uploadingFile && (
        <div className="shrink-0 border-b border-brand-200 dark:border-brand-900 bg-brand-50 dark:bg-brand-950/30 px-5 py-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs text-brand-700 dark:text-brand-300 font-medium truncate max-w-xs">
              {uploadingFile}
            </p>
            <p className="text-xs text-brand-500 shrink-0 ml-2">
              {uploadProgress ? `${uploadProgress.pct}%` : "reading…"}
            </p>
          </div>
          {uploadProgress && (
            <p className="text-xs text-brand-600 truncate">{uploadProgress.message}</p>
          )}
          <div className="h-1.5 w-full bg-brand-100 dark:bg-brand-950 rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full bg-brand-500 rounded-full transition-all duration-300",
                !uploadProgress && "animate-pulse w-full"
              )}
              style={{ width: uploadProgress ? `${uploadProgress.pct}%` : undefined }}
            />
          </div>
        </div>
      )}

      {/* ── File bank panel ── */}
      {showFiles && (() => {
        // Estimate storage usage
        const STORAGE_LIMIT_KB = 5120; // 5MB in KB
        let usedKB = 0;
        try {
          for (const key in localStorage) {
            if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
              usedKB += (localStorage.getItem(key)?.length ?? 0) * 2 / 1024;
            }
          }
        } catch {}
        const usedPct = Math.min(100, Math.round((usedKB / STORAGE_LIMIT_KB) * 100));
        const storageColor = usedPct > 80 ? "bg-red-500" : usedPct > 55 ? "bg-amber-400" : "bg-emerald-500";
        const storageText = usedPct > 80 ? "text-red-600" : usedPct > 55 ? "text-amber-600" : "text-emerald-600";

        return (
          <div className="shrink-0 border-b border-border bg-muted/30 px-5 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-foreground">Uploaded files</p>
              <button
                onClick={() => { savePool([]); setUploadedDocs([]); }}
                className="text-xs text-red-500 hover:text-red-600 transition-colors"
              >
                Remove all
              </button>
            </div>
            <div className="space-y-1.5">
              {[...uploadedDocs].sort((a, b) => a.name.localeCompare(b.name)).map(doc => (
                <div key={doc.name} className="flex items-center gap-2 text-xs bg-background border border-border rounded-lg px-3 py-2">
                  <span className="text-base">📄</span>
                  <span className="flex-1 truncate text-foreground font-medium">{doc.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {doc.count} {doc.count === 1 ? "section" : "sections"}
                  </span>
                  <button
                    onClick={() => {
                      savePool(loadPool().filter((c) => c.source !== doc.name));
                      setUploadedDocs(prev => prev.filter(d => d.name !== doc.name));
                    }}
                    className="text-muted-foreground hover:text-red-500 transition-colors"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {/* Storage bar */}
            <div className="pt-1 space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-muted-foreground font-medium">Browser storage</p>
                <p className={cn("text-[10px] font-semibold", storageText)}>
                  {usedKB < 1024
                    ? `${Math.round(usedKB)} KB`
                    : `${(usedKB / 1024).toFixed(1)} MB`
                  } / 5 MB
                </p>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", storageColor)}
                  style={{ width: `${usedPct}%` }}
                />
              </div>
              {usedPct > 80 && (
                <p className="text-[10px] text-red-500">Storage almost full — remove some files to free space.</p>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Custom instructions panel ── */}
      {showInstructions && (
        <div className="shrink-0 border-b border-border bg-brand-50/50 px-5 py-3 space-y-2">
          <p className="text-xs font-semibold text-brand-700">Custom instructions</p>
          <p className="text-xs text-muted-foreground">
            Tell NurseTutor how to tailor its questions — e.g. "Focus on OB/Maternity", "Always use Canadian drug names", "Make questions harder". Applied to every response until cleared.
          </p>
          <textarea
            value={draftInstructions}
            onChange={(e) => setDraftInstructions(e.target.value)}
            placeholder="e.g. Focus on cardiac medications and always include a rhythm strip in the scenario…"
            rows={3}
            className="w-full text-sm rounded-lg border border-border bg-background px-3 py-2 resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 placeholder:text-muted-foreground"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="bg-brand-500 hover:bg-brand-600 text-white text-xs"
              onClick={() => {
                setCustomInstructions(draftInstructions);
                localStorage.setItem("nursetutor-instructions", draftInstructions);
                setShowInstructions(false);
              }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              onClick={() => {
                setDraftInstructions("");
                setCustomInstructions("");
                localStorage.removeItem("nursetutor-instructions");
                setShowInstructions(false);
              }}
            >
              Clear
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs ml-auto"
              onClick={() => setShowInstructions(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Chat ── */}
      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-5 py-4 space-y-5 pb-2">
          {messages.filter((m) => m.type === "text" || m.type === "media").map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex gap-2.5 group",
                msg.role === "user" && "flex-row-reverse"
              )}
            >
              <div className="shrink-0 w-7 h-7 rounded-full overflow-hidden flex items-center justify-center bg-muted">
                {msg.role === "assistant" ? (
                  <img src="/nurse-avatar.png" alt="NurseTutor" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-xs font-semibold text-muted-foreground">You</span>
                )}
              </div>

              {/* Bubble + timestamp wrapper — timestamp is absolutely positioned so it never adds height */}
              <div className="relative max-w-[82%]">
                {/* Text message */}
                {msg.type === "text" && (
                  <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-muted/60 border border-border rounded-tl-sm">
                    {formatText(msg.content)}
                    {msg.role === "assistant" && msg.sources && msg.sources.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-border/40">
                        {msg.sources.map((s, i) => (
                          <span key={i} className={cn(
                            "inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border",
                            s.tier === "student"
                              ? "bg-brand-50 dark:bg-brand-950/40 text-brand-700 dark:text-brand-300 border-brand-200 dark:border-brand-800"
                              : "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800"
                          )}>
                            {s.tier === "student" ? "📄" : "📚"}
                            {s.source.length > 22 ? s.source.slice(0, 22) + "…" : s.source}
                            {" — "}{s.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Media message */}
                {msg.type === "media" && (
                  <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm max-w-sm">
                    {msg.mediaType === "image" && (
                      <img src={msg.dataUrl} alt={msg.name} className="w-full object-contain max-h-64" />
                    )}
                    {msg.mediaType === "audio" && (
                      <div className="px-4 py-3 flex items-center gap-3">
                        <span className="text-xl shrink-0">🔊</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-foreground truncate">{msg.caption || msg.name}</p>
                          <audio controls src={msg.dataUrl} className="w-full mt-1.5 h-8" />
                        </div>
                      </div>
                    )}
                    {msg.caption && msg.mediaType === "image" && (
                      <div className="px-3 py-2 border-t border-border/60">
                        <p className="text-xs text-muted-foreground">{msg.caption}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Timestamp — absolutely positioned below bubble, zero layout impact */}
                {"createdAt" in msg && msg.createdAt && (
                  <span className={cn(
                    "absolute -bottom-4 text-[10px] text-muted-foreground/70 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150",
                    msg.role === "user" ? "right-1" : "left-1"
                  )}>
                    {formatTimestamp(msg.createdAt)}
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* ── Post-case tree reveal ── */}
          {showCaseTree && activeCaseTree && (
            <CaseTreeReveal
              tree={activeCaseTree}
              visitedNodeIds={branchPath}
            />
          )}

          {loading && (
            <div className="flex gap-2.5">
              <div className="shrink-0 w-7 h-7 rounded-full overflow-hidden">
                <img src="/nurse-avatar.png" alt="NurseTutor" className="w-full h-full object-cover" />
              </div>
              <div className="flex flex-col gap-0.5">
                <div className="bg-muted/60 border border-border rounded-2xl rounded-tl-sm px-4 py-3">
                  <div className="flex items-center gap-2">
                    <LoadingDots />
                    <span className="text-xs text-muted-foreground">NurseTutor is typing…</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* ── Question navigator ── */}
      {questionMessages.length > 0 && (
        <div className="shrink-0 border-t border-border">
          {/* Minimise toggle bar */}
          <button
            onClick={() => setQuestionMinimized(v => !v)}
            className="w-full flex items-center justify-between px-5 py-2 hover:bg-muted/40 transition-all"
          >
            <span className="text-xs font-medium text-muted-foreground">
              {questionMinimized ? "Show question" : "Hide question"}
              {questionMessages.length > 1 && (
                <span className="ml-2 text-[10px] bg-brand-100 text-brand-700 font-semibold px-1.5 py-0.5 rounded-full">
                  {questionIndex + 1} / {questionMessages.length}
                </span>
              )}
            </span>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform", questionMinimized ? "rotate-180" : "")}
            >
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {/* Question content */}
          {!questionMinimized && (
            <div className="px-5 pb-3 space-y-3">
              <div className="bg-card border border-border rounded-2xl px-4 py-3 text-sm">
                {questionMessages[questionIndex].type === "mcq" && (
                  <MCQCard msg={questionMessages[questionIndex] as MCQMessage} onAnswer={answerMCQ} />
                )}
                {questionMessages[questionIndex].type === "sata" && (
                  <SATACard
                    msg={questionMessages[questionIndex] as SATAMessage}
                    onToggle={toggleSATA}
                    onSubmit={submitSATA}
                  />
                )}
              </div>
              {questionMessages.length > 1 && (
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setQuestionIndex((i) => Math.max(0, i - 1))}
                    disabled={questionIndex === 0}
                    className="text-xs px-4 py-2 rounded-lg border border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    ← Previous
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {questionIndex + 1} / {questionMessages.length}
                  </span>
                  <button
                    onClick={() => setQuestionIndex((i) => Math.min(questionMessages.length - 1, i + 1))}
                    disabled={questionIndex === questionMessages.length - 1}
                    className="text-xs px-4 py-2 rounded-lg border border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Quick actions ── */}
      <div className="shrink-0 px-5 py-2 flex gap-2 overflow-x-auto">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            onClick={() => send(a.prompt)}
            disabled={loading}
            className="shrink-0 text-xs px-3 py-1.5 rounded-full border border-border bg-background text-muted-foreground hover:border-brand-400 hover:text-brand-700 dark:hover:text-brand-300 transition-all disabled:opacity-40"
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* ── Input row ── */}
      <div className="shrink-0 border-t border-border">
        <div className="max-w-3xl mx-auto px-5 pb-3 pt-3 flex gap-2 items-center">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.csv,.rtf,.pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif"
            multiple
            className="hidden"
            onChange={handleFileUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Upload study notes (.txt, .md, .pdf, .docx, .pptx, or images)"
            className={cn(
              "shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center transition-all",
              uploadedDocs.length > 0
                ? "border-brand-500 bg-brand-50 text-brand-600 dark:bg-brand-950/30"
                : "border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600"
            )}
          >
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4">
              <path
                d="M2 10v3a1 1 0 001 1h10a1 1 0 001-1v-3M8 2v8M5 5l3-3 3 3"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Textarea with character count */}
          <div className="flex-1 relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={
                uploadedDocs.length > 0
                  ? `Ask about your ${uploadedDocs.length} uploaded file${uploadedDocs.length !== 1 ? "s" : ""}…`
                  : "Ask a question or request a quiz…"
              }
              disabled={loading}
              rows={1}
              className="w-full resize-none rounded-lg text-sm border border-input bg-background px-3 py-2 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 min-h-[36px] max-h-[120px] overflow-y-auto"
              style={{ height: "36px" }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "36px";
                el.style.height = Math.min(el.scrollHeight, 120) + "px";
              }}
            />
            {input.length > 100 && (
              <span className={cn(
                "absolute bottom-1.5 right-2.5 text-[10px] pointer-events-none select-none",
                input.length > 1800 ? "text-red-500" :
                input.length > 1400 ? "text-amber-500" :
                "text-muted-foreground/40"
              )}>
                {input.length}
              </span>
            )}
          </div>

          <Button
            onClick={() => send(input)}
            disabled={loading || !input.trim()}
            size="sm"
            className="bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4"
          >
            Send
          </Button>
        </div>
        <div className="max-w-3xl mx-auto px-5 pb-3 flex justify-end">
          <span className="text-[10px] text-muted-foreground/40 select-none">
            Enter ↵ send · Shift+Enter new line
          </span>
        </div>
      </div>
    </div>
  );
}
