// ─── Case Study Branching Types ───────────────────────────────────────────────

export interface NodeConsequence {
  id: string;
  afterTurns: number;     // turns spent on this node before triggering
  description: string;    // narrated by AI, e.g. "Patient's O2 drops to 88%, becomes more dyspneic"
  severity: "warning" | "deterioration" | "critical";
  /**
   * If set, the simulation hard-routes the student to this node when the event fires.
   * The AI narrates the description on that same turn, then the situation banner switches.
   */
  linkedNodeId?: string;
}

export interface CaseNode {
  id: string;
  label: string;              // Short label shown on canvas, e.g. "Assess Respiratory"
  situation: string;          // Clinical description of the challenge — what's happening right now
  completionCriteria: string; // Natural language — what the student must do/say to complete this node
  completionNarration: string;// What the AI narrates when student hits this checkpoint, e.g. "Your colleague says 'nice catch'"
  required: boolean;          // Required checkpoint vs optional good-practice node
  consequences: NodeConsequence[]; // Time-based deterioration if student doesn't complete
  description: string;        // Coaching note shown post-case on hover
  x: number;                  // Canvas position (px)
  y: number;
  isRoot: boolean;
  isEnd: boolean;
  outcome?: "good" | "neutral" | "poor"; // Controls end-node color in post-case reveal
}

export interface CaseBranch {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  triggerPhrase: string; // Natural language: "Student assesses lung sounds or breathing"
  label: string;         // Short label shown on arrow, e.g. "Respiratory assessment"
  /**
   * If set, this branch auto-fires once the student has spent this many turns
   * on the source node without triggering any other branch. Useful for
   * "if student is idle → deteriorate / escalate" branches.
   */
  autoTriggerAfterTurns?: number;
  /**
   * When true, this branch is part of the primary horizontal "main track" spine.
   * False / undefined = side branch (deterioration, escalation, alternate path).
   */
  mainTrack?: boolean;
}

// ─── Media files ──────────────────────────────────────────────────────────────

export type MediaTriggerMode = "student-asks" | "ai-auto";

export interface CaseMediaFile {
  id: string;
  name: string;               // original filename
  triggerKeyword: string;     // e.g. "chest-xray" or "lung-sounds"
  type: "image" | "audio";
  triggerMode: MediaTriggerMode; // student-asks: only on request | ai-auto: AI surfaces proactively
  description?: string;       // caption shown in chat, AI instruction context
}

// Media data stored separately to avoid bloating the main case library JSON
export const MEDIA_STORAGE_KEY = (caseId: string, mediaId: string) =>
  `nursetutor-case-media-${caseId}-${mediaId}`;

export function saveMediaDataUrl(caseId: string, mediaId: string, dataUrl: string): void {
  localStorage.setItem(MEDIA_STORAGE_KEY(caseId, mediaId), dataUrl);
}

export function loadMediaDataUrl(caseId: string, mediaId: string): string | null {
  return localStorage.getItem(MEDIA_STORAGE_KEY(caseId, mediaId));
}

export function deleteMediaDataUrl(caseId: string, mediaId: string): void {
  localStorage.removeItem(MEDIA_STORAGE_KEY(caseId, mediaId));
}

// ─── Case document files ──────────────────────────────────────────────────────

export interface CaseDocFile {
  id: string;
  name: string;
  content: string; // extracted text, injected into AI knowledge base for this case
}

// ─── Patient profile ──────────────────────────────────────────────────────────

export interface PatientVitals {
  bp: string;       // e.g. "138/88 mmHg"
  hr: string;       // e.g. "102 bpm"
  rr: string;       // e.g. "22 breaths/min"
  spo2: string;     // e.g. "92% on room air"
  temp: string;     // e.g. "38.4°C"
  weight: string;   // e.g. "74 kg"
  height: string;   // e.g. "170 cm"
  gcs: string;      // e.g. "15"
  pain: string;     // e.g. "7/10 substernal"
}

export interface PatientProfile {
  // Demographics
  name: string;
  age: string;
  gender: string;
  room: string;
  admittedDate: string;
  codeStatus: string;       // e.g. "Full Code", "DNR"
  // Clinical context
  chiefComplaint: string;
  primaryDiagnosis: string;
  pastMedicalHistory: string;
  medications: string;
  allergies: string;
  // Presenting vitals
  vitals: PatientVitals;
  // Imaging / diagnostics summary
  imagingNotes: string;     // Free text: "CXR shows right lower lobe consolidation"
  labNotes: string;         // Free text: "WBC 14.2, Lactate 2.1"
  // Nursing context
  nursingNotes: string;     // Any other context the teacher wants to set
}

export function defaultPatientProfile(): PatientProfile {
  return {
    name: "", age: "", gender: "", room: "", admittedDate: "", codeStatus: "Full Code",
    chiefComplaint: "",
    primaryDiagnosis: "",
    pastMedicalHistory: "", medications: "", allergies: "",
    vitals: { bp: "", hr: "", rr: "", spo2: "", temp: "", weight: "", height: "", gcs: "", pain: "" },
    imagingNotes: "", labNotes: "", nursingNotes: "",
  };
}

// ─── Case tree ────────────────────────────────────────────────────────────────

export interface CaseTree {
  id: string;
  title: string;
  description: string;    // Shown in case library list
  diagnosis: string;      // Primary diagnosis anchor for AI prompt
  nodes: CaseNode[];
  branches: CaseBranch[];
  mediaFiles: CaseMediaFile[];
  docFiles: CaseDocFile[];
  patientProfile: PatientProfile;
  publishedToStudents: boolean;
  createdAt: string;
  updatedAt: string;
}
