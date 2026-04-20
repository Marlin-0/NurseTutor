import React, { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { CaseTree, CaseMediaFile, CaseDocFile, MediaTriggerMode } from "../types/case";
import { saveMediaDataUrl, deleteMediaDataUrl, loadMediaDataUrl } from "../types/case";
import { extractText } from "../lib/parseFile";

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// ─── CaseMediaPanel ───────────────────────────────────────────────────────────

export default function CaseMediaPanel({
  tree,
  onUpdate,
}: {
  tree: CaseTree;
  onUpdate: (patch: Partial<CaseTree>) => void;
}) {
  const docInputRef   = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  // ── Doc uploads ──────────────────────────────────────────────────────────────

  async function handleDocUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    for (const file of files) {
      setUploading(file.name);
      try {
        const content = await extractText(file);
        const newDoc: CaseDocFile = {
          id: uid(),
          name: file.name,
          content,
        };
        onUpdate({ docFiles: [...(tree.docFiles ?? []), newDoc] });
      } catch (err) {
        console.error("Doc upload error:", err);
      }
    }
    setUploading(null);
  }

  function deleteDoc(id: string) {
    onUpdate({ docFiles: (tree.docFiles ?? []).filter((d) => d.id !== id) });
  }

  // ── Media (image / audio) uploads ────────────────────────────────────────────

  async function handleMediaUpload(
    e: React.ChangeEvent<HTMLInputElement>,
    type: "image" | "audio"
  ) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    for (const file of files) {
      setUploading(file.name);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const mediaId = uid();
        saveMediaDataUrl(tree.id, mediaId, dataUrl);

        const newMedia: CaseMediaFile = {
          id: mediaId,
          name: file.name,
          triggerKeyword: file.name.replace(/\.[^.]+$/, "").replace(/\s+/g, "-").toLowerCase(),
          type,
          triggerMode: "student-asks",
          description: "",
        };
        onUpdate({ mediaFiles: [...(tree.mediaFiles ?? []), newMedia] });
      } catch (err) {
        console.error("Media upload error:", err);
      }
    }
    setUploading(null);
  }

  function deleteMedia(id: string) {
    deleteMediaDataUrl(tree.id, id);
    onUpdate({ mediaFiles: (tree.mediaFiles ?? []).filter((m) => m.id !== id) });
  }

  function updateMedia(id: string, patch: Partial<CaseMediaFile>) {
    onUpdate({
      mediaFiles: (tree.mediaFiles ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  }

  const docs    = tree.docFiles   ?? [];
  const images  = (tree.mediaFiles ?? []).filter((m) => m.type === "image");
  const audios  = (tree.mediaFiles ?? []).filter((m) => m.type === "audio");

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-5 space-y-8">

        {/* ── Case Documents ────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">📄 Case Documents</h3>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                PDFs and notes the AI uses for knowledge during this simulation. Published cases inject these into student sessions.
              </p>
            </div>
            <button
              onClick={() => docInputRef.current?.click()}
              disabled={!!uploading}
              className="shrink-0 text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-lg px-3 h-7 font-semibold transition-all disabled:opacity-50"
            >
              ↑ Upload
            </button>
          </div>
          <input
            ref={docInputRef}
            type="file"
            accept=".pdf,.txt,.docx"
            multiple
            className="hidden"
            onChange={handleDocUpload}
          />

          {docs.length === 0 && (
            <p className="text-[10px] text-muted-foreground italic border border-dashed border-border rounded-lg px-3 py-4 text-center">
              No documents uploaded yet
            </p>
          )}
          <div className="space-y-2">
            {docs.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-muted/30 text-xs"
              >
                <span className="text-base">📄</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate">{doc.name}</p>
                  <p className="text-muted-foreground">{doc.content.length.toLocaleString()} chars</p>
                </div>
                <button
                  onClick={() => deleteDoc(doc.id)}
                  className="text-muted-foreground hover:text-red-500 transition-colors text-xs px-1"
                  title="Remove document"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          {uploading && (
            <p className="text-[10px] text-muted-foreground animate-pulse">Processing {uploading}…</p>
          )}
        </section>

        {/* ── Images ───────────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">🖼 Images</h3>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                X-rays, CT scans, ECGs — appear in chat when triggered
              </p>
            </div>
            <button
              onClick={() => imageInputRef.current?.click()}
              disabled={!!uploading}
              className="shrink-0 text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-lg px-3 h-7 font-semibold transition-all disabled:opacity-50"
            >
              ↑ Upload
            </button>
          </div>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleMediaUpload(e, "image")}
          />

          {images.length === 0 && (
            <p className="text-[10px] text-muted-foreground italic border border-dashed border-border rounded-lg px-3 py-4 text-center">
              No images uploaded yet
            </p>
          )}
          <div className="space-y-3">
            {images.map((media) => (
              <MediaCard
                key={media.id}
                media={media}
                caseId={tree.id}
                onUpdate={(patch) => updateMedia(media.id, patch)}
                onDelete={() => deleteMedia(media.id)}
              />
            ))}
          </div>
        </section>

        {/* ── Audio Clips ───────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">🔊 Audio Clips</h3>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Heart sounds, lung sounds, bowel sounds — played inline in chat
              </p>
            </div>
            <button
              onClick={() => audioInputRef.current?.click()}
              disabled={!!uploading}
              className="shrink-0 text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-lg px-3 h-7 font-semibold transition-all disabled:opacity-50"
            >
              ↑ Upload
            </button>
          </div>
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            multiple
            className="hidden"
            onChange={(e) => handleMediaUpload(e, "audio")}
          />

          {audios.length === 0 && (
            <p className="text-[10px] text-muted-foreground italic border border-dashed border-border rounded-lg px-3 py-4 text-center">
              No audio clips uploaded yet
            </p>
          )}
          <div className="space-y-3">
            {audios.map((media) => (
              <MediaCard
                key={media.id}
                media={media}
                caseId={tree.id}
                onUpdate={(patch) => updateMedia(media.id, patch)}
                onDelete={() => deleteMedia(media.id)}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ─── MediaCard ────────────────────────────────────────────────────────────────

function MediaCard({
  media,
  caseId,
  onUpdate,
  onDelete,
}: {
  media: CaseMediaFile;
  caseId: string;
  onUpdate: (patch: Partial<CaseMediaFile>) => void;
  onDelete: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const dataUrl = preview ? loadMediaDataUrl(caseId, media.id) : null;

  return (
    <div className="border border-border rounded-xl bg-card p-3 space-y-3">
      {/* Header row */}
      <div className="flex items-start gap-2">
        <span className="text-base shrink-0">{media.type === "image" ? "🖼" : "🔊"}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground truncate">{media.name}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setPreview((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-0.5 transition-colors"
          >
            {preview ? "Hide" : "Preview"}
          </button>
          <button
            onClick={onDelete}
            className="text-[10px] text-red-400 hover:text-red-600 border border-red-200 rounded px-1.5 py-0.5 transition-colors"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Preview */}
      {preview && dataUrl && (
        <div className="rounded-lg overflow-hidden border border-border">
          {media.type === "image" && (
            <img src={dataUrl} alt={media.name} className="w-full object-contain max-h-40" />
          )}
          {media.type === "audio" && (
            <div className="px-3 py-2">
              <audio controls src={dataUrl} className="w-full h-8" />
            </div>
          )}
        </div>
      )}

      {/* Trigger keyword */}
      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Trigger Keyword
        </label>
        <p className="text-[10px] text-muted-foreground">AI uses this keyword to display the media. Student asks or AI surfaces it.</p>
        <input
          value={media.triggerKeyword}
          onChange={(e) => onUpdate({ triggerKeyword: e.target.value })}
          placeholder="e.g. chest-xray"
          className="w-full text-xs border border-border rounded-lg px-2.5 h-7 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400"
        />
      </div>

      {/* Caption */}
      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Caption / Description
        </label>
        <input
          value={media.description ?? ""}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="e.g. Chest X-ray taken on admission"
          className="w-full text-xs border border-border rounded-lg px-2.5 h-7 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400"
        />
      </div>

      {/* Trigger mode toggle */}
      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          When to show
        </label>
        <div className="flex gap-2">
          {(["student-asks", "ai-auto"] as MediaTriggerMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => onUpdate({ triggerMode: mode })}
              className={cn(
                "flex-1 text-[10px] py-1.5 rounded-lg border font-semibold transition-all",
                media.triggerMode === mode
                  ? "bg-brand-500 text-white border-brand-500"
                  : "border-border text-muted-foreground hover:border-foreground/30"
              )}
            >
              {mode === "student-asks" ? "🙋 Student asks" : "🤖 AI surfaces"}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground">
          {media.triggerMode === "student-asks"
            ? "Only shown when a student explicitly requests it"
            : "AI will proactively surface this when clinically relevant"}
        </p>
      </div>
    </div>
  );
}
