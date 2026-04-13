import React, { useState, useRef, useEffect } from "react";
import { extractText } from "./lib/parseFile";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

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

interface ParsedSyllabus {
  course_overview: string;
  office_hours: string;
  grading_policy: string;
  weekly_topics: Array<{
    week: number;
    topic: string;
    learning_outcomes: string[];
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2);
}

const STORAGE_KEY = "nursetutor-teacher-v1";
const PUBLISHED_KEY = "nursetutor-published-pool";

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

async function parseSyllabus(text: string): Promise<ParsedSyllabus> {
  const syllabusText = text.slice(0, 16000);

  async function groqCall(systemPrompt: string, userContent: string, maxTokens: number) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const raw = data.choices[0].message.content as string;
    return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // ── Call 1: course metadata ─────────────────────────────────────────────────
  const metaSystem = `You are an expert at parsing academic course syllabi. Extract structured information and return ONLY valid JSON — no markdown, no code fences, no extra text.

Return exactly this JSON shape:
{
  "course_overview": "brief course description and objectives",
  "office_hours": "instructor name, contact, and office hours details",
  "grading_policy": "complete grading breakdown with percentages and descriptions"
}

Output ONLY the JSON object. Nothing else.`;

  const metaCleaned = await groqCall(metaSystem, `Parse this syllabus:\n\n${syllabusText.slice(0, 10000)}`, 1024);
  const meta = JSON.parse(metaCleaned) as Omit<ParsedSyllabus, "weekly_topics">;

  // Small delay to avoid hitting Groq rate limit between two rapid calls
  await new Promise((r) => setTimeout(r, 800));

  // ── Call 2: weekly topics only — all 4096 tokens dedicated to weeks ─────────
  const weeksSystem = `You are an expert at parsing academic course syllabi. Extract the weekly schedule and return ONLY valid JSON — no markdown, no code fences, no extra text.

Return exactly this JSON shape:
{
  "weekly_topics": [
    { "week": 1, "topic": "Topic Name", "learning_outcomes": ["outcome 1", "outcome 2"] }
  ]
}

Rules:
- Include EVERY week listed in the syllabus — do not stop early or skip any week.
- Keep learning_outcomes to 2-3 concise bullet phrases per week.
- If no weekly schedule is present, return { "weekly_topics": [] }.
- Output ONLY the JSON object. Nothing else.`;

  const weeksCleaned = await groqCall(weeksSystem, `Extract all weekly topics from this syllabus:\n\n${syllabusText}`, 4096);
  const weeks = JSON.parse(weeksCleaned) as Pick<ParsedSyllabus, "weekly_topics">;

  return { ...meta, weekly_topics: weeks.weekly_topics };
}

async function generateQuestionBank(
  files: TabFile[],
  tabLabel: string
): Promise<ParsedQuestion[]> {
  const combinedContent = files.map((f) => `--- ${f.name} ---\n${f.content}`).join("\n\n");

  const system = `You are NurseTutor, an expert nursing educator creating exam questions for a professor.
Generate 10-15 nursing questions (mix of MCQ and SATA). All must be clinical and scenario-based.

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
          const weekData = parsed.weekly_topics.find((w) => w.week === weekNum);
          if (!weekData) return tab;
          return { ...tab, topic: weekData.topic, learningOutcomes: weekData.learning_outcomes };
        });
        const withoutInfo = updated.filter((t) => t.kind !== "info");
        const infoTabs: CourseTab[] = [
          makeInfoTab("info-overview", "Course Overview", parsed.course_overview),
          makeInfoTab("info-grading", "Grading Policy", parsed.grading_policy),
          makeInfoTab("info-office", "Office Hours", parsed.office_hours),
        ];
        return [...withoutInfo, ...infoTabs];
      });

      // Auto-publish syllabus content to the shared student pool
      const syllabusChunks: PooledChunk[] = [
        ...chunkTeacherText("Syllabus", "Course Overview", parsed.course_overview),
        ...chunkTeacherText("Syllabus", "Grading Policy", parsed.grading_policy),
        ...chunkTeacherText("Syllabus", "Office Hours", parsed.office_hours),
        ...(parsed.weekly_topics.length > 0
          ? chunkTeacherText("Syllabus", "Weekly Topics", parsed.weekly_topics
              .map((w) => `Week ${w.week}: ${w.topic}\n${w.learning_outcomes.join("\n")}`)
              .join("\n\n"))
          : []),
      ];
      const syllabusSourcePrefixes = new Set(["Syllabus — Course Overview", "Syllabus — Grading Policy", "Syllabus — Office Hours", "Syllabus — Weekly Topics"]);
      const existingPool = loadPublishedPool().filter((c) => !syllabusSourcePrefixes.has(c.source));
      savePublishedPool([...existingPool, ...syllabusChunks]);
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
      const questions = await generateQuestionBank(activeTab.files, activeTab.label);
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

      {/* ── Banners ── */}
      {syllabusError && (
        <div className="shrink-0 px-5 py-2 bg-red-50 border-b border-red-200 text-xs text-red-600">{syllabusError}</div>
      )}
      {syllabusLoading && (
        <div className="shrink-0 px-5 py-2 bg-brand-50 border-b border-brand-200 text-xs text-brand-700 flex items-center gap-2">
          <span className="animate-spin inline-block">⟳</span> Analyzing syllabus and populating week topics…
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
