import React, { useState, useRef, useEffect } from "react";
import { extractText } from "./lib/parseFile";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { SyllabusChunk, ParsedSyllabusV2 } from "./lib/syllabusTypes";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TabFile {
  name: string;
  content: string;
}

interface ParsedQuestion {
  id: string;
  type: "mcq" | "sata";
  question: string;
  options: Record<string, string>;
  answer: string;
  explanation: string;
}

interface CourseTab {
  id: string;
  label: string;
  kind: "week" | "info";
  isCustom: boolean;
  // week fields
  topic?: string;
  learningOutcomes?: string[];
  files: TabFile[];
  questions: ParsedQuestion[];
  loading: boolean;
  error: string;
  // info tab field
  content?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2);
}

const STORAGE_KEY = "nursetutor-teacher-v1";
const PUBLISHED_KEY = "nursetutor-published-pool";
const SYLLABUS_KEY = "nursetutor-syllabus-pool";

// ─── Syllabus pool helpers ────────────────────────────────────────────────────

function saveSyllabusPool(chunks: SyllabusChunk[]): void {
  localStorage.setItem(SYLLABUS_KEY, JSON.stringify(chunks));
}
function clearSyllabusPool(): void {
  localStorage.removeItem(SYLLABUS_KEY);
}

// ─── Published pool helpers ───────────────────────────────────────────────────

interface PooledChunk { source: string; label: string; text: string; }

const TEACHER_CHUNK_CAP = 700;

function chunkTeacherText(tabLabel: string, fileName: string, content: string): PooledChunk[] {
  const lines = content.split("\n");
  const rawChunks: { label: string; text: string }[] = [];
  let currentLabel = "Part 1";
  let currentLines: string[] = [];
  let sectionIndex = 1;

  const isHeading = (line: string): boolean => {
    const t = line.trim();
    if (t.length === 0 || t.length > 80) return false;
    if (/[.!?,;]$/.test(t)) return false;
    if (!/^[A-Z0-9]/.test(t)) return false;
    return t.split(/\s+/).length <= 10;
  };

  const flush = () => {
    const body = currentLines.join("\n").trim();
    if (body.length > 0) rawChunks.push({ label: currentLabel, text: body });
  };

  for (const line of lines) {
    if (isHeading(line)) {
      flush();
      currentLabel = `Part ${sectionIndex++}: ${line.trim()}`;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // Fall back to word-count grouping if heading split didn't work
  let segments = rawChunks;
  if (rawChunks.length <= 1 && content.length > 500) {
    const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim().length > 0);
    const grouped: { label: string; text: string }[] = [];
    let current: string[] = [];
    let wordCount = 0;
    let idx = 1;
    const TARGET_WORDS = 120;
    const flushGroup = () => {
      const body = current.join("\n\n").trim();
      if (body.length > 0) grouped.push({ label: `Part ${idx++}`, text: body });
      current = [];
      wordCount = 0;
    };
    for (const para of paragraphs) {
      const words = para.split(/\s+/).length;
      if (wordCount + words > TARGET_WORDS && current.length > 0) flushGroup();
      current.push(para);
      wordCount += words;
    }
    flushGroup();
    segments = grouped;
  }

  return segments.map((seg) => ({
    source: `${tabLabel} — ${fileName}`,
    label: seg.label,
    text: seg.text.slice(0, TEACHER_CHUNK_CAP),
  }));
}

function loadPublishedPool(): PooledChunk[] {
  try { return JSON.parse(localStorage.getItem(PUBLISHED_KEY) ?? "[]"); } catch { return []; }
}

function savePublishedPool(pool: PooledChunk[]): void {
  localStorage.setItem(PUBLISHED_KEY, JSON.stringify(pool));
}

function publishTab(tab: CourseTab): void {
  const tabSources = new Set(tab.files.map((f) => `${tab.label} — ${f.name}`));
  const filtered = loadPublishedPool().filter((c) => !tabSources.has(c.source));
  const newChunks = tab.files.flatMap((f) => chunkTeacherText(tab.label, f.name, f.content));
  savePublishedPool([...filtered, ...newChunks]);
}

function unpublishTabSources(sources: Set<string>): void {
  savePublishedPool(loadPublishedPool().filter((c) => !sources.has(c.source)));
}

function loadTabs(): CourseTab[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed: CourseTab[] = JSON.parse(saved);
      return parsed.map((t) => ({ ...t, loading: false, error: "" }));
    }
  } catch {}
  return defaultTabs();
}

function defaultTabs(): CourseTab[] {
  return Array.from({ length: 13 }, (_, i) => ({
    id: `week-${i + 1}`,
    label: `Week ${i + 1}`,
    kind: "week" as const,
    isCustom: false,
    files: [],
    questions: [],
    loading: false,
    error: "",
  }));
}

function makeInfoTab(id: string, label: string, content: string): CourseTab {
  return {
    id,
    label,
    kind: "info",
    isCustom: false,
    files: [],
    questions: [],
    loading: false,
    error: "",
    content,
  };
}

// ─── API ──────────────────────────────────────────────────────────────────────

// ─── Weight normalizer (handles LLM returning 25, "25%", or 0.25) ────────────

function normalizeWeight(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const n = typeof raw === "string" ? parseFloat((raw as string).replace("%", "")) : Number(raw);
  if (!isFinite(n)) return undefined;
  return n > 1 ? n / 100 : n;
}

// ─── Syllabus → SyllabusChunk[] ───────────────────────────────────────────────

const SYLLABUS_CHUNK_CAP = 700;

function syllabusToChunks(parsed: ParsedSyllabusV2): SyllabusChunk[] {
  const chunks: SyllabusChunk[] = [];
  const cap = SYLLABUS_CHUNK_CAP;

  // ── Course info ─────────────────────────────────────────────────────────────
  const infoText = [
    parsed.course_name,
    parsed.course_number ? `Course: ${parsed.course_number}` : null,
    parsed.instructor_name ? `Instructor: ${parsed.instructor_name}` : null,
    parsed.instructor_email ? `Email: ${parsed.instructor_email}` : null,
    parsed.office_hours ? `Office Hours: ${parsed.office_hours}` : null,
    "",
    parsed.course_description,
  ].filter((l) => l !== null).join("\n");

  chunks.push({
    source: "syllabus",
    label: "Course Overview",
    text: infoText.slice(0, cap),
    meta: { section: "course_info" },
  });

  // ── Learning objectives ──────────────────────────────────────────────────────
  if (parsed.learning_objectives.length > 0) {
    chunks.push({
      source: "syllabus",
      label: "Course Learning Objectives",
      text: parsed.learning_objectives.map((o, i) => `${i + 1}. ${o}`).join("\n").slice(0, cap),
      meta: { section: "learning_objectives" },
    });
  }

  // ── Policies ─────────────────────────────────────────────────────────────────
  const policyParts = [
    parsed.attendance_policy ? `Attendance Policy:\n${parsed.attendance_policy}` : null,
    parsed.late_work_policy ? `Late Work Policy:\n${parsed.late_work_policy}` : null,
    parsed.required_materials && parsed.required_materials.length > 0
      ? `Required Materials:\n${parsed.required_materials.join("\n")}`
      : null,
  ].filter(Boolean).join("\n\n");

  if (policyParts.trim()) {
    chunks.push({
      source: "syllabus",
      label: "Course Policies",
      text: policyParts.slice(0, cap),
      meta: { section: "policies" },
    });
  }

  // ── Weekly schedule ─────────────────────────────────────────────────────────
  for (const w of parsed.weekly_schedule) {
    const text = [
      `Week ${w.week}${w.date_range ? ` (${w.date_range})` : ""}: ${w.topic}`,
      w.chapters && w.chapters.length > 0 ? `Chapters: ${w.chapters.join(", ")}` : null,
      `Learning outcomes:\n${w.learning_outcomes.map((o) => `- ${o}`).join("\n")}`,
    ].filter(Boolean).join("\n");

    chunks.push({
      source: "syllabus",
      label: `Week ${w.week}: ${w.topic}`,
      text: text.slice(0, cap),
      meta: {
        section: "weekly_schedule",
        week: w.week,
        topics: [w.topic],
        chapters: w.chapters,
        date: w.date_range ?? undefined,
      },
    });
  }

  // ── Exam schedule ───────────────────────────────────────────────────────────
  for (const e of parsed.exam_schedule) {
    const weightStr = e.weight != null ? `${(e.weight * 100).toFixed(0)}% of final grade` : "see grading policy";
    const text = [
      `${e.type.charAt(0).toUpperCase() + e.type.slice(1)} ${e.exam_number}`,
      `Date: ${e.date}`,
      `Topics: ${e.topics.join(", ")}`,
      e.chapters && e.chapters.length > 0 ? `Chapters: ${e.chapters.join(", ")}` : null,
      `Grade weight: ${weightStr}`,
      e.notes ? `Note: ${e.notes}` : null,
    ].filter(Boolean).join("\n");

    chunks.push({
      source: "syllabus",
      label: `Exam ${e.exam_number}: ${e.type} — ${e.date}`,
      text: text.slice(0, cap),
      meta: {
        section: "exam_schedule",
        exam_number: e.exam_number,
        type: e.type,
        date: e.date,
        topics: e.topics,
        chapters: e.chapters,
        weight: e.weight,
      },
    });
  }

  // ── Grading breakdown ────────────────────────────────────────────────────────
  if (parsed.grading_breakdown.length > 0) {
    const gradingText = [
      parsed.grading_breakdown
        .map((g) => `${g.name}: ${(g.weight * 100).toFixed(0)}%${g.description ? ` — ${g.description}` : ""}`)
        .join("\n"),
      parsed.grading_notes ? `\nNote: ${parsed.grading_notes}` : null,
    ].filter(Boolean).join("");

    chunks.push({
      source: "syllabus",
      label: "Grading Breakdown",
      text: gradingText.slice(0, cap),
      meta: { section: "grading_breakdown" },
    });
  }

  return chunks;
}

// ─── Syllabus parser (single API call) ───────────────────────────────────────
// One call eliminates TPM rate-limit issues entirely.
// We build the input by stitching together the most relevant parts of the doc:
//   • first 2000 chars  → course info (always at the top)
//   • schedule section  → located by scanning for "Week 1" / "Module 1" etc.
//   • grading section   → located by scanning for "Grading" / "Midterm" etc.
// Total input: ~9000 chars ≈ 2250 tokens + 3500 output = ~5750 tokens (under 12k TPM).

function findSectionStart(text: string, patterns: RegExp[]): number {
  let best = -1;
  for (const p of patterns) {
    const idx = text.search(p);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

function assembleInput(text: string): string {
  const HEADER_CHARS = 2500;   // course info is always near the top
  const SCHED_CHARS  = 5000;   // enough for 13+ weeks
  const GRADE_CHARS  = 2500;   // grading table is usually compact

  const header = text.slice(0, HEADER_CHARS);

  // Find where the weekly schedule starts
  const schedIdx = findSectionStart(text, [
    /\bweek\s*1\b/i, /\bmodule\s*1\b/i, /\bunit\s*1\b/i,
    /\bsession\s*1\b/i, /\blecture\s*1\b/i,
  ]);
  const schedFrom = schedIdx === -1 ? 0 : Math.max(0, schedIdx - 300);
  const schedule = schedIdx === -1 ? "" : text.slice(schedFrom, schedFrom + SCHED_CHARS);

  // Find where the grading section starts
  const gradeIdx = findSectionStart(text, [
    /\bgrading\b/i, /\bgrade\s*breakdown\b/i,
    /\bassessment\s*schedule\b/i, /\bexam\s*schedule\b/i,
    /\bmidterm\b/i, /\bfinal\s*exam\b/i,
  ]);
  const gradeFrom = gradeIdx === -1 ? 0 : Math.max(0, gradeIdx - 100);
  const grading = gradeIdx === -1 ? "" : text.slice(gradeFrom, gradeFrom + GRADE_CHARS);

  // Stitch together, deduplicating any overlapping content
  const parts: string[] = [header];
  if (schedule && !header.includes(schedule.slice(0, 100))) {
    parts.push("\n\n--- WEEKLY SCHEDULE SECTION ---\n" + schedule);
  }
  if (grading && !header.includes(grading.slice(0, 100)) && !schedule.includes(grading.slice(0, 100))) {
    parts.push("\n\n--- GRADING SECTION ---\n" + grading);
  }
  return parts.join("");
}

async function parseSyllabus(text: string): Promise<ParsedSyllabusV2> {
  const input = assembleInput(text);

  const system = `You are an expert at parsing academic nursing course syllabi. Extract ALL structured information and return ONLY valid JSON — no markdown, no code fences, no extra text.

Return exactly this JSON shape:
{
  "course_name": "Full course title",
  "course_number": "e.g. NUR 301 or null",
  "instructor_name": "Full name or null",
  "instructor_email": "Email or null",
  "office_hours": "Day, time, location or null",
  "course_description": "2-3 sentence overview",
  "learning_objectives": ["objective 1"],
  "attendance_policy": "text or null",
  "late_work_policy": "text or null",
  "required_materials": ["Textbook title"],
  "weekly_schedule": [
    { "week": 1, "topic": "Topic", "learning_outcomes": ["outcome"], "chapters": ["Ch 1"], "date_range": "Aug 26-30 or null" }
  ],
  "exam_schedule": [
    { "exam_number": 1, "type": "midterm", "date": "Oct 8", "topics": ["topic"], "chapters": ["Ch 1"], "weight": 0.25, "notes": "text or null" }
  ],
  "grading_breakdown": [
    { "name": "Midterm", "weight": 0.25, "description": "text or null" }
  ],
  "grading_notes": "special conditions or null"
}

Critical rules:
- weekly_schedule: include EVERY week — do not stop early. If the schedule is cut off, include as many weeks as are visible.
- exam_number: sequential integers starting at 1, ordered by date.
- weight: always a decimal fraction (0.25 for 25%). Never a percentage string.
- If a field is absent, use null for strings and [] for arrays.
- Output ONLY the JSON object. Nothing else.`;

  const attempt = async (): Promise<Response> =>
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 3500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Parse this syllabus:\n\n${input}` },
        ],
      }),
    });

  let res = await attempt();

  // Retry once on 429 — wait exactly as long as Groq asks
  if (res.status === 429) {
    const retryAfterSec = parseFloat(res.headers.get("retry-after") ?? "");
    const waitMs = (Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 62000) + 500;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await attempt();
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = (data.choices[0].message.content as string)
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(raw) as ParsedSyllabusV2;

  // Normalize weight fields (LLM sometimes returns 25 or "25%" instead of 0.25)
  parsed.exam_schedule = (parsed.exam_schedule ?? []).map((e) => ({
    ...e, weight: normalizeWeight(e.weight),
  }));
  parsed.grading_breakdown = (parsed.grading_breakdown ?? []).map((g) => ({
    ...g, weight: normalizeWeight(g.weight) ?? 0,
  }));
  parsed.weekly_schedule = parsed.weekly_schedule ?? [];

  return parsed;
}

async function generateQuestionBank(
  files: TabFile[],
  tabLabel: string,
  teacherInstructions?: string
): Promise<ParsedQuestion[]> {
  const combinedContent = files.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n");

  const customSection = teacherInstructions?.trim()
    ? `\n\n━━━ INSTRUCTOR INSTRUCTIONS ━━━\n${teacherInstructions.trim()}\nApply these instructions to every question generated.\n`
    : "";

  const system = `You are NurseTutor, an expert nursing educator creating exam questions for a professor.
Generate 10-15 nursing questions (mix of MCQ and SATA). All must be clinical and scenario-based.${customSection}

DIFFICULTY & QUALITY RULES:
- Write at application and analysis level (NCLEX Next Generation style) — not recall/definition.
- Scenarios must include relevant clinical data: vitals, labs, medications, timeline.
- Distractors must be highly plausible — use common clinical misconceptions, look-alike drugs, or values close to normal limits. Never use obviously wrong options.
- CRITICAL: Distribute correct answers evenly across positions. Do NOT default to A or B. Across the set, spread answers across A, B, C, and D roughly equally. For any given question, the correct answer position must feel unpredictable.
- For SATA: 2–4 correct answers; incorrect options should represent common clinical errors.
- Include a mix of: priority/triage questions, pharmacology (dosing, interactions, patient teaching), assessment findings, and nursing interventions.

For EACH question use EXACTLY this format, separated by lines containing only ---:

TYPE: MCQ
QUESTION: [clinical scenario question]
A: [option]
B: [option]
C: [option]
D: [option]
ANSWER: [single letter]
EXPLANATION: [rationale]

---

TYPE: SATA
QUESTION: [clinical scenario ending with "Select all that apply."]
A: [option]
B: [option]
C: [option]
D: [option]
E: [option]
ANSWERS: [comma-separated letters, e.g. A,C,E]
EXPLANATION: [rationale]

---

Output ONLY the questions in this format. No preamble, no summary, no extra text.`;

  const user = `Generate a question bank for: ${tabLabel}\n\nStudy material:\n${
    combinedContent ||
    "(No files uploaded — generate general NCLEX-level nursing questions appropriate for this week of a nursing course)"
  }`;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 4096,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return parseQuestionBank(data.choices[0].message.content as string);
}

function parseQuestionBank(raw: string): ParsedQuestion[] {
  const blocks = raw.split(/\n---\n/).map((b) => b.trim()).filter(Boolean);
  const questions: ParsedQuestion[] = [];

  for (const block of blocks) {
    const typeMatch = block.match(/^TYPE:\s*(MCQ|SATA)/i);
    if (!typeMatch) continue;
    const type = typeMatch[1].toUpperCase() as "MCQ" | "SATA";

    const question = block.match(/QUESTION:\s*([\s\S]+?)(?=\nA:)/)?.[1]?.trim();
    const a = block.match(/^A:\s*(.+)/m)?.[1]?.trim();
    const b = block.match(/^B:\s*(.+)/m)?.[1]?.trim();
    const c = block.match(/^C:\s*(.+)/m)?.[1]?.trim();
    const d = block.match(/^D:\s*(.+)/m)?.[1]?.trim();
    const explanation = block.match(/EXPLANATION:\s*([\s\S]+)/)?.[1]?.trim();

    if (!question || !a || !b || !c || !d || !explanation) continue;
    const options: Record<string, string> = { A: a, B: b, C: c, D: d };

    if (type === "MCQ") {
      const answer = block.match(/ANSWER:\s*([ABCD])/)?.[1]?.trim();
      if (!answer) continue;
      questions.push({ id: uid(), type: "mcq", question, options, answer, explanation });
    } else {
      const e = block.match(/^E:\s*(.+)/m)?.[1]?.trim();
      const answersRaw = block.match(/ANSWERS:\s*([A-E,\s]+)/)?.[1]?.trim();
      if (!e || !answersRaw) continue;
      options.E = e;
      questions.push({ id: uid(), type: "sata", question, options, answer: answersRaw, explanation });
    }
  }
  return questions;
}

function exportQuestions(questions: ParsedQuestion[], tabLabel: string) {
  const lines: string[] = [
    `NurseTutor — Question Bank: ${tabLabel}`,
    `Generated: ${new Date().toLocaleDateString()}`,
    `Total questions: ${questions.length}`,
    "",
    "=".repeat(60),
    "",
  ];
  questions.forEach((q, i) => {
    lines.push(`Q${i + 1}. [${q.type.toUpperCase()}] ${q.question}`);
    Object.entries(q.options).forEach(([letter, text]) => {
      const isCorrect = q.answer.split(",").map((l) => l.trim()).includes(letter);
      lines.push(`  ${letter}. ${text}${isCorrect ? "  ✓" : ""}`);
    });
    lines.push(`Answer: ${q.answer}`);
    lines.push(`Explanation: ${q.explanation}`);
    lines.push("");
    lines.push("-".repeat(60));
    lines.push("");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nursetutor-${tabLabel.toLowerCase().replace(/\s+/g, "-")}-questions.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Question Card ─────────────────────────────────────────────────────────────

function QuestionCard({ question, index }: { question: ParsedQuestion; index: number }) {
  const [showExplanation, setShowExplanation] = useState(false);
  const correctLetters = question.answer.split(",").map((l) => l.trim());

  return (
    <div className="border border-border rounded-xl bg-card p-4 space-y-3">
      <div className="flex items-start gap-2">
        <span className={cn(
          "shrink-0 text-xs font-bold px-2 py-0.5 rounded-md",
          question.type === "mcq" ? "bg-amber-100 text-amber-700" : "bg-violet-100 text-violet-700"
        )}>
          {question.type.toUpperCase()}
        </span>
        <p className="text-sm font-medium leading-relaxed text-foreground">
          <span className="text-muted-foreground mr-1.5">Q{index + 1}.</span>
          {question.question}
        </p>
      </div>
      <div className="space-y-1.5 pl-1">
        {Object.entries(question.options).map(([letter, text]) => {
          const isCorrect = correctLetters.includes(letter);
          return (
            <div key={letter} className={cn(
              "flex items-start gap-2 text-sm px-3 py-2 rounded-lg border",
              isCorrect ? "border-emerald-400 bg-emerald-50 text-emerald-800" : "border-border bg-muted/30 text-muted-foreground"
            )}>
              <span className={cn(
                "shrink-0 w-5 h-5 rounded-full border text-xs flex items-center justify-center font-semibold mt-0.5",
                isCorrect ? "border-emerald-500 bg-emerald-500 text-white" : "border-muted-foreground/30 text-muted-foreground"
              )}>
                {isCorrect ? "✓" : letter}
              </span>
              <span>{text}</span>
            </div>
          );
        })}
      </div>
      <button
        onClick={() => setShowExplanation((v) => !v)}
        className="text-xs text-brand-600 hover:text-brand-700 font-medium transition-colors"
      >
        {showExplanation ? "Hide" : "Show"} rationale
      </button>
      {showExplanation && (
        <div className="p-3 rounded-lg bg-muted/50 border border-border text-xs text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground">Rationale: </span>
          {question.explanation}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function TeacherDashboard({ onBack }: { onBack: () => void }) {
  const [tabs, setTabs] = useState<CourseTab[]>(loadTabs);
  const [activeTabId, setActiveTabId] = useState("week-1");
  const [addingTab, setAddingTab] = useState(false);
  const [newTabName, setNewTabName] = useState("");
  const [questionIndex, setQuestionIndex] = useState(0);
  const [syllabusLoading, setSyllabusLoading] = useState(false);
  const [syllabusError, setSyllabusError] = useState("");
  const [syllabusFileName, setSyllabusFileName] = useState(
    () => localStorage.getItem(`${STORAGE_KEY}-filename`) ?? ""
  );
  const [publishedTabIds, setPublishedTabIds] = useState<Set<string>>(() => {
    try {
      const pool = loadPublishedPool();
      const publishedSources = new Set(pool.map((c) => c.source));
      const initialTabs = loadTabs();
      const ids = new Set<string>();
      for (const tab of initialTabs) {
        if (tab.files.some((f) => publishedSources.has(`${tab.label} — ${f.name}`))) {
          ids.add(tab.id);
        }
      }
      return ids;
    } catch { return new Set(); }
  });
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [fileUploading, setFileUploading] = useState(false);
  const [teacherInstructions, setTeacherInstructions] = useState<string>(
    () => localStorage.getItem("nursetutor-teacher-instructions") ?? ""
  );
  const [showInstructions, setShowInstructions] = useState(false);
  const [draftInstructions, setDraftInstructions] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const syllabusInputRef = useRef<HTMLInputElement>(null);

  // Persist to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  }, [tabs]);

  useEffect(() => {
    localStorage.setItem(`${STORAGE_KEY}-filename`, syllabusFileName);
  }, [syllabusFileName]);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const hasSyllabus = tabs.some((t) => t.kind === "info");
  const emptyWeekCount = tabs.filter(
    (t) => t.kind === "week" && !t.topic && t.files.length === 0 && t.questions.length === 0
  ).length;

  function updateTab(id: string, patch: Partial<CourseTab>) {
    // If the tab label is being changed and it was published, clear its old published chunks
    if (patch.label) {
      const tab = tabs.find((t) => t.id === id);
      if (tab && patch.label !== tab.label && publishedTabIds.has(id)) {
        unpublishTabSources(new Set(tab.files.map((f) => `${tab.label} — ${f.name}`)));
        setPublishedTabIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      }
    }
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    if (patch.questions) setQuestionIndex(0);
  }

  function removeTab(id: string) {
    if (publishedTabIds.has(id)) {
      const tab = tabs.find((t) => t.id === id);
      if (tab) unpublishTabSources(new Set(tab.files.map((f) => `${tab.label} — ${f.name}`)));
      setPublishedTabIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTabId === id) setActiveTabId(next[0]?.id ?? "week-1");
      return next;
    });
  }

  function removeEmptyWeeks() {
    setTabs((prev) => {
      const next = prev.filter(
        (t) => !(t.kind === "week" && !t.topic && t.files.length === 0 && t.questions.length === 0)
      );
      if (!next.find((t) => t.id === activeTabId)) {
        setActiveTabId(next[0]?.id ?? "");
      }
      return next;
    });
  }

  // Drag & drop reordering
  function handleDragStart(id: string) {
    setDraggedId(id);
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    if (id !== draggedId) setDragOverId(id);
  }

  function handleDrop(targetId: string) {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    const from = tabs.findIndex((t) => t.id === draggedId);
    const to = tabs.findIndex((t) => t.id === targetId);
    if (from === -1 || to === -1) { setDraggedId(null); setDragOverId(null); return; }

    const reordered = [...tabs];
    const [item] = reordered.splice(from, 1);
    reordered.splice(to, 0, item);

    // Auto-renumber any tab whose label matches "Week N"
    let weekNum = 1;
    const renumbered = reordered.map((tab) => {
      if (tab.kind !== "week") return tab;
      if (/^Week \d+$/.test(tab.label)) return { ...tab, label: `Week ${weekNum++}` };
      weekNum++;
      return tab;
    });

    // Unpublish any tab whose label changed (old source names are now stale)
    const labelChanged = renumbered.filter((tab) => {
      const old = tabs.find((t) => t.id === tab.id);
      return old && old.label !== tab.label && publishedTabIds.has(tab.id);
    });
    if (labelChanged.length > 0) {
      const staleSources = new Set<string>(
        labelChanged.flatMap((tab) => {
          const old = tabs.find((t) => t.id === tab.id)!;
          return old.files.map((f) => `${old.label} — ${f.name}`);
        })
      );
      unpublishTabSources(staleSources);
      setPublishedTabIds((prev) => {
        const s = new Set(prev);
        labelChanged.forEach((tab) => s.delete(tab.id));
        return s;
      });
    }

    setTabs(renumbered);
    setDraggedId(null);
    setDragOverId(null);
  }

  function handleDragEnd() {
    setDraggedId(null);
    setDragOverId(null);
  }

  function addCustomTab() {
    if (!newTabName.trim()) return;
    const weekCount = tabs.filter((t) => t.kind === "week").length;
    const nextWeekNum = weekCount + 1;
    const newTab: CourseTab = {
      id: uid(),
      label: `Week ${nextWeekNum}`,
      topic: newTabName.trim(),
      kind: "week",
      isCustom: true,
      files: [],
      questions: [],
      loading: false,
      error: "",
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setNewTabName("");
    setAddingTab(false);
  }

  async function handleSyllabusUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setSyllabusLoading(true);
    setSyllabusError("");
    setSyllabusFileName(file.name);

    try {
      const text = await extractText(file);
      const parsed = await parseSyllabus(text);

      setTabs((prev) => {
        const updated = prev.map((tab) => {
          if (tab.kind !== "week") return tab;
          const weekNum = parseInt(tab.id.replace("week-", ""));
          const weekData = parsed.weekly_schedule.find((w) => w.week === weekNum);
          if (!weekData) return tab;
          return { ...tab, topic: weekData.topic, learningOutcomes: weekData.learning_outcomes };
        });
        const withoutInfo = updated.filter((t) => t.kind !== "info");
        const infoTabs: CourseTab[] = [
          makeInfoTab("info-overview", "Course Overview", parsed.course_description),
          makeInfoTab("info-grading", "Grading Policy",
            parsed.grading_breakdown.map((g) => `${g.name}: ${(g.weight * 100).toFixed(0)}%${g.description ? ` — ${g.description}` : ""}`).join("\n") +
            (parsed.grading_notes ? `\n\n${parsed.grading_notes}` : "")
          ),
          makeInfoTab("info-office", "Office Hours",
            [parsed.instructor_name, parsed.instructor_email, parsed.office_hours].filter(Boolean).join("\n")
          ),
        ];
        return [...withoutInfo, ...infoTabs];
      });

      // Save to dedicated syllabus pool (does NOT touch nursetutor-published-pool)
      saveSyllabusPool(syllabusToChunks(parsed));
    } catch (err) {
      setSyllabusError(
        err instanceof SyntaxError
          ? "Could not parse the syllabus structure. Try a .txt or .docx version."
          : `Failed to analyze syllabus: ${err instanceof Error ? err.message : String(err)}`
      );
      setSyllabusFileName("");
    } finally {
      setSyllabusLoading(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const uploadingToTabId = activeTabId; // capture at event time
    e.target.value = "";
    setFileUploading(true);
    updateTab(uploadingToTabId, { error: "" });
    try {
      const content = await extractText(file);
      const newFile: TabFile = { name: file.name, content };
      // Use functional setTabs so we always append to the latest files array (fixes stale closure)
      setTabs((prev) => prev.map((t) =>
        t.id === uploadingToTabId ? { ...t, files: [...t.files, newFile] } : t
      ));
    } catch {
      updateTab(uploadingToTabId, { error: `Could not read ${file.name}. Try .txt, .md, .pdf, .docx, or .pptx.` });
    } finally {
      setFileUploading(false);
    }
  }

  function removeFile(fileName: string) {
    if (!activeTab) return;
    if (publishedTabIds.has(activeTabId)) {
      unpublishTabSources(new Set([`${activeTab.label} — ${fileName}`]));
      const remaining = activeTab.files.filter((f) => f.name !== fileName);
      if (remaining.length === 0) {
        setPublishedTabIds((prev) => { const s = new Set(prev); s.delete(activeTabId); return s; });
      }
    }
    updateTab(activeTabId, { files: activeTab.files.filter((f) => f.name !== fileName) });
  }

  function handlePublish() {
    if (!activeTab || activeTab.files.length === 0) return;
    try {
      publishTab(activeTab);
      setPublishedTabIds((prev) => new Set([...prev, activeTabId]));
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        updateTab(activeTabId, { error: "Storage full — remove some files before publishing." });
      }
    }
  }

  async function handleGenerate() {
    if (!activeTab) return;
    updateTab(activeTabId, { loading: true, error: "" });
    try {
      const questions = await generateQuestionBank(activeTab.files, activeTab.label, teacherInstructions);
      updateTab(activeTabId, { questions, loading: false });
    } catch {
      updateTab(activeTabId, { loading: false, error: "Failed to generate questions. Please try again." });
    }
  }

  // Learning outcome helpers
  function updateLearningOutcome(index: number, value: string) {
    if (!activeTab) return;
    const outcomes = [...(activeTab.learningOutcomes ?? [])];
    outcomes[index] = value;
    updateTab(activeTabId, { learningOutcomes: outcomes });
  }

  function removeLearningOutcome(index: number) {
    if (!activeTab) return;
    const outcomes = (activeTab.learningOutcomes ?? []).filter((_, i) => i !== index);
    updateTab(activeTabId, { learningOutcomes: outcomes });
  }

  function addLearningOutcome() {
    if (!activeTab) return;
    updateTab(activeTabId, { learningOutcomes: [...(activeTab.learningOutcomes ?? []), ""] });
  }

  function clearDashboard() {
    const fresh = defaultTabs();
    setTabs(fresh);
    setActiveTabId(fresh[0].id);
    setPublishedTabIds(new Set());
    setSyllabusFileName("");
    setSyllabusError("");
    localStorage.removeItem(PUBLISHED_KEY);
    localStorage.removeItem(`${STORAGE_KEY}-filename`);
    clearSyllabusPool();
    setConfirmClear(false);
  }

  const infoIcon: Record<string, string> = {
    "info-overview": "📋",
    "info-grading": "📊",
    "info-office": "🕐",
  };

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-slate-100 via-white to-white font-sans">

      {/* ── Header ── */}
      <header className="shrink-0 bg-white/80 backdrop-blur-sm border-b border-border shadow-sm px-5 py-3 flex items-center gap-3 z-10">
        <div className="w-9 h-9 rounded-xl overflow-hidden shrink-0 shadow-sm ring-1 ring-border">
          <img src="/nurse-avatar.png" alt="NurseTutor" className="w-full h-full object-cover" />
        </div>
        <div>
          <h1 className="text-sm font-bold tracking-tight">NurseTutor</h1>
          <p className="text-xs text-muted-foreground">Teacher Dashboard</p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {hasSyllabus && (
            <span className="hidden sm:flex text-xs text-emerald-600 font-medium items-center gap-1 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 h-8">
              <span>✓</span>
              <span className="truncate max-w-[140px]">{syllabusFileName}</span>
            </span>
          )}
          <button
            onClick={() => syllabusInputRef.current?.click()}
            disabled={syllabusLoading || locked}
            className={cn(
              "text-xs border rounded-lg px-3 h-8 transition-all font-medium whitespace-nowrap",
              hasSyllabus
                ? "border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                : "border-brand-400 text-brand-600 hover:bg-brand-50"
            )}
          >
            {syllabusLoading ? "Analyzing…" : hasSyllabus ? "↑ Re-upload Syllabus" : "↑ Upload Syllabus"}
          </button>
          <input ref={syllabusInputRef} type="file" accept=".txt,.md,.docx,.pdf,.pptx,.png,.jpg,.jpeg,.webp,.gif" className="hidden" onChange={handleSyllabusUpload} />
          <button
            onClick={() => { setDraftInstructions(teacherInstructions); setShowInstructions((v) => !v); }}
            title="Custom instructions for question generation"
            className={cn(
              "text-xs border rounded-lg px-3 h-8 transition-all font-medium",
              teacherInstructions
                ? "border-brand-400 text-brand-600 bg-brand-50"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {teacherInstructions ? "⚙ Prompt ●" : "⚙ Prompt"}
          </button>
          <button
            onClick={() => setLocked((v) => !v)}
            title={locked ? "Unlock editing" : "Lock — prevent accidental edits"}
            className={cn(
              "text-xs border rounded-lg px-3 h-8 transition-all font-medium",
              locked
                ? "border-amber-300 text-amber-700 bg-amber-50"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {locked ? "🔒 Locked" : "🔓 Editing"}
          </button>
          <button
            onClick={onBack}
            className="text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 h-8 transition-all hover:border-brand-400"
          >
            ← Home
          </button>
        </div>
      </header>

      {/* ── Prompt instructions panel ── */}
      {showInstructions && (
        <div className="shrink-0 border-b border-border bg-brand-50/50 px-5 py-3 space-y-2">
          <p className="text-xs font-semibold text-brand-700">Question generation instructions</p>
          <p className="text-xs text-muted-foreground">
            Customise every question bank generated — e.g. "Focus on pharmacology and drug calculations", "Include delegation and priority questions", "Use Canadian drug names", "Make questions harder with ambiguous distractors". Applied until cleared.
          </p>
          <textarea
            value={draftInstructions}
            onChange={(e) => setDraftInstructions(e.target.value)}
            placeholder="e.g. Focus on critical care — include ventilator settings, vasopressors, and haemodynamic monitoring…"
            rows={3}
            className="w-full text-sm rounded-lg border border-border bg-background px-3 py-2 resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 placeholder:text-muted-foreground"
          />
          <div className="flex gap-2">
            <button
              className="text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-lg px-3 h-8 font-semibold transition-all"
              onClick={() => {
                setTeacherInstructions(draftInstructions);
                localStorage.setItem("nursetutor-teacher-instructions", draftInstructions);
                setShowInstructions(false);
              }}
            >
              Save
            </button>
            <button
              className="text-xs border border-border rounded-lg px-3 h-8 text-muted-foreground hover:text-foreground transition-all"
              onClick={() => {
                setDraftInstructions("");
                setTeacherInstructions("");
                localStorage.removeItem("nursetutor-teacher-instructions");
                setShowInstructions(false);
              }}
            >
              Clear
            </button>
            <button
              className="text-xs text-muted-foreground hover:text-foreground px-2 ml-auto"
              onClick={() => setShowInstructions(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Banners ── */}
      {syllabusError && (
        <div className="shrink-0 px-5 py-2 bg-red-50 border-b border-red-200 text-xs text-red-600">{syllabusError}</div>
      )}
      {syllabusLoading && (
        <div className="shrink-0 px-5 py-2 bg-brand-50 border-b border-brand-200 text-xs text-brand-700 flex items-center gap-2">
          <span className="animate-spin inline-block">⟳</span> Analyzing syllabus — please wait…
        </div>
      )}
      {hasSyllabus && emptyWeekCount > 0 && !locked && (
        <div className="shrink-0 px-5 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 flex items-center gap-2">
          <span>{emptyWeekCount} week{emptyWeekCount > 1 ? "s" : ""} have no syllabus content.</span>
          <button onClick={removeEmptyWeeks} className="underline font-semibold hover:text-amber-900">Remove them</button>
        </div>
      )}

      {/* ── Body: sidebar + content ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar ── */}
        <aside className="w-52 shrink-0 bg-white border-r border-border flex flex-col overflow-hidden shadow-sm">

          {/* Week tabs */}
          <div className="px-3 pt-4 pb-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
              {!locked ? "Course Weeks · drag to reorder" : "Course Weeks"}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto py-1 space-y-0.5 px-2">
            {tabs.filter((t) => t.kind === "week").map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  "group relative rounded-lg transition-opacity",
                  draggedId === tab.id && "opacity-30",
                  dragOverId === tab.id && draggedId !== tab.id && "ring-2 ring-brand-400"
                )}
                draggable={!locked}
                onDragStart={!locked ? () => handleDragStart(tab.id) : undefined}
                onDragOver={!locked ? (e) => handleDragOver(e, tab.id) : undefined}
                onDrop={!locked ? () => handleDrop(tab.id) : undefined}
                onDragEnd={!locked ? handleDragEnd : undefined}
              >
                <button
                  onClick={() => { setActiveTabId(tab.id); setQuestionIndex(0); }}
                  className={cn(
                    "w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2 transition-all",
                    activeTabId === tab.id
                      ? "bg-brand-500 text-white shadow-sm"
                      : "hover:bg-muted/60 text-foreground"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      "text-xs font-semibold truncate",
                      activeTabId === tab.id ? "text-white" : "text-foreground"
                    )}>
                      {tab.topic ?? tab.label}
                    </p>
                    {tab.topic && (
                      <p className={cn(
                        "text-[10px] truncate",
                        activeTabId === tab.id ? "text-white/70" : "text-muted-foreground"
                      )}>
                        {tab.label}
                      </p>
                    )}
                  </div>
                  {tab.questions.length > 0 && (
                    <span className={cn(
                      "shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-bold",
                      activeTabId === tab.id ? "bg-white/20 text-white" : "bg-brand-100 text-brand-700"
                    )}>
                      {tab.questions.length}
                    </span>
                  )}
                  {publishedTabIds.has(tab.id) && (
                    <span className={cn("shrink-0 w-2 h-2 rounded-full", activeTabId === tab.id ? "bg-white/80" : "bg-emerald-500")} title="Published to students" />
                  )}
                </button>
                {!locked && (
                  <button
                    onClick={(e) => { e.stopPropagation(); removeTab(tab.id); }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 w-4 h-4 rounded text-[10px] bg-muted hover:bg-red-100 hover:text-red-500 flex items-center justify-center transition-all"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}

            {/* Info tabs */}
            {tabs.some((t) => t.kind === "info") && (
              <>
                <div className="px-1 pt-4 pb-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Course Info</p>
                </div>
                {tabs.filter((t) => t.kind === "info").map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => { setActiveTabId(tab.id); setQuestionIndex(0); }}
                    className={cn(
                      "w-full text-left px-2.5 py-2 rounded-lg flex items-center gap-2 transition-all",
                      activeTabId === tab.id
                        ? "bg-slate-700 text-white shadow-sm"
                        : "hover:bg-muted/60 text-foreground"
                    )}
                  >
                    <span className="text-sm shrink-0">{infoIcon[tab.id] ?? "📄"}</span>
                    <p className={cn(
                      "text-xs font-semibold truncate",
                      activeTabId === tab.id ? "text-white" : "text-foreground"
                    )}>
                      {tab.label}
                    </p>
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Sidebar footer: add tab + clear */}
          <div className="shrink-0 border-t border-border p-2 space-y-1">
            {addingTab ? (
              <div className="space-y-1.5">
                <input
                  autoFocus
                  value={newTabName}
                  onChange={(e) => setNewTabName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addCustomTab();
                    if (e.key === "Escape") setAddingTab(false);
                  }}
                  placeholder="Topic name…"
                  className="w-full text-xs border border-brand-400 rounded-lg px-2 h-7 focus:outline-none focus:ring-1 focus:ring-brand-400 bg-background"
                />
                <div className="flex gap-1">
                  <button onClick={addCustomTab} className="flex-1 text-xs bg-brand-500 text-white rounded-lg h-7 font-semibold hover:bg-brand-600">Add</button>
                  <button onClick={() => setAddingTab(false)} className="text-xs text-muted-foreground hover:text-foreground px-2">✕</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingTab(true)}
                className="w-full text-xs px-3 py-2 rounded-lg border border-dashed border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600 transition-all"
              >
                + Add tab
              </button>
            )}

            {confirmClear ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-2 space-y-1.5">
                <p className="text-[11px] text-red-700 font-medium text-center">Clear everything?</p>
                <p className="text-[10px] text-red-500 text-center leading-snug">All files, questions, and published data will be removed.</p>
                <div className="flex gap-1">
                  <button onClick={clearDashboard} className="flex-1 text-xs bg-red-500 text-white rounded-lg h-7 font-semibold hover:bg-red-600">Clear</button>
                  <button onClick={() => setConfirmClear(false)} className="flex-1 text-xs border border-border rounded-lg h-7 text-muted-foreground hover:text-foreground">Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmClear(true)}
                className="w-full text-[11px] px-3 py-1.5 rounded-lg text-muted-foreground/70 hover:text-red-500 hover:bg-red-50 transition-all"
              >
                Clear dashboard
              </button>
            )}
          </div>
        </aside>

        {/* ── Main content ── */}
        <ScrollArea className="flex-1">
          <div className="max-w-2xl mx-auto px-8 py-7 space-y-6">

            {/* No tabs */}
            {!activeTab && (
              <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
                <p className="text-4xl">📭</p>
                <p className="text-sm font-semibold text-foreground">No tabs left</p>
                <p className="text-xs text-muted-foreground">You removed all tabs. Reset to start fresh.</p>
                <Button
                  className="bg-brand-500 hover:bg-brand-600 text-white mt-2"
                  onClick={() => { const fresh = defaultTabs(); setTabs(fresh); setActiveTabId(fresh[0].id); }}
                >
                  Reset to default weeks
                </Button>
              </div>
            )}

            {/* Info tab */}
            {activeTab?.kind === "info" && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="text-xl">{infoIcon[activeTab.id] ?? "📄"}</span>
                  <h2 className="text-sm font-bold text-foreground">{activeTab.label}</h2>
                  {!locked && <span className="text-xs text-muted-foreground">· click to edit</span>}
                </div>
                <textarea
                  value={activeTab.content ?? ""}
                  onChange={(e) => !locked && updateTab(activeTabId, { content: e.target.value })}
                  readOnly={locked}
                  placeholder={locked ? "No information found." : "No information found. Type here or re-upload your syllabus."}
                  className={cn(
                    "w-full text-sm text-foreground leading-relaxed bg-white border border-border rounded-xl p-5 shadow-sm focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none min-h-[220px]",
                    locked && "cursor-default focus:ring-0"
                  )}
                />
              </div>
            )}

            {/* Week tab */}
            {activeTab?.kind === "week" && (
              <>
                {/* Topic + outcomes */}
                <div className={cn(
                  "rounded-xl border px-5 py-4 space-y-3 shadow-sm",
                  activeTab.topic ? "border-emerald-200 bg-emerald-50" : "border-dashed border-border bg-white"
                )}>
                  <div className="flex items-center justify-between">
                    <span className={cn("text-xs font-bold uppercase tracking-wide", activeTab.topic ? "text-emerald-700" : "text-muted-foreground")}>
                      Week Topic
                    </span>
                    {activeTab.topic && !locked && <span className="text-xs text-emerald-500">editable</span>}
                  </div>
                  <input
                    value={activeTab.topic ?? ""}
                    onChange={(e) => !locked && updateTab(activeTabId, { topic: e.target.value || undefined })}
                    readOnly={locked}
                    placeholder={locked ? "No topic set." : "Enter a topic for this week…"}
                    className={cn(
                      "w-full text-sm font-semibold bg-transparent border-b focus:outline-none pb-1 placeholder:font-normal placeholder:text-muted-foreground",
                      locked ? "cursor-default" : "",
                      activeTab.topic ? "text-emerald-900 border-emerald-300 focus:border-emerald-500" : "text-foreground border-border focus:border-brand-400"
                    )}
                  />
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className={cn("text-xs font-semibold", activeTab.topic ? "text-emerald-700" : "text-muted-foreground")}>Learning Outcomes</p>
                      {!locked && (
                        <button onClick={addLearningOutcome} className={cn("text-xs font-medium hover:underline", activeTab.topic ? "text-emerald-600" : "text-brand-600")}>
                          + Add outcome
                        </button>
                      )}
                    </div>
                    {(activeTab.learningOutcomes ?? []).length === 0 && (
                      <p className="text-xs text-muted-foreground italic">No outcomes yet. Add one or upload a syllabus.</p>
                    )}
                    {(activeTab.learningOutcomes ?? []).map((lo, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className={cn("shrink-0 text-xs mt-0.5", activeTab.topic ? "text-emerald-400" : "text-muted-foreground")}>•</span>
                        <input
                          value={lo}
                          onChange={(e) => !locked && updateLearningOutcome(i, e.target.value)}
                          readOnly={locked}
                          placeholder="Learning outcome…"
                          className={cn(
                            "flex-1 text-xs bg-transparent border-b focus:outline-none py-0.5",
                            locked ? "cursor-default" : "",
                            activeTab.topic ? "text-emerald-800 border-emerald-200 focus:border-emerald-400" : "text-foreground border-border focus:border-brand-400"
                          )}
                        />
                        {!locked && (
                          <button onClick={() => removeLearningOutcome(i)} className="text-sm text-muted-foreground hover:text-red-500 transition-colors">×</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Upload */}
                <div className="space-y-3">
                  <h2 className="text-sm font-bold text-foreground">{activeTab.label} — Study Material</h2>
                  <div
                    onClick={() => !fileUploading && fileInputRef.current?.click()}
                    className={cn(
                      "border-2 border-dashed rounded-xl px-6 py-8 text-center transition-all bg-white shadow-sm",
                      fileUploading
                        ? "border-brand-300 bg-brand-50/60 cursor-wait"
                        : "border-border cursor-pointer hover:border-brand-400 hover:bg-brand-50/40"
                    )}
                  >
                    {fileUploading ? (
                      <>
                        <div className="w-10 h-10 rounded-xl bg-brand-100 border border-brand-200 flex items-center justify-center mx-auto mb-3">
                          <span className="animate-spin text-brand-500 text-lg">⟳</span>
                        </div>
                        <p className="text-sm font-medium text-brand-600">Processing file…</p>
                        <p className="text-xs text-muted-foreground mt-1">This may take a moment for PDFs</p>
                      </>
                    ) : (
                      <>
                        <div className="w-10 h-10 rounded-xl bg-brand-50 border border-brand-200 flex items-center justify-center mx-auto mb-3">
                          <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5 text-brand-500">
                            <path d="M12 2v10m0 0l-3-3m3 3l3-3M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                        <p className="text-sm font-medium text-foreground">Click to upload files</p>
                        <p className="text-xs text-muted-foreground mt-1">.txt, .md, .pdf, .docx, .pptx, or images (jpg, png)</p>
                      </>
                    )}
                  </div>
                  <input ref={fileInputRef} type="file" accept=".txt,.md,.pdf,.docx,.pptx,.png,.jpg,.jpeg,.webp,.gif" className="hidden" onChange={handleFileUpload} disabled={fileUploading} />
                  {activeTab.files.length > 0 && (
                    <div className="space-y-1.5">
                      {activeTab.files.map((f) => (
                        <div key={f.name} className="flex items-center gap-2 text-xs bg-white border border-border rounded-lg px-3 py-2 shadow-sm">
                          <span className="text-base">📄</span>
                          <span className="flex-1 truncate text-foreground font-medium">{f.name}</span>
                          <button onClick={() => removeFile(f.name)} className="text-muted-foreground hover:text-red-500 transition-colors">✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Publish to students */}
                {activeTab.files.length > 0 && (
                  <div className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-border bg-white shadow-sm">
                    <div className="flex-1 min-w-0">
                      {publishedTabIds.has(activeTabId) ? (
                        <p className="text-xs text-emerald-700 font-semibold">Published — students can ask questions about this material</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">Share this week's files with students so their AI chat is grounded in your material.</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={handlePublish}
                      className={cn(
                        "shrink-0 text-xs font-semibold shadow-sm",
                        publishedTabIds.has(activeTabId)
                          ? "bg-emerald-500 hover:bg-emerald-600 text-white"
                          : "bg-brand-500 hover:bg-brand-600 text-white"
                      )}
                    >
                      {publishedTabIds.has(activeTabId) ? "Re-publish" : "Publish to students"}
                    </Button>
                  </div>
                )}

                {/* Generate + Export */}
                <div className="flex flex-wrap items-center gap-3">
                  <Button className="bg-brand-500 hover:bg-brand-600 text-white shadow-sm" onClick={handleGenerate} disabled={activeTab.loading}>
                    {activeTab.loading ? "Generating…" : `Generate question bank for ${activeTab.label}`}
                  </Button>
                  {activeTab.questions.length > 0 && (
                    <Button variant="outline" onClick={() => exportQuestions(activeTab.questions, activeTab.label)}>
                      Export {activeTab.questions.length} questions (.txt)
                    </Button>
                  )}
                </div>

                {activeTab.error && <p className="text-xs text-red-500">{activeTab.error}</p>}

                {/* Questions slideshow */}
                {activeTab.questions.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-foreground">Question Bank</h3>
                      <span className="text-xs bg-brand-100 text-brand-700 font-semibold px-2 py-0.5 rounded-full">
                        {activeTab.questions.length} questions
                      </span>
                    </div>
                    <QuestionCard key={activeTab.questions[questionIndex].id} question={activeTab.questions[questionIndex]} index={questionIndex} />
                    <div className="flex items-center justify-between pt-1">
                      <button
                        onClick={() => setQuestionIndex((i) => Math.max(0, i - 1))}
                        disabled={questionIndex === 0}
                        className="text-xs px-4 py-2 rounded-lg border border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        ← Previous
                      </button>
                      <span className="text-xs text-muted-foreground">{questionIndex + 1} / {activeTab.questions.length}</span>
                      <button
                        onClick={() => setQuestionIndex((i) => Math.min(activeTab.questions.length - 1, i + 1))}
                        disabled={questionIndex === activeTab.questions.length - 1}
                        className="text-xs px-4 py-2 rounded-lg border border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Next →
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
