// ─── Syllabus pipeline types ──────────────────────────────────────────────────
// Shared between TeacherDashboard.tsx (write) and App.tsx (read).

export type SyllabusSection =
  | "course_info"
  | "learning_objectives"
  | "policies"
  | "weekly_schedule"
  | "exam_schedule"
  | "grading_breakdown";

export interface SyllabusMetadata {
  section: SyllabusSection;
  week?: number;
  exam_number?: number;
  date?: string;
  topics?: string[];
  chapters?: string[];
  weight?: number;
  type?: string;
}

export interface SyllabusChunk {
  source: "syllabus";
  label: string;
  text: string;
  meta: SyllabusMetadata;
}

// ─── Parsed syllabus sections ─────────────────────────────────────────────────

export interface WeekEntry {
  week: number;
  topic: string;
  learning_outcomes: string[];
  chapters?: string[];
  date_range?: string;
}

export interface ExamEntry {
  exam_number: number;
  type: string;
  date: string;
  topics: string[];
  chapters?: string[];
  weight?: number;
  notes?: string;
}

export interface GradeComponent {
  name: string;
  weight: number;
  description?: string;
}

export interface ParsedSyllabusV2 {
  // ── Call 1: course info + policies ─────────────────────────────────────────
  course_name: string;
  course_number?: string;
  instructor_name?: string;
  instructor_email?: string;
  office_hours?: string;
  course_description: string;
  learning_objectives: string[];
  attendance_policy?: string;
  late_work_policy?: string;
  required_materials?: string[];
  // ── Call 2: weekly schedule ─────────────────────────────────────────────────
  weekly_schedule: WeekEntry[];
  // ── Call 3: exams + grading ─────────────────────────────────────────────────
  exam_schedule: ExamEntry[];
  grading_breakdown: GradeComponent[];
  grading_notes?: string;
}
