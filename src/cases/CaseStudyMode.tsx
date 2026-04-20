import React, { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { CaseTree, CaseNode, NodeConsequence } from "../types/case";
import { loadMediaDataUrl } from "../types/case";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 9);
}

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

// ─── Regex ────────────────────────────────────────────────────────────────────

const BRANCH_REGEX = /\[BRANCH:\s*([\w-]+|null)\s*(?:confidence=(\d+))?\]/;
const MEDIA_REGEX = /\[MEDIA:\s*([\w-]+)\s*\]/;

// ─── Local storage helpers (avoiding circular import from App) ────────────────

function loadCaseSharedPool(): { source: string; label: string; text: string }[] {
  try {
    return JSON.parse(localStorage.getItem("nursetutor-case-shared-pool") ?? "[]");
  } catch {
    return [];
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type CasePhase = "lobby" | "simulation";

interface SimMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  isMedia?: false;
}

interface MediaSimMessage {
  id: string;
  role: "assistant";
  isMedia: true;
  caption: string;
  mediaType: "image" | "audio";
  dataUrl: string;
  name: string;
}

type AnySimMessage = SimMessage | MediaSimMessage;

// ─── System prompt builder ────────────────────────────────────────────────────

function buildCaseSystemPrompt(
  tree: CaseTree,
  currentNodeId: string,
  turnsAtCurrentNode: number
): string {
  const currentNode = tree.nodes.find((n) => n.id === currentNodeId);
  const casePool = loadCaseSharedPool();

  // ── Patient profile block ──────────────────────────────────────────────────
  const p = tree.patientProfile;
  let patientBlock = "";
  if (p) {
    const vitals = p.vitals;
    const hasVitals = Object.values(vitals).some(v => v.trim() !== "");
    const lines: string[] = [];

    if (p.name || p.age || p.gender)
      lines.push(`Patient: ${[p.name, p.age ? `${p.age}yo` : "", p.gender].filter(Boolean).join(", ")}`);
    if (p.room)          lines.push(`Room: ${p.room}`);
    if (p.codeStatus)    lines.push(`Code Status: ${p.codeStatus}`);
    if (p.chiefComplaint) lines.push(`Chief Complaint: ${p.chiefComplaint}`);
    if (p.primaryDiagnosis) lines.push(`Diagnosis: ${p.primaryDiagnosis}`);
    if (p.pastMedicalHistory) lines.push(`PMHx: ${p.pastMedicalHistory}`);
    if (p.medications)   lines.push(`Medications: ${p.medications}`);
    if (p.allergies)     lines.push(`Allergies: ${p.allergies}`);
    if (hasVitals) {
      const vParts = [
        vitals.bp  && `BP ${vitals.bp}`,
        vitals.hr  && `HR ${vitals.hr}`,
        vitals.rr  && `RR ${vitals.rr}`,
        vitals.spo2 && `SpO₂ ${vitals.spo2}`,
        vitals.temp && `Temp ${vitals.temp}`,
        vitals.pain && `Pain ${vitals.pain}`,
        vitals.gcs  && `GCS ${vitals.gcs}`,
      ].filter(Boolean);
      if (vParts.length > 0) lines.push(`Vitals: ${vParts.join(" | ")}`);
    }
    if (p.imagingNotes)  lines.push(`Imaging: ${p.imagingNotes}`);
    if (p.labNotes)      lines.push(`Labs: ${p.labNotes}`);
    if (p.nursingNotes)  lines.push(`Nursing notes: ${p.nursingNotes}`);

    if (lines.length > 0) {
      patientBlock = `\n\n━━━ PATIENT PROFILE ━━━\n${lines.join("\n")}`;
    }
  }

  let prompt = `You are running a clinical nursing simulation. You play the role of the clinical environment — the patient, the monitor, the clinical context. The student is the nurse.

CASE: ${tree.title}${tree.diagnosis ? `\nDIAGNOSIS CONTEXT: ${tree.diagnosis}` : ""}${tree.description ? `\nSCENARIO: ${tree.description}` : ""}${patientBlock}`;

  if (casePool.length > 0) {
    prompt +=
      `\n\n── CASE KNOWLEDGE BASE ──\n` +
      casePool
        .map((c) => `[${c.source} — ${c.label}]\n${c.text}`)
        .join("\n\n");
  }

  prompt += `\n\n━━━ SIMULATION RULES ━━━
- Respond in character as the clinical environment. Be realistic, specific, clinical.
- Use the patient profile above to give consistent, accurate responses throughout the simulation.
- Never generate MCQ or SATA questions. Never break character to give educational summaries.
- Keep responses concise (2-4 sentences) unless the student asks for more detail.
- When the student completes the case or you reach a natural end, write CASE SUMMARY on its own line.
- CRITICAL — Do NOT guide, hint, or suggest actions to the student. Never say "you might want to...", "have you considered...", "it would be a good idea to...", or anything similar. The student must think for themselves.
- You are REACTIVE only: describe findings when the student performs an assessment, answer questions when asked, present deterioration when it occurs. Never volunteer what the student should do next.
- Present the clinical picture honestly and in real time. The student determines their own priorities.`;

  if (currentNode) {
    if (currentNode.situation) {
      prompt += `\n\n━━━ CURRENT SITUATION ━━━\n${currentNode.situation}`;
    }
    if (currentNode.completionCriteria) {
      prompt += `\n\nCOMPLETION CRITERIA (internal only — use ONLY to recognise when the student has done the right thing, never to hint at or steer them toward it): ${currentNode.completionCriteria}`;
    }
    if (currentNode.completionNarration) {
      prompt += `\nWhen the student meets the criteria, weave this into your narration: "${currentNode.completionNarration}"`;
    }

    const activeConsequences = (currentNode.consequences ?? []).filter(
      (c: NodeConsequence) => turnsAtCurrentNode >= c.afterTurns
    );
    if (activeConsequences.length > 0) {
      prompt +=
        `\n\nACTIVE DETERIORATION (narrate naturally — do not read verbatim):\n` +
        activeConsequences
          .map((c: NodeConsequence) => `- [${c.severity.toUpperCase()}] ${c.description}`)
          .join("\n");
    }

    const branches = tree.branches.filter((b) => b.fromNodeId === currentNodeId);
    if (branches.length > 0) {
      prompt +=
        `\n\n━━━ BRANCH EVALUATION ━━━\nStudent is at: "${currentNode.label}"\nAvailable branches:\n` +
        branches.map((b) => `Branch ID "${b.id}": "${b.triggerPhrase}"`).join("\n") +
        `\n\nAfter your narrative response, append ONE tag on its own line:\n[BRANCH: <branch_id> confidence=<0-100>]\n[BRANCH: null]\nDo NOT mention branches in your narrative.`;

      // Pending auto-triggers — tell the AI so it can foreshadow urgency
      const pendingIdle = branches.filter(
        (b) => b.autoTriggerAfterTurns !== undefined &&
               turnsAtCurrentNode + 1 < b.autoTriggerAfterTurns
      );
      if (pendingIdle.length > 0) {
        prompt +=
          `\n\nPENDING IDLE-TRIGGERED EVENTS (if student doesn't act soon, these will fire automatically — increase urgency in your narration as they approach):\n` +
          pendingIdle
            .map((b) => {
              const turnsLeft = (b.autoTriggerAfterTurns ?? 0) - (turnsAtCurrentNode + 1);
              return `- "${b.label || b.triggerPhrase}" will auto-fire in ${turnsLeft} more turn${turnsLeft !== 1 ? "s" : ""}`;
            })
            .join("\n");
      }
    }

    const availableMedia = tree.mediaFiles ?? [];
    if (availableMedia.length > 0) {
      prompt +=
        `\n\nAVAILABLE MEDIA:\n` +
        availableMedia
          .map(
            (m) =>
              `- keyword "${m.triggerKeyword}" (${m.type}) — mode: ${m.triggerMode}${m.description ? ` — "${m.description}"` : ""}`
          )
          .join("\n") +
        `\nWhen displaying media, append on its own line: [MEDIA: keyword]\n"student-asks" = only on request. "ai-auto" = proactively when relevant.`;
    }
  }

  return prompt;
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function callSimulation(
  history: { role: "user" | "assistant"; content: string }[],
  tree: CaseTree,
  currentNodeId: string,
  turnsAtCurrentNode: number
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content: buildCaseSystemPrompt(tree, currentNodeId, turnsAtCurrentNode),
        },
        ...history.map((t) => ({ role: t.role, content: t.content })),
      ],
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content as string;
}

// ─── Dark toggle ──────────────────────────────────────────────────────────────

function DarkToggle({ isDark, onToggle }: { isDark: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="w-9 h-9 rounded-full flex items-center justify-center border border-border bg-background/80 backdrop-blur hover:bg-muted transition-colors shadow-sm"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-4 h-4 text-amber-400"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM18.894 6.166a.75.75 0 00-1.06-1.06l-1.591 1.59a.75.75 0 101.06 1.061l1.591-1.59zM21.75 12a.75.75 0 01-.75.75h-2.25a.75.75 0 010-1.5H21a.75.75 0 01.75.75zM17.834 18.894a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 10-1.061 1.06l1.59 1.591zM12 18a.75.75 0 01.75.75V21a.75.75 0 01-1.5 0v-2.25A.75.75 0 0112 18zM7.166 17.834a.75.75 0 00-1.06 1.06l1.59 1.591a.75.75 0 001.061-1.06l-1.59-1.591zM6 12a.75.75 0 01-.75.75H3a.75.75 0 010-1.5h2.25A.75.75 0 016 12zM6.166 6.166a.75.75 0 011.06-1.06l1.591 1.59a.75.75 0 01-1.06 1.061L6.166 6.166z" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-4 h-4 text-slate-600"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M9.528 1.718a.75.75 0 01.162.819A8.97 8.97 0 009 6a9 9 0 009 9 8.97 8.97 0 003.463-.69.75.75 0 01.981.98 10.503 10.503 0 01-9.694 6.46c-5.799 0-10.5-4.701-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 01.818.162z"
            clipRule="evenodd"
          />
        </svg>
      )}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CaseStudyMode({
  onBack,
  isDark,
  onToggleDark,
  previewCase,
}: {
  onBack: () => void;
  isDark: boolean;
  onToggleDark: () => void;
  /** When provided, preview this case instead of the published one (teacher mode). */
  previewCase?: CaseTree | null;
}) {
  // ── Published case (computed once on mount) ───────────────────────────────

  const [publishedCase] = useState<CaseTree | null>(() => {
    if (previewCase) return previewCase;
    try {
      const lib: CaseTree[] = JSON.parse(
        localStorage.getItem("nursetutor-case-library") ?? "[]"
      );
      return lib.find((c) => c.publishedToStudents) ?? null;
    } catch {
      return null;
    }
  });

  const isPreview = !!previewCase;

  // ── Core state ────────────────────────────────────────────────────────────

  const [phase, setPhase] = useState<CasePhase>("lobby");
  const [messages, setMessages] = useState<AnySimMessage[]>([]);
  const [history, setHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [activeCaseTree, setActiveCaseTree] = useState<CaseTree | null>(null);
  const [activeCaseNodeId, setActiveCaseNodeId] = useState<string | null>(null);
  const [turnsAtCurrentNode, setTurnsAtCurrentNode] = useState(0);
  const [totalTurns, setTotalTurns] = useState(0);
  const [loading, setLoading] = useState(false);
  const [situationOpen, setSituationOpen] = useState(true);
  const [input, setInput] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Auto-scroll ───────────────────────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const currentNode: CaseNode | undefined = activeCaseTree?.nodes.find(
    (n) => n.id === activeCaseNodeId
  );

  // ── beginSimulation ───────────────────────────────────────────────────────

  async function beginSimulation() {
    if (!publishedCase) return;
    const root = publishedCase.nodes.find((n) => n.isRoot);
    if (!root) return;

    setActiveCaseTree(publishedCase);
    setActiveCaseNodeId(root.id);
    setTurnsAtCurrentNode(0);
    setTotalTurns(0);
    setMessages([]);

    const initHistory: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: "Begin the simulation." },
    ];
    setHistory(initHistory);
    setPhase("simulation");
    setSituationOpen(true);
    setLoading(true);

    try {
      const raw = await callSimulation(initHistory, publishedCase, root.id, 0);
      const branchMatch = BRANCH_REGEX.exec(raw);
      const mediaMatch = MEDIA_REGEX.exec(raw);
      const content = raw.replace(BRANCH_REGEX, "").replace(MEDIA_REGEX, "").trim();

      setHistory([...initHistory, { role: "assistant", content }]);
      setMessages([{ id: uid(), role: "assistant", content }]);

      // Handle branch advance
      if (branchMatch && branchMatch[1] !== "null") {
        const conf = parseInt(branchMatch[2] ?? "0", 10);
        if (conf >= 60) {
          const branch = publishedCase.branches.find(
            (b) => b.id === branchMatch[1] && b.fromNodeId === root.id
          );
          if (branch) {
            setActiveCaseNodeId(branch.toNodeId);
            setTurnsAtCurrentNode(0);
          }
        }
      }

      // Handle media
      if (mediaMatch) {
        const keyword = mediaMatch[1];
        const mf = publishedCase.mediaFiles?.find((m) => m.triggerKeyword === keyword);
        if (mf) {
          const dataUrl = loadMediaDataUrl(publishedCase.id, mf.id);
          if (dataUrl) {
            setMessages((prev) => [
              ...prev,
              {
                id: uid(),
                role: "assistant",
                isMedia: true,
                caption: mf.description ?? mf.name,
                mediaType: mf.type,
                dataUrl,
                name: mf.name,
              } as MediaSimMessage,
            ]);
          }
        }
      }
    } catch (err) {
      setMessages([
        {
          id: uid(),
          role: "assistant",
          content: `Sorry, couldn't start the simulation. ${err instanceof Error ? err.message : ""}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // ── send ──────────────────────────────────────────────────────────────────

  async function send() {
    if (!input.trim() || loading || !activeCaseTree || !activeCaseNodeId) return;
    const text = input.trim();
    setInput("");

    const userMsg: SimMessage = { id: uid(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);

    const newHistory = [...history, { role: "user" as const, content: text }];
    setHistory(newHistory);
    setLoading(true);

    try {
      const raw = await callSimulation(
        newHistory,
        activeCaseTree,
        activeCaseNodeId,
        turnsAtCurrentNode
      );
      const branchMatch = BRANCH_REGEX.exec(raw);
      const mediaMatch = MEDIA_REGEX.exec(raw);
      const content = raw.replace(BRANCH_REGEX, "").replace(MEDIA_REGEX, "").trim();

      setHistory((h) => [...h, { role: "assistant", content }]);
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content }]);

      // Branch tracking
      let branchAdvanced = false;
      if (branchMatch && branchMatch[1] !== "null") {
        const conf = parseInt(branchMatch[2] ?? "0", 10);
        if (conf >= 60) {
          const branch = activeCaseTree.branches.find(
            (b) => b.id === branchMatch[1] && b.fromNodeId === activeCaseNodeId
          );
          if (branch) {
            setActiveCaseNodeId(branch.toNodeId);
            setTurnsAtCurrentNode(0);
            setSituationOpen(true);
            branchAdvanced = true;
          }
        }
      }

      // Auto-branch on idle: if student didn't trigger a branch, check whether
      // any outgoing branch from the current node has an autoTriggerAfterTurns
      // threshold the student has now hit. First matching branch wins.
      if (!branchAdvanced && activeCaseNodeId) {
        // turnsAtCurrentNode is still the pre-increment value; after this turn,
        // the student will have spent (turnsAtCurrentNode + 1) turns here.
        const turnsAfterThis = turnsAtCurrentNode + 1;
        const idleBranch = activeCaseTree.branches.find(
          (b) =>
            b.fromNodeId === activeCaseNodeId &&
            b.autoTriggerAfterTurns !== undefined &&
            turnsAfterThis >= b.autoTriggerAfterTurns
        );
        if (idleBranch) {
          setActiveCaseNodeId(idleBranch.toNodeId);
          setTurnsAtCurrentNode(0);
          setSituationOpen(true);
          branchAdvanced = true;
        }
      }

      // Consequence-linked routing: if a deterioration event has a linkedNodeId
      // and its turn threshold has been reached, hard-route the student there.
      // Runs after normal branch + idle-trigger checks so those take priority.
      if (!branchAdvanced && activeCaseNodeId) {
        const turnsAfterThis = turnsAtCurrentNode + 1;
        const currentNode = activeCaseTree.nodes.find(n => n.id === activeCaseNodeId);
        const firedConsequence = (currentNode?.consequences ?? [])
          .filter(c => c.linkedNodeId && turnsAfterThis >= c.afterTurns)
          .sort((a, b) => a.afterTurns - b.afterTurns)[0]; // earliest-firing wins

        if (firedConsequence?.linkedNodeId) {
          setActiveCaseNodeId(firedConsequence.linkedNodeId);
          setTurnsAtCurrentNode(0);
          setSituationOpen(true);
          branchAdvanced = true;
        }
      }

      if (!branchAdvanced) {
        setTurnsAtCurrentNode((t) => t + 1);
      }
      setTotalTurns((t) => t + 1);

      // Media
      if (mediaMatch) {
        const keyword = mediaMatch[1];
        const mf = activeCaseTree.mediaFiles?.find((m) => m.triggerKeyword === keyword);
        if (mf) {
          const dataUrl = loadMediaDataUrl(activeCaseTree.id, mf.id);
          if (dataUrl) {
            setMessages((prev) => [
              ...prev,
              {
                id: uid(),
                role: "assistant",
                isMedia: true as const,
                caption: mf.description ?? mf.name,
                mediaType: mf.type,
                dataUrl,
                name: mf.name,
              } as MediaSimMessage,
            ]);
          }
        }
      }

      // Case end detection — no-op for now, debrief TBD
      if (content.includes("CASE SUMMARY")) {
        // placeholder for post-case debrief
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // ── endCase ───────────────────────────────────────────────────────────────

  function endCase() {
    setPhase("lobby");
    setActiveCaseTree(null);
    setActiveCaseNodeId(null);
    setTurnsAtCurrentNode(0);
    setTotalTurns(0);
    setMessages([]);
    setHistory([]);
    setConfirmEnd(false);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  // ── Lobby ────────────────────────────────────────────────────────────────

  if (phase === "lobby") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 via-white to-white dark:from-slate-900 dark:via-slate-800 dark:to-slate-900 font-sans flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-card/80 backdrop-blur">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Back
          </button>
          <span className="text-sm font-semibold text-foreground tracking-tight">Case Study</span>
          <DarkToggle isDark={isDark} onToggle={onToggleDark} />
        </div>

        {/* Body */}
        <div className="flex-1 flex items-center justify-center px-6 py-12">
          {!publishedCase ? (
            <div className="text-center max-w-sm">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-100 dark:bg-red-950/40 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-8 h-8 text-red-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 12h6M12 9v6m-7 4h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-foreground mb-2">No case available</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                No case study is currently available. Your instructor hasn't published one yet.
              </p>
            </div>
          ) : (
            <div className="w-full max-w-lg">
              <div className="rounded-2xl border border-border bg-card shadow-lg overflow-hidden">
                {/* Card header */}
                <div className="bg-gradient-to-r from-red-500 to-red-600 px-6 py-5 flex items-center gap-4">
                  <div className="w-14 h-14 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="w-7 h-7 text-white"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2z" />
                      <path d="M9 12h6M12 9v6" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-white/70 text-xs font-medium uppercase tracking-widest mb-0.5">
                      Active Case
                    </p>
                    <h2 className="text-white text-lg font-bold leading-tight truncate">
                      {publishedCase.title}
                    </h2>
                  </div>
                </div>

                {/* Card body */}
                <div className="px-6 py-5 space-y-4">
                  {publishedCase.description && (
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {publishedCase.description}
                    </p>
                  )}

                  {/* Diagnosis badge */}
                  <div className="flex items-center gap-2">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="w-4 h-4 text-red-500 flex-shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                    </svg>
                    <span className="text-sm font-medium text-foreground">
                      {publishedCase.diagnosis}
                    </span>
                  </div>

                  {/* Stats row */}
                  <div className="flex items-center gap-4 pt-1">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="w-3.5 h-3.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 8v4l3 3" />
                      </svg>
                      {publishedCase.nodes.length} checkpoint
                      {publishedCase.nodes.length !== 1 ? "s" : ""}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="w-3.5 h-3.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                      {publishedCase.branches.length} path
                      {publishedCase.branches.length !== 1 ? "s" : ""}
                    </div>
                  </div>

                  {/* Patient profile card */}
                  {publishedCase.patientProfile && (() => {
                    const p = publishedCase.patientProfile;
                    const v = p.vitals;
                    const hasIdentity = p.name || p.age || p.gender || p.room;
                    const hasClinical = p.chiefComplaint || p.primaryDiagnosis || p.allergies;
                    const vitalEntries: [string, string][] = [
                      ["BP", v.bp],
                      ["HR", v.hr],
                      ["RR", v.rr],
                      ["SpO₂", v.spo2],
                      ["Temp", v.temp],
                      ["Pain", v.pain],
                    ].filter(([, val]) => val && val.trim() !== "") as [string, string][];

                    if (!hasIdentity && !hasClinical && vitalEntries.length === 0) return null;

                    return (
                      <div className="rounded-xl border border-border bg-muted/30 dark:bg-muted/20 overflow-hidden">
                        <div className="px-3.5 py-2 bg-muted/50 dark:bg-muted/30 border-b border-border flex items-center gap-1.5">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="w-3.5 h-3.5 text-muted-foreground"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
                            <circle cx="12" cy="7" r="4" />
                          </svg>
                          <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                            Patient Profile
                          </p>
                        </div>

                        <div className="px-3.5 py-3 space-y-2">
                          {/* Identity row */}
                          {hasIdentity && (
                            <div className="text-sm text-foreground font-medium leading-tight">
                              {[p.name, p.age && `${p.age}yo`, p.gender].filter(Boolean).join(", ")}
                              {p.room && (
                                <span className="ml-2 text-xs text-muted-foreground font-normal">
                                  Room {p.room}
                                </span>
                              )}
                              {p.codeStatus && (
                                <span className={cn(
                                  "ml-2 text-[10px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5",
                                  p.codeStatus.toLowerCase().includes("dnr") || p.codeStatus.toLowerCase().includes("comfort")
                                    ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                                    : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                                )}>
                                  {p.codeStatus}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Chief complaint */}
                          {p.chiefComplaint && (
                            <div className="flex gap-2 text-xs">
                              <span className="text-muted-foreground font-semibold shrink-0 w-14">CC</span>
                              <span className="text-foreground leading-snug">{p.chiefComplaint}</span>
                            </div>
                          )}

                          {/* Diagnosis */}
                          {p.primaryDiagnosis && (
                            <div className="flex gap-2 text-xs">
                              <span className="text-muted-foreground font-semibold shrink-0 w-14">Dx</span>
                              <span className="text-foreground leading-snug">{p.primaryDiagnosis}</span>
                            </div>
                          )}

                          {/* Allergies */}
                          {p.allergies && (
                            <div className="flex gap-2 text-xs">
                              <span className="text-red-600 dark:text-red-400 font-semibold shrink-0 w-14">⚠ Allergy</span>
                              <span className="text-foreground leading-snug">{p.allergies}</span>
                            </div>
                          )}

                          {/* Vitals grid */}
                          {vitalEntries.length > 0 && (
                            <div className="pt-1 mt-1 border-t border-border grid grid-cols-3 gap-x-3 gap-y-1.5">
                              {vitalEntries.map(([label, val]) => (
                                <div key={label} className="flex flex-col">
                                  <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider leading-none">
                                    {label}
                                  </span>
                                  <span className="text-xs text-foreground font-semibold tabular-nums leading-tight mt-0.5">
                                    {val}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Begin button */}
                  <button
                    onClick={beginSimulation}
                    className="w-full mt-2 bg-red-500 hover:bg-red-600 active:bg-red-700 text-white font-semibold text-sm py-3 px-4 rounded-xl transition-colors shadow-sm"
                  >
                    {isPreview ? "Start Preview" : "Begin Simulation"}
                  </button>

                  {/* Note */}
                  <p className="text-center text-xs text-muted-foreground leading-relaxed">
                    {isPreview
                      ? "Preview mode — test the case as a student would experience it."
                      : "Respond as you would clinically. The AI plays the clinical environment."}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Simulation ────────────────────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col bg-background font-sans overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-red-500 flex items-center justify-center flex-shrink-0">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-4 h-4 text-white"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 12h6M12 9v6m-7 4h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-foreground truncate max-w-[180px] sm:max-w-xs">
            {activeCaseTree?.title ?? "Case Study"}
          </span>
          {isPreview && (
            <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700 rounded px-1.5 py-0.5">
              Preview
            </span>
          )}
          {/* Turn counter */}
          <div className="hidden sm:flex items-center gap-1.5 border border-border rounded-lg px-2 h-6 bg-muted/40" title="Total turns in this simulation">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-3 h-3 text-muted-foreground"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            <span className="text-[11px] font-semibold text-foreground tabular-nums">
              Turn {totalTurns}
            </span>
            {turnsAtCurrentNode > 0 && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                · {turnsAtCurrentNode} here
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <DarkToggle isDark={isDark} onToggle={onToggleDark} />

          {confirmEnd ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground hidden sm:inline">End simulation?</span>
              <button
                onClick={() => setConfirmEnd(false)}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={endCase}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium transition-colors"
              >
                End Case
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmEnd(true)}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors font-medium"
            >
              End Case
            </button>
          )}
        </div>
      </div>

      {/* ── Situation panel ── */}
      {currentNode?.situation && (
        <div className="px-4 pt-2.5 pb-1 flex-shrink-0">
          {situationOpen ? (
            <div className="border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 rounded-xl px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-widest mb-1">
                    Current Situation
                  </p>
                  <p className="text-sm text-foreground leading-relaxed">
                    {currentNode.situation}
                  </p>
                </div>
                <button
                  onClick={() => setSituationOpen(false)}
                  className="flex-shrink-0 text-red-400 hover:text-red-600 transition-colors mt-0.5"
                  title="Collapse"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setSituationOpen(true)}
              className="text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors flex items-center gap-1 font-medium"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
              Current Situation
            </button>
          )}
        </div>
      )}

      {/* ── Chat messages ── */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-4 space-y-4">
          {messages.map((msg) => {
            // Media message
            if ("isMedia" in msg && msg.isMedia) {
              return (
                <div key={msg.id} className="flex gap-3 justify-start">
                  {/* Avatar */}
                  <div className="w-7 h-7 rounded-full bg-red-100 dark:bg-red-950/60 border border-red-200 dark:border-red-800 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="w-3.5 h-3.5 text-red-500"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                    </svg>
                  </div>

                  <div className="max-w-[75%] sm:max-w-md">
                    {msg.mediaType === "image" ? (
                      <div className="rounded-2xl rounded-tl-sm overflow-hidden border border-border bg-muted/60 shadow-sm">
                        <img
                          src={msg.dataUrl}
                          alt={msg.caption}
                          className="w-full object-contain max-h-72"
                        />
                        {msg.caption && (
                          <p className="text-xs text-muted-foreground px-3 py-2 border-t border-border">
                            {msg.caption}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-2xl rounded-tl-sm border border-border bg-muted/60 px-4 py-3 shadow-sm">
                        {msg.caption && (
                          <p className="text-xs text-muted-foreground mb-2">{msg.caption}</p>
                        )}
                        <audio controls src={msg.dataUrl} className="w-full h-9" />
                      </div>
                    )}
                  </div>
                </div>
              );
            }

            // Text message
            const isUser = msg.role === "user";
            return (
              <div
                key={msg.id}
                className={cn(
                  "flex gap-3",
                  isUser ? "justify-end" : "justify-start"
                )}
              >
                {/* Assistant avatar */}
                {!isUser && (
                  <div className="w-7 h-7 rounded-full bg-red-100 dark:bg-red-950/60 border border-red-200 dark:border-red-800 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="w-3.5 h-3.5 text-red-500"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                    </svg>
                  </div>
                )}

                <div
                  className={cn(
                    "max-w-[78%] sm:max-w-lg px-4 py-3 text-sm leading-relaxed shadow-sm",
                    isUser
                      ? "bg-red-500 text-white rounded-2xl rounded-tr-sm"
                      : "bg-muted/60 border border-border text-foreground rounded-2xl rounded-tl-sm"
                  )}
                >
                  {formatText(msg.content)}
                </div>
              </div>
            );
          })}

          {/* Loading indicator */}
          {loading && (
            <div className="flex gap-3 justify-start">
              <div className="w-7 h-7 rounded-full bg-red-100 dark:bg-red-950/60 border border-red-200 dark:border-red-800 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-3.5 h-3.5 text-red-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
              </div>
              <div className="bg-muted/60 border border-border rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-bounce" />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* ── Input area ── */}
      <div className="flex-shrink-0 border-t border-border bg-card px-4 py-3">
        {/* Confirm end (mobile / alternate position when no space) */}
        {confirmEnd && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20 px-3 py-2.5">
            <p className="text-xs text-red-700 dark:text-red-300 leading-snug">
              End this simulation? Your progress will not be saved.
            </p>
            <div className="flex gap-1.5 flex-shrink-0">
              <button
                onClick={() => setConfirmEnd(false)}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={endCase}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium transition-colors"
              >
                End
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2 items-end">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Respond as you would clinically…"
            disabled={loading}
            className={cn(
              "flex-1 min-w-0 rounded-xl border border-border bg-background px-4 py-2.5",
              "text-sm text-foreground placeholder:text-muted-foreground",
              "focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-400",
              "disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            )}
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            className={cn(
              "flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors",
              "bg-red-500 hover:bg-red-600 active:bg-red-700 text-white shadow-sm",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 19-7z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
