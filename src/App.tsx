import React, { useState, useRef, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import TeacherDashboard from "./TeacherDashboard";
import { extractText } from "./lib/parseFile";

// ─── Types ────────────────────────────────────────────────────────────────────

type Role = "user" | "assistant";

interface TextMessage {
  id: string;
  role: Role;
  type: "text";
  content: string;
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

type Message = TextMessage | MCQMessage | SATAMessage;

interface ConversationTurn {
  role: Role;
  content: string;
}

interface UploadedDoc {
  name: string;
  content: string;
  isPdf?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: "MCQ quiz", prompt: "Give me a hard MCQ clinical nursing question" },
  { label: "SATA quiz", prompt: "Give me a SATA nursing question" },
  { label: "Explain topic", prompt: "Explain a core nursing concept for NCLEX" },
  { label: "Case scenario", prompt: "Give me a clinical nursing case scenario" },
];

function buildSystemPrompt(doc: UploadedDoc | null, customInstructions?: string): string {
  const docContent = doc?.content ? doc.content.slice(0, 12000) : "";
  const docContext = doc
    ? `\n\nThe student has uploaded study material titled "${doc.name}". Use this as the PRIMARY source when generating questions and explanations — pull directly from this content when possible:\n\n---\n${docContent}\n---\n`
    : "";
  const customContext = customInstructions?.trim()
    ? `\n\n━━━ CUSTOM INSTRUCTIONS FROM STUDENT ━━━\n${customInstructions.trim()}\nAlways follow the above instructions for every response.\n`
    : "";

  return `You are NurseTutor, a rigorous and expert nursing tutor helping students prepare for NCLEX and clinical practice. You write challenging, clinically-grounded questions that mirror real patient care situations.${docContext}${customContext}

QUIZ PHILOSOPHY:
- Questions MUST be clinical and scenario-based — always describe a real patient (age, chief complaint, relevant vitals/labs/history). Never ask pure recall questions like "What is the normal range of X?"
- Distractors must be sophisticated and plausible. A good distractor is something a reasonable but less experienced nurse might actually choose. Avoid obviously wrong answers.
- Target application and analysis level (Bloom's). The student should have to reason, not just remember.
- When study material is uploaded, derive questions directly from that content.
- Do NOT refer to or suggest selecting a topic — there is no topic selector in the interface. Just generate questions directly.
- Do NOT use **bold** or any markdown formatting inside question text, options, or explanations — plain text only.

You support two question formats:

━━━ MCQ FORMAT ━━━
When asked for a multiple-choice question, respond EXACTLY in this format (no preamble, no extra text):

MCQ
Question: [Rich clinical scenario with patient age, presenting complaint, relevant vitals/labs/context. End with a focused nursing question.]
A: [Option — plausible]
B: [Option — plausible]
C: [Option — plausible]
D: [Option — plausible, correct or distractor]
ANSWER: [Single letter: A, B, C, or D]
EXPLANATION: [2–3 sentences: why the correct answer is right, why each distractor is wrong or less appropriate, and the clinical rationale.]

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
EXPLANATION: [2–3 sentences: why each correct answer applies, why the distractors do not fit the clinical picture.]

━━━ MULTIPLE QUESTIONS ━━━
When the student asks for more than one question (e.g. "give me 5 MCQs", "3 SATA questions"), output each question in the correct format above, separated by a line containing only three dashes:

---

Output ONLY the questions separated by ---. No preamble, no numbering, no summary text.

━━━ TUTOR MODE ━━━
For all non-quiz requests: explain clearly, use bullet points for lists, and keep answers clinically relevant and NCLEX-focused. Be encouraging, concise, and precise.`;
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function callGroq(
  history: ConversationTurn[],
  doc: UploadedDoc | null,
  customInstructions?: string
): Promise<string> {
  const apiKey = import.meta.env.VITE_GROQ_API_KEY as string;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      max_tokens: 4096,
      messages: [
        { role: "system", content: buildSystemPrompt(doc, customInstructions) },
        ...history.slice(-2).map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2000) })),
      ],
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content as string;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseMCQ(
  raw: string
): Omit<MCQMessage, "id" | "role" | "type" | "chosen"> | null {
  if (!raw.trimStart().startsWith("MCQ")) return null;
  try {
    const q = raw.match(/Question:\s*([\s\S]+?)(?=\nA:)/)?.[1]?.trim();
    const a = raw.match(/^A:\s*(.+)/m)?.[1]?.trim();
    const b = raw.match(/^B:\s*(.+)/m)?.[1]?.trim();
    const c = raw.match(/^C:\s*(.+)/m)?.[1]?.trim();
    const d = raw.match(/^D:\s*(.+)/m)?.[1]?.trim();
    const ans = raw.match(/ANSWER:\s*([ABCD])/)?.[1]?.trim() as
      | "A"
      | "B"
      | "C"
      | "D"
      | undefined;
    const exp = raw.match(/EXPLANATION:\s*([\s\S]+)/)?.[1]?.trim();
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
  if (!raw.trimStart().startsWith("SATA")) return null;
  try {
    const q = raw.match(/Question:\s*([\s\S]+?)(?=\nA:)/)?.[1]?.trim();
    const a = raw.match(/^A:\s*(.+)/m)?.[1]?.trim();
    const b = raw.match(/^B:\s*(.+)/m)?.[1]?.trim();
    const c = raw.match(/^C:\s*(.+)/m)?.[1]?.trim();
    const d = raw.match(/^D:\s*(.+)/m)?.[1]?.trim();
    const e = raw.match(/^E:\s*(.+)/m)?.[1]?.trim();
    const ansRaw = raw.match(/ANSWERS:\s*([A-E,\s]+)/)?.[1]?.trim();
    const exp = raw.match(/EXPLANATION:\s*([\s\S]+)/)?.[1]?.trim();
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

// ─── Sub-components ───────────────────────────────────────────────────────────

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
          className="text-xs border-violet-400 text-violet-600 dark:text-violet-400"
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
                  "border-violet-500 bg-violet-50 dark:bg-violet-950/30",
                !submitted &&
                  !isSelected &&
                  "border-border bg-card hover:border-violet-300 hover:bg-violet-50/50 dark:hover:bg-violet-950/10",
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
                    "border-violet-500 bg-violet-500 text-white",
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
          className="bg-violet-600 hover:bg-violet-700 text-white text-xs"
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

function LandingScreen({ onSelect }: { onSelect: (role: "student" | "teacher") => void }) {
  return (
    <div className="flex flex-col h-screen bg-background font-sans items-center justify-center px-6">
      <div className="flex flex-col items-center gap-2 mb-10">
        <div className="w-16 h-16 rounded-full overflow-hidden mb-2">
          <img src="/nurse-avatar.png" alt="NurseTutor" className="w-full h-full object-cover" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">NurseTutor</h1>
        <p className="text-sm text-muted-foreground">NCLEX-focused clinical learning platform</p>
      </div>

      <p className="text-sm font-medium text-foreground mb-5">How are you using NurseTutor today?</p>

      <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
        {/* Student card */}
        <button
          onClick={() => onSelect("student")}
          className="flex-1 group rounded-2xl border-2 border-border bg-card hover:border-brand-400 hover:bg-brand-50/40 transition-all p-6 text-left space-y-3"
        >
          <div className="w-11 h-11 rounded-xl bg-brand-100 flex items-center justify-center text-2xl">
            🎓
          </div>
          <div>
            <p className="font-semibold text-sm text-foreground group-hover:text-brand-700">I'm a Student</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              Practice with MCQ &amp; SATA questions, upload your notes, and get instant explanations.
            </p>
          </div>
          <span className="inline-block text-xs font-semibold text-brand-600 group-hover:translate-x-0.5 transition-transform">
            Start studying →
          </span>
        </button>

        {/* Teacher card */}
        <button
          onClick={() => onSelect("teacher")}
          className="flex-1 group rounded-2xl border-2 border-border bg-card hover:border-brand-400 hover:bg-brand-50/40 transition-all p-6 text-left space-y-3"
        >
          <div className="w-11 h-11 rounded-xl bg-brand-100 flex items-center justify-center text-2xl">
            📋
          </div>
          <div>
            <p className="font-semibold text-sm text-foreground group-hover:text-brand-700">I'm a Teacher</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              Build weekly question banks from your course material and export them for exams.
            </p>
          </div>
          <span className="inline-block text-xs font-semibold text-brand-600 group-hover:translate-x-0.5 transition-transform">
            Open dashboard →
          </span>
        </button>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<"landing" | "student" | "teacher">("landing");

  if (view === "landing") return <LandingScreen onSelect={setView} />;
  if (view === "teacher") return <TeacherDashboard onBack={() => setView("landing")} />;
  return <StudentTutor onBack={() => setView("landing")} />;
}

// ─── Student Tutor ────────────────────────────────────────────────────────────

function StudentTutor({ onBack }: { onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [uploadedDoc, setUploadedDoc] = useState<UploadedDoc | null>(null);
  const [history, setHistory] = useState<ConversationTurn[]>([]);
  const [customInstructions, setCustomInstructions] = useState<string>(
    () => localStorage.getItem("nursetutor-instructions") ?? ""
  );
  const [showInstructions, setShowInstructions] = useState(false);
  const [draftInstructions, setDraftInstructions] = useState(customInstructions);
  const [questionIndex, setQuestionIndex] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const questionMessages = messages.filter(
    (m): m is MCQMessage | SATAMessage => m.role === "assistant" && (m.type === "mcq" || m.type === "sata")
  );

  // Go to the first question of the new batch when questions arrive
  useEffect(() => {
    if (questionMessages.length > 0) {
      setQuestionIndex(0);
    }
  }, [questionMessages.length]);

  useEffect(() => {
    const welcome: TextMessage = {
      id: uid(),
      role: "assistant",
      type: "text",
      content:
        "Welcome! I'm NurseTutor — your clinical study companion.\n\nI write hard, scenario-based questions (MCQ and SATA) that push you to think like a nurse, not just memorize facts.\n\n**Upload your notes or slides** and I'll generate questions straight from your material. Otherwise, use the quick actions below or just ask me anything!",
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
      };
      setMessages((prev) => [...prev, userMsg]);

      const newHistory: ConversationTurn[] = [
        ...history,
        { role: "user", content: text },
      ];
      setHistory(newHistory);
      setLoading(true);

      try {
        const raw = await callGroq(newHistory, uploadedDoc, customInstructions);
        setHistory((h) => [...h, { role: "assistant", content: raw }]);

        const batch = parseBatch(raw);
        if (batch.length > 0) {
          setMessages((prev) => [...prev, ...batch]);
        } else {
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "assistant", type: "text", content: raw },
          ]);
        }
      } catch (err) {
        console.error("NurseTutor error:", err);
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: "assistant",
            type: "text",
            content: err instanceof Error && err.message.includes("429")
          ? "You're sending requests too quickly — please wait a few seconds and try again."
          : `Sorry, I had trouble connecting. Please try again.`,
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [loading, history, uploadedDoc, customInstructions]
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

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";

      const isPdf = file.name.toLowerCase().endsWith(".pdf");

      if (isPdf) {
        setUploadedDoc({ name: file.name, content: "", isPdf: true });
        setHistory([]);
        setMessages((prev) => [...prev, { id: uid(), role: "assistant", type: "text",
          content: `Got it — I've loaded ${file.name}. I'll now base my questions and explanations on your material. Want me to quiz you on it, explain a concept, or work through a case?` }]);
        return;
      }

      try {
        const content = await extractText(file);
        setUploadedDoc({ name: file.name, content });
        setHistory([]);
        setMessages((prev) => [...prev, { id: uid(), role: "assistant", type: "text",
          content: `Got it — I've loaded ${file.name}. I'll now base my questions and explanations on your material. Want me to quiz you on it, explain a concept, or work through a case?` }]);
      } catch {
        setMessages((prev) => [...prev, { id: uid(), role: "assistant", type: "text",
          content: `Sorry, I couldn't read that file. Please try a .txt, .md, .docx, or .pptx file.` }]);
      }
    },
    []
  );

  return (
    <div className="flex flex-col h-screen bg-background font-sans max-w-3xl mx-auto">
      {/* ── Header ── */}
      <div className="shrink-0 border-b border-border px-5 py-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full overflow-hidden shrink-0">
          <img src="/nurse-avatar.png" alt="NurseTutor" className="w-full h-full object-cover" />
        </div>
        <div>
          <h1 className="text-sm font-semibold tracking-tight">NurseTutor</h1>
          <p className="text-xs text-muted-foreground">NCLEX-focused clinical tutor</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ScoreBadge correct={score.correct} total={score.total} />
          <button
            onClick={onBack}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 h-8 transition-all hover:border-brand-400"
            title="Back to home"
          >
            ← Home
          </button>
          {uploadedDoc && (
            <Badge
              variant="secondary"
              className="text-xs max-w-[140px] truncate cursor-pointer"
              onClick={() => { setUploadedDoc(null); setHistory([]); }}
              title="Click to remove document"
            >
              📄 {uploadedDoc.name}
            </Badge>
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
      <ScrollArea className="flex-1 px-5 py-4">
        <div className="space-y-5 pb-2">
          {messages.filter((m) => m.type === "text").map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex gap-2.5",
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
              <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-muted/60 border border-border rounded-tl-sm max-w-[82%]">
                {msg.type === "text" && formatText(msg.content)}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex gap-2.5">
              <div className="shrink-0 w-7 h-7 rounded-full overflow-hidden">
                <img src="/nurse-avatar.png" alt="NurseTutor" className="w-full h-full object-cover" />
              </div>
              <div className="bg-muted/60 border border-border rounded-2xl rounded-tl-sm px-4 py-3">
                <LoadingDots />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* ── Question navigator ── */}
      {questionMessages.length > 0 && (
        <div className="shrink-0 border-t border-border px-5 pt-4 pb-2 space-y-3">
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
      <div className="shrink-0 px-5 pb-5 pt-2 flex gap-2 items-center">
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.csv,.rtf,.pdf,.docx,.pptx"
          className="hidden"
          onChange={handleFileUpload}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Upload study notes (.txt, .md, .pdf)"
          className={cn(
            "shrink-0 w-9 h-9 rounded-lg border flex items-center justify-center transition-all",
            uploadedDoc
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

        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder={
            uploadedDoc
              ? `Ask about ${uploadedDoc.name}…`
              : "Ask a question or request a quiz…"
          }
          disabled={loading}
          className="flex-1 rounded-lg text-sm"
        />
        <Button
          onClick={() => send(input)}
          disabled={loading || !input.trim()}
          size="sm"
          className="bg-brand-600 hover:bg-brand-700 text-white rounded-lg px-4"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
