import React, { useState, useRef } from "react";
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
  answer: string; // "B" or "A,C,D"
  explanation: string;
}

interface CourseTab {
  id: string;
  label: string;
  isCustom: boolean;
  files: TabFile[];
  questions: ParsedQuestion[];
  loading: boolean;
  error: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2);
}

function defaultTabs(): CourseTab[] {
  return Array.from({ length: 13 }, (_, i) => ({
    id: `week-${i + 1}`,
    label: `Week ${i + 1}`,
    isCustom: false,
    files: [],
    questions: [],
    loading: false,
    error: "",
  }));
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function generateQuestionBank(
  files: TabFile[],
  tabLabel: string
): Promise<ParsedQuestion[]> {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY as string;

  const combinedContent = files
    .map((f) => `--- ${f.name} ---\n${f.content}`)
    .join("\n\n");

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

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
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
  const blocks = raw
    .split(/\n---\n/)
    .map((b) => b.trim())
    .filter(Boolean);
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

function QuestionCard({
  question,
  index,
}: {
  question: ParsedQuestion;
  index: number;
}) {
  const [showExplanation, setShowExplanation] = useState(false);
  const correctLetters = question.answer.split(",").map((l) => l.trim());

  return (
    <div className="border border-border rounded-xl bg-card p-4 space-y-3">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "shrink-0 text-xs font-bold px-2 py-0.5 rounded-md",
            question.type === "mcq"
              ? "bg-amber-100 text-amber-700"
              : "bg-violet-100 text-violet-700"
          )}
        >
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
            <div
              key={letter}
              className={cn(
                "flex items-start gap-2 text-sm px-3 py-2 rounded-lg border",
                isCorrect
                  ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                  : "border-border bg-muted/30 text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "shrink-0 w-5 h-5 rounded-full border text-xs flex items-center justify-center font-semibold mt-0.5",
                  isCorrect
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-muted-foreground/30 text-muted-foreground"
                )}
              >
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
  const [tabs, setTabs] = useState<CourseTab[]>(defaultTabs);
  const [activeTabId, setActiveTabId] = useState("week-1");
  const [addingTab, setAddingTab] = useState(false);
  const [newTabName, setNewTabName] = useState("");
  const [questionIndex, setQuestionIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId)!;

  function updateTab(id: string, patch: Partial<CourseTab>) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    if (patch.questions) setQuestionIndex(0);
  }

  function addCustomTab() {
    if (!newTabName.trim()) return;
    const newTab: CourseTab = {
      id: uid(),
      label: newTabName.trim(),
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

  function removeCustomTab(id: string) {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveTabId("week-1");
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const isPdf = file.name.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      updateTab(activeTabId, {
        files: [...activeTab.files, { name: file.name, content: `[PDF: ${file.name}]` }],
      });
      return;
    }

    try {
      const content = await extractText(file);
      updateTab(activeTabId, {
        files: [...activeTab.files, { name: file.name, content }],
      });
    } catch {
      updateTab(activeTabId, { error: `Could not read ${file.name}. Try .txt, .md, .docx, or .pptx.` });
    }
  }

  function removeFile(fileName: string) {
    updateTab(activeTabId, {
      files: activeTab.files.filter((f) => f.name !== fileName),
    });
  }

  async function handleGenerate() {
    updateTab(activeTabId, { loading: true, error: "" });
    try {
      const questions = await generateQuestionBank(activeTab.files, activeTab.label);
      updateTab(activeTabId, { questions, loading: false });
    } catch {
      updateTab(activeTabId, {
        loading: false,
        error: "Failed to generate questions. Please try again.",
      });
    }
  }

  return (
    <div className="flex flex-col h-screen bg-background font-sans max-w-5xl mx-auto">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-5 py-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full overflow-hidden shrink-0">
          <img
            src="/nurse-avatar.png"
            alt="NurseTutor"
            className="w-full h-full object-cover"
          />
        </div>
        <div>
          <h1 className="text-sm font-semibold tracking-tight">NurseTutor</h1>
          <p className="text-xs text-muted-foreground">Teacher Dashboard</p>
        </div>
        <button
          onClick={onBack}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 h-8 transition-all hover:border-brand-400"
        >
          ← Home
        </button>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-2 flex items-center gap-1.5 overflow-x-auto">
        {tabs.map((tab) => (
          <div key={tab.id} className="relative shrink-0">
            <button
              onClick={() => { setActiveTabId(tab.id); setQuestionIndex(0); }}
              className={cn(
                "text-xs px-3 py-1.5 rounded-lg font-medium transition-all whitespace-nowrap",
                activeTabId === tab.id
                  ? "bg-brand-500 text-white"
                  : "bg-background border border-border text-muted-foreground hover:text-foreground hover:border-brand-300"
              )}
            >
              {tab.label}
              {tab.questions.length > 0 && (
                <span
                  className={cn(
                    "ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-semibold",
                    activeTabId === tab.id
                      ? "bg-white/20 text-white"
                      : "bg-brand-100 text-brand-700"
                  )}
                >
                  {tab.questions.length}
                </span>
              )}
            </button>
            {tab.isCustom && activeTabId === tab.id && (
              <button
                onClick={() => removeCustomTab(tab.id)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center hover:bg-red-600 transition-all"
                title="Remove tab"
              >
                ×
              </button>
            )}
          </div>
        ))}

        {/* Add custom tab */}
        {addingTab ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <input
              autoFocus
              value={newTabName}
              onChange={(e) => setNewTabName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addCustomTab();
                if (e.key === "Escape") setAddingTab(false);
              }}
              placeholder="e.g. Midterm Review"
              className="text-xs border border-brand-400 rounded-lg px-2 h-7 w-36 focus:outline-none focus:ring-1 focus:ring-brand-400 bg-background"
            />
            <button
              onClick={addCustomTab}
              className="text-xs text-brand-600 font-semibold hover:text-brand-700"
            >
              Add
            </button>
            <button
              onClick={() => setAddingTab(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAddingTab(true)}
            className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-dashed border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600 transition-all whitespace-nowrap"
          >
            + Add tab
          </button>
        )}
      </div>

      {/* Main content */}
      <ScrollArea className="flex-1 px-6 py-6">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Upload section */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">
              {activeTab.label} — Study Material
            </h2>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-border rounded-xl px-6 py-8 text-center cursor-pointer hover:border-brand-400 hover:bg-brand-50/40 transition-all"
            >
              <div className="w-10 h-10 rounded-xl bg-brand-50 border border-brand-200 flex items-center justify-center mx-auto mb-3">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="w-5 h-5 text-brand-500"
                >
                  <path
                    d="M12 2v10m0 0l-3-3m3 3l3-3M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <p className="text-sm font-medium text-foreground">
                Click to upload files
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                .txt, .md, .pdf, .docx, or .pptx — upload multiple files for this week
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.pdf,.docx,.pptx"
              className="hidden"
              onChange={handleFileUpload}
            />

            {activeTab.files.length > 0 && (
              <div className="space-y-1.5">
                {activeTab.files.map((f) => (
                  <div
                    key={f.name}
                    className="flex items-center gap-2 text-xs bg-muted/40 border border-border rounded-lg px-3 py-2"
                  >
                    <span className="text-base">📄</span>
                    <span className="flex-1 truncate text-foreground font-medium">
                      {f.name}
                    </span>
                    <button
                      onClick={() => removeFile(f.name)}
                      className="text-muted-foreground hover:text-red-500 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Generate + Export */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="bg-brand-500 hover:bg-brand-600 text-white"
              onClick={handleGenerate}
              disabled={activeTab.loading}
            >
              {activeTab.loading
                ? "Generating…"
                : `Generate question bank for ${activeTab.label}`}
            </Button>
            {activeTab.questions.length > 0 && (
              <Button
                variant="outline"
                onClick={() =>
                  exportQuestions(activeTab.questions, activeTab.label)
                }
              >
                Export {activeTab.questions.length} questions (.txt)
              </Button>
            )}
          </div>

          {activeTab.error && (
            <p className="text-xs text-red-500">{activeTab.error}</p>
          )}

          {/* Questions — slideshow */}
          {activeTab.questions.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  Question Bank
                </h3>
                <span className="text-xs bg-brand-100 text-brand-700 font-semibold px-2 py-0.5 rounded-full">
                  {activeTab.questions.length} questions
                </span>
              </div>

              <QuestionCard
                key={activeTab.questions[questionIndex].id}
                question={activeTab.questions[questionIndex]}
                index={questionIndex}
              />

              {/* Prev / Next */}
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => setQuestionIndex((i) => Math.max(0, i - 1))}
                  disabled={questionIndex === 0}
                  className="text-xs px-4 py-2 rounded-lg border border-border text-muted-foreground hover:border-brand-400 hover:text-brand-600 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ← Previous
                </button>
                <span className="text-xs text-muted-foreground">
                  {questionIndex + 1} / {activeTab.questions.length}
                </span>
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
        </div>
      </ScrollArea>
    </div>
  );
}
