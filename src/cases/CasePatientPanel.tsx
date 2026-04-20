import { cn } from "@/lib/utils";
import type { PatientProfile, PatientVitals } from "../types/case";

// ─── CasePatientPanel ─────────────────────────────────────────────────────────

export default function CasePatientPanel({
  profile,
  onChange,
}: {
  profile: PatientProfile;
  onChange: (updated: PatientProfile) => void;
}) {
  function field(
    label: string,
    key: keyof PatientProfile,
    placeholder: string,
    multiline = false,
    rows = 2
  ) {
    const sharedClass =
      "w-full text-xs border border-border rounded-lg px-2.5 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400";

    return (
      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          {label}
        </label>
        {multiline ? (
          <textarea
            value={profile[key] as string}
            onChange={(e) => onChange({ ...profile, [key]: e.target.value })}
            placeholder={placeholder}
            rows={rows}
            className={cn(sharedClass, "py-2 resize-none leading-relaxed")}
          />
        ) : (
          <input
            type="text"
            value={profile[key] as string}
            onChange={(e) => onChange({ ...profile, [key]: e.target.value })}
            placeholder={placeholder}
            className={cn(sharedClass, "h-8")}
          />
        )}
      </div>
    );
  }

  function vitalField(label: string, key: keyof PatientVitals, placeholder: string) {
    return (
      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          {label}
        </label>
        <input
          type="text"
          value={profile.vitals[key]}
          onChange={(e) =>
            onChange({ ...profile, vitals: { ...profile.vitals, [key]: e.target.value } })
          }
          placeholder={placeholder}
          className="w-full text-xs border border-border rounded-lg px-2.5 h-8 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400"
        />
      </div>
    );
  }

  const sectionDivider = "border-t border-border pt-5";
  const sectionHeader =
    "text-xs font-bold uppercase tracking-wide text-muted-foreground pb-3 border-b border-border";

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-5 space-y-5">

        {/* ── Section 1: Patient Identity ───────────────────────────────────── */}
        <section className="space-y-4">
          <h3 className={sectionHeader}>Patient Identity</h3>
          <div className="grid grid-cols-2 gap-3">
            {field("Name", "name", "e.g. James Mitchell")}
            {field("Age", "age", "e.g. 67")}
            {field("Gender", "gender", "e.g. Male")}
            {field("Room / Bed", "room", "e.g. 4B-12")}
            {field("Admitted", "admittedDate", "e.g. April 14, 2026")}
            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                Code Status
              </label>
              <select
                value={profile.codeStatus}
                onChange={(e) => onChange({ ...profile, codeStatus: e.target.value })}
                className="w-full text-xs border border-border rounded-lg px-2.5 h-8 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400"
              >
                <option value="Full Code">Full Code</option>
                <option value="DNR">DNR</option>
                <option value="DNR/DNI">DNR/DNI</option>
                <option value="Comfort Measures Only">Comfort Measures Only</option>
              </select>
            </div>
          </div>
        </section>

        {/* ── Section 2: Presenting Vitals ──────────────────────────────────── */}
        <section className={cn(sectionDivider, "space-y-4")}>
          <h3 className={sectionHeader}>Presenting Vitals</h3>
          <div className="grid grid-cols-3 gap-2">
            {vitalField("BP", "bp", "e.g. 138/88 mmHg")}
            {vitalField("HR", "hr", "e.g. 102 bpm")}
            {vitalField("RR", "rr", "e.g. 22 breaths/min")}
            {vitalField("SpO₂", "spo2", "e.g. 92% RA")}
            {vitalField("Temp", "temp", "e.g. 38.4°C")}
            {vitalField("Pain", "pain", "e.g. 7/10 substernal")}
            {vitalField("GCS", "gcs", "e.g. 15")}
            {vitalField("Weight", "weight", "e.g. 74 kg")}
            {vitalField("Height", "height", "e.g. 170 cm")}
          </div>
        </section>

        {/* ── Section 3: Clinical Context ───────────────────────────────────── */}
        <section className={cn(sectionDivider, "space-y-4")}>
          <h3 className={sectionHeader}>Clinical Context</h3>
          <div className="space-y-3">
            {field(
              "Chief Complaint",
              "chiefComplaint",
              "e.g. Progressive shortness of breath over 3 days",
              true,
              2
            )}
            {field(
              "Primary Diagnosis",
              "primaryDiagnosis",
              "e.g. Community-acquired pneumonia with suspected sepsis",
              true,
              2
            )}
            {field(
              "Past Medical History",
              "pastMedicalHistory",
              "e.g. HTN, Type 2 DM, COPD",
              true,
              3
            )}
            {field(
              "Current Medications",
              "medications",
              "e.g. Metformin 1000mg BD, Ramipril 10mg OD, Salbutamol PRN",
              true,
              3
            )}
            {field(
              "Allergies",
              "allergies",
              "e.g. Penicillin — rash. NKDA otherwise.",
              true,
              2
            )}
          </div>
        </section>

        {/* ── Section 4: Diagnostics ────────────────────────────────────────── */}
        <section className={cn(sectionDivider, "space-y-4")}>
          <h3 className={sectionHeader}>Diagnostics</h3>
          <div className="space-y-3">
            {field(
              "Imaging / X-ray Findings",
              "imagingNotes",
              "e.g. CXR: Right lower lobe consolidation consistent with pneumonia",
              true,
              3
            )}
            {field(
              "Lab Results",
              "labNotes",
              "e.g. WBC 14.2 \u00d7 10\u2079/L, CRP 87, Lactate 2.1, Glucose 11.4",
              true,
              3
            )}
          </div>
        </section>

        {/* ── Section 5: Nursing Notes ──────────────────────────────────────── */}
        <section className={cn(sectionDivider, "space-y-4")}>
          <h3 className={sectionHeader}>Nursing Notes</h3>
          {field(
            "Nursing Notes",
            "nursingNotes",
            "e.g. Patient anxious, diaphoretic. Last voided 6h ago. IV access #18G right AC.",
            true,
            4
          )}
        </section>

      </div>
    </div>
  );
}
