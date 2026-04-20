import React, { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { CaseTree, CaseNode, CaseBranch } from "../types/case";

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_W = 140;
const NODE_H = 56;
const CANVAS_W = 1200;
const CANVAS_H = 800;

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// ─── Arrow marker defs ────────────────────────────────────────────────────────

function ArrowDefs() {
  return (
    <defs>
      <marker id="arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
        <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
      </marker>
      <marker id="arrow-blue" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
        <polygon points="0 0, 10 3.5, 0 7" fill="#3b82f6" />
      </marker>
      <marker id="arrow-dashed" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
        <polygon points="0 0, 10 3.5, 0 7" fill="#cbd5e1" />
      </marker>
    </defs>
  );
}

// ─── Node color helpers ───────────────────────────────────────────────────────

function nodeColors(node: CaseNode, selected: boolean) {
  if (selected) {
    return {
      fill: "#eff6ff",
      stroke: "#3b82f6",
      strokeWidth: 2.5,
      text: "#1d4ed8",
    };
  }
  if (node.isRoot) return { fill: "#dbeafe", stroke: "#3b82f6", strokeWidth: 2, text: "#1d4ed8" };
  if (node.isEnd) {
    if (node.outcome === "good")    return { fill: "#dcfce7", stroke: "#22c55e", strokeWidth: 2, text: "#166534" };
    if (node.outcome === "poor")    return { fill: "#fee2e2", stroke: "#ef4444", strokeWidth: 2, text: "#991b1b" };
    return { fill: "#fef9c3", stroke: "#eab308", strokeWidth: 2, text: "#713f12" };
  }
  return { fill: "#f8fafc", stroke: "#cbd5e1", strokeWidth: 1.5, text: "#1e293b" };
}

// ─── Single SVG node ─────────────────────────────────────────────────────────

function NodeShape({
  node,
  selected,
  connectingFrom,
  onClick,
  onMouseDown,
}: {
  node: CaseNode;
  selected: boolean;
  connectingFrom: string | null;
  onClick: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const colors = nodeColors(node, selected);
  const cx = node.x + NODE_W / 2;
  const cy = node.y + NODE_H / 2;

  return (
    <g
      style={{ cursor: connectingFrom && connectingFrom !== node.id ? "crosshair" : "move" }}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseDown={onMouseDown}
    >
      <rect
        x={node.x}
        y={node.y}
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={colors.fill}
        stroke={colors.stroke}
        strokeWidth={colors.strokeWidth}
      />
      {/* Corner badges */}
      {node.isRoot && (
        <text x={node.x + 7} y={node.y + 13} fontSize={9} fill={colors.text} fontWeight="700">ROOT</text>
      )}
      {node.isEnd && (
        <text x={node.x + NODE_W - 7} y={node.y + 13} fontSize={9} fill={colors.text} fontWeight="700" textAnchor="end">END</text>
      )}
      {/* Label text — wrap roughly */}
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={12}
        fontWeight="600"
        fill={colors.text}
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {node.label.length > 18 ? node.label.slice(0, 17) + "…" : node.label}
      </text>
    </g>
  );
}

// ─── Branch arrow ─────────────────────────────────────────────────────────────

function BranchArrow({
  branch,
  nodes,
  selected,
  onClick,
}: {
  branch: CaseBranch;
  nodes: CaseNode[];
  selected: boolean;
  onClick: () => void;
}) {
  const from = nodes.find((n) => n.id === branch.fromNodeId);
  const to   = nodes.find((n) => n.id === branch.toNodeId);
  if (!from || !to) return null;

  // Connect from bottom-centre of from to top-centre of to (simple straight line)
  const x1 = from.x + NODE_W / 2;
  const y1 = from.y + NODE_H;
  const x2 = to.x + NODE_W / 2;
  const y2 = to.y;

  // Midpoint for label
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  const color = selected ? "#3b82f6" : "#94a3b8";
  const markerId = selected ? "arrow-blue" : "arrow";

  return (
    <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      <line
        x1={x1} y1={y1 + 2}
        x2={x2} y2={y2 - 10}
        stroke={color}
        strokeWidth={selected ? 2 : 1.5}
        markerEnd={`url(#${markerId})`}
      />
      {/* Invisible hit area */}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
      {branch.label && (
        <text
          x={mx}
          y={my}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={10}
          fill={color}
          fontWeight="500"
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {branch.label.length > 20 ? branch.label.slice(0, 19) + "…" : branch.label}
        </text>
      )}
    </g>
  );
}

// ─── Properties panel ─────────────────────────────────────────────────────────

type Selection =
  | { kind: "node"; id: string }
  | { kind: "branch"; id: string }
  | null;

function PropertiesPanel({
  selection,
  nodes,
  branches,
  onUpdateNode,
  onUpdateBranch,
  onDeleteNode,
  onDeleteBranch,
}: {
  selection: Selection;
  nodes: CaseNode[];
  branches: CaseBranch[];
  onUpdateNode: (id: string, patch: Partial<CaseNode>) => void;
  onUpdateBranch: (id: string, patch: Partial<CaseBranch>) => void;
  onDeleteNode: (id: string) => void;
  onDeleteBranch: (id: string) => void;
}) {
  if (!selection) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 gap-2">
        <p className="text-3xl">🖱️</p>
        <p className="text-xs text-muted-foreground">Click a node or branch to edit its properties</p>
      </div>
    );
  }

  if (selection.kind === "node") {
    const node = nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    return (
      <div className="p-4 space-y-4 overflow-y-auto h-full">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-foreground uppercase tracking-wide">Node</p>
          <button
            onClick={() => onDeleteNode(node.id)}
            className="text-[10px] text-red-400 hover:text-red-600 font-semibold border border-red-200 rounded px-1.5 py-0.5 hover:bg-red-50 transition-all"
          >
            Delete
          </button>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Label</label>
          <input
            value={node.label}
            onChange={(e) => onUpdateNode(node.id, { label: e.target.value })}
            placeholder="e.g. Assess airway"
            className="w-full text-xs border border-border rounded-lg px-2.5 h-8 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400"
          />
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Coaching Note</label>
          <p className="text-[10px] text-muted-foreground">Shown to student post-case when they hover this node</p>
          <textarea
            value={node.description}
            onChange={(e) => onUpdateNode(node.id, { description: e.target.value })}
            placeholder="e.g. Assessing the airway first is the correct priority in this scenario because…"
            rows={3}
            className="w-full text-xs border border-border rounded-lg px-2.5 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none leading-relaxed"
          />
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={node.isRoot}
              onChange={(e) => onUpdateNode(node.id, { isRoot: e.target.checked })}
              className="rounded"
            />
            <span className="text-xs text-foreground font-medium">Root node</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={node.isEnd}
              onChange={(e) => onUpdateNode(node.id, { isEnd: e.target.checked })}
              className="rounded"
            />
            <span className="text-xs text-foreground font-medium">End node</span>
          </label>
        </div>

        {node.isEnd && (
          <div className="space-y-1">
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Outcome</label>
            <div className="flex gap-2">
              {(["good", "neutral", "poor"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => onUpdateNode(node.id, { outcome: o })}
                  className={cn(
                    "flex-1 text-xs py-1.5 rounded-lg border font-semibold transition-all capitalize",
                    node.outcome === o
                      ? o === "good"   ? "bg-emerald-500 text-white border-emerald-500"
                        : o === "poor" ? "bg-red-500 text-white border-red-500"
                        :               "bg-amber-400 text-white border-amber-400"
                      : "border-border text-muted-foreground hover:border-foreground/30"
                  )}
                >
                  {o === "good" ? "✓ Good" : o === "poor" ? "✗ Poor" : "~ Neutral"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // branch
  const branch = branches.find((b) => b.id === selection.id);
  if (!branch) return null;
  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-foreground uppercase tracking-wide">Branch</p>
        <button
          onClick={() => onDeleteBranch(branch.id)}
          className="text-[10px] text-red-400 hover:text-red-600 font-semibold border border-red-200 rounded px-1.5 py-0.5 hover:bg-red-50 transition-all"
        >
          Delete
        </button>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Arrow Label</label>
        <p className="text-[10px] text-muted-foreground">Short text shown on the arrow</p>
        <input
          value={branch.label}
          onChange={(e) => onUpdateBranch(branch.id, { label: e.target.value })}
          placeholder="e.g. Checks breathing"
          className="w-full text-xs border border-border rounded-lg px-2.5 h-8 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">AI Trigger Phrase</label>
        <p className="text-[10px] text-muted-foreground">Natural language description — AI uses this to detect when a student takes this branch</p>
        <textarea
          value={branch.triggerPhrase}
          onChange={(e) => onUpdateBranch(branch.id, { triggerPhrase: e.target.value })}
          placeholder="e.g. Student asks about or assesses respiratory system, breathing, lung sounds, or oxygen saturation"
          rows={4}
          className="w-full text-xs border border-border rounded-lg px-2.5 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none leading-relaxed"
        />
      </div>
    </div>
  );
}

// ─── Main CaseCanvas component ────────────────────────────────────────────────

export default function CaseCanvas({
  tree,
  onChange,
  onBack,
}: {
  tree: CaseTree;
  onChange: (updated: CaseTree) => void;
  onBack: () => void;
}) {
  const [nodes, setNodes] = useState<CaseNode[]>(tree.nodes);
  const [branches, setBranches] = useState<CaseBranch[]>(tree.branches);
  const [selection, setSelection] = useState<Selection>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [caseTitle, setCaseTitle] = useState(tree.title);
  const [caseDiagnosis, setCaseDiagnosis] = useState(tree.diagnosis);
  const [caseDescription, setCaseDescription] = useState(tree.description);
  const svgRef = useRef<SVGSVGElement>(null);

  // Sync up to parent on change
  useEffect(() => {
    const updated: CaseTree = {
      ...tree,
      title: caseTitle,
      diagnosis: caseDiagnosis,
      description: caseDescription,
      nodes,
      branches,
      updatedAt: new Date().toISOString(),
    };
    onChange(updated);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, branches, caseTitle, caseDiagnosis, caseDescription]);

  const getSVGPoint = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: e.clientX, y: e.clientY };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: svgP.x, y: svgP.y };
  }, []);

  function addNode() {
    const viewCenterX = CANVAS_W / 2 - NODE_W / 2;
    const viewCenterY = 100 + nodes.length * 80;
    const newNode: CaseNode = {
      id: uid(),
      label: "New Node",
      situation: "",
      completionCriteria: "",
      completionNarration: "",
      required: true,
      consequences: [],
      description: "",
      x: Math.min(viewCenterX, CANVAS_W - NODE_W - 20),
      y: Math.min(viewCenterY, CANVAS_H - NODE_H - 20),
      isRoot: nodes.length === 0,
      isEnd: false,
    };
    setNodes((prev) => [...prev, newNode]);
    setSelection({ kind: "node", id: newNode.id });
  }

  function handleNodeMouseDown(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();

    if (connectingFrom) {
      // Second click — create branch
      if (connectingFrom !== nodeId) {
        // Avoid duplicate branches
        const exists = branches.some(
          (b) => b.fromNodeId === connectingFrom && b.toNodeId === nodeId
        );
        if (!exists) {
          const newBranch: CaseBranch = {
            id: uid(),
            fromNodeId: connectingFrom,
            toNodeId: nodeId,
            label: "",
            triggerPhrase: "",
          };
          setBranches((prev) => [...prev, newBranch]);
          setSelection({ kind: "branch", id: newBranch.id });
        }
      }
      setConnectingFrom(null);
      return;
    }

    const pt = getSVGPoint(e);
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setDragging({ nodeId, offsetX: pt.x - node.x, offsetY: pt.y - node.y });
    setSelection({ kind: "node", id: nodeId });
  }

  function handleSVGMouseMove(e: React.MouseEvent) {
    const pt = getSVGPoint(e);
    setMousePos(pt);
    if (!dragging) return;
    setNodes((prev) =>
      prev.map((n) =>
        n.id === dragging.nodeId
          ? {
              ...n,
              x: Math.max(0, Math.min(CANVAS_W - NODE_W, pt.x - dragging.offsetX)),
              y: Math.max(0, Math.min(CANVAS_H - NODE_H, pt.y - dragging.offsetY)),
            }
          : n
      )
    );
  }

  function handleSVGMouseUp() {
    setDragging(null);
  }

  function handleSVGClick() {
    if (!connectingFrom) setSelection(null);
  }

  function updateNode(id: string, patch: Partial<CaseNode>) {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  }

  function updateBranch(id: string, patch: Partial<CaseBranch>) {
    setBranches((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  function deleteNode(id: string) {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setBranches((prev) => prev.filter((b) => b.fromNodeId !== id && b.toNodeId !== id));
    setSelection(null);
  }

  function deleteBranch(id: string) {
    setBranches((prev) => prev.filter((b) => b.id !== id));
    setSelection(null);
  }

  // Connecting cursor: find the "from" node for the preview line
  const connectingNode = connectingFrom ? nodes.find((n) => n.id === connectingFrom) : null;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ── Editor header ── */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-3 flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 h-7 transition-all"
        >
          ← Cases
        </button>
        <div className="flex-1 min-w-0">
          <input
            value={caseTitle}
            onChange={(e) => setCaseTitle(e.target.value)}
            placeholder="Case title…"
            className="w-full text-sm font-bold bg-transparent border-b border-transparent focus:border-brand-400 focus:outline-none pb-0.5 placeholder:font-normal placeholder:text-muted-foreground text-foreground"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={addNode}
            className="text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-lg px-3 h-7 font-semibold transition-all"
          >
            + Node
          </button>
          <button
            onClick={() => {
              if (connectingFrom) { setConnectingFrom(null); return; }
              if (nodes.length < 2) return;
              // Pick the first non-end node or first node
              const startNode = nodes.find((n) => !n.isEnd) ?? nodes[0];
              setConnectingFrom(startNode.id);
              setSelection({ kind: "node", id: startNode.id });
            }}
            className={cn(
              "text-xs rounded-lg px-3 h-7 font-semibold transition-all border",
              connectingFrom
                ? "bg-red-500 text-white border-red-500 animate-pulse"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
            )}
          >
            {connectingFrom ? "🔗 Click target node…" : "+ Branch"}
          </button>
        </div>
      </div>

      {/* ── Canvas + properties split ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Meta fields above canvas ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Subheader: diagnosis + description */}
          <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-2 flex gap-4">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide shrink-0">Diagnosis</span>
              <input
                value={caseDiagnosis}
                onChange={(e) => setCaseDiagnosis(e.target.value)}
                placeholder="Primary diagnosis anchor (e.g. Acute MI)"
                className="flex-1 text-xs bg-transparent border-b border-transparent focus:border-brand-400 focus:outline-none pb-0.5 text-foreground placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide shrink-0">Description</span>
              <input
                value={caseDescription}
                onChange={(e) => setCaseDescription(e.target.value)}
                placeholder="Short description shown in case library"
                className="flex-1 text-xs bg-transparent border-b border-transparent focus:border-brand-400 focus:outline-none pb-0.5 text-foreground placeholder:text-muted-foreground/50"
              />
            </div>
          </div>

          {/* SVG canvas */}
          <div className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900/50">
            {nodes.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
                <p className="text-4xl">📋</p>
                <p className="text-sm font-semibold text-foreground">Empty canvas</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  Click <strong>+ Node</strong> to add your first decision point. Then connect nodes with <strong>+ Branch</strong>.
                </p>
                <button
                  onClick={addNode}
                  className="mt-2 text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-lg px-4 h-8 font-semibold"
                >
                  Add first node
                </button>
              </div>
            ) : (
              <svg
                ref={svgRef}
                width={CANVAS_W}
                height={CANVAS_H}
                className="block"
                onMouseMove={handleSVGMouseMove}
                onMouseUp={handleSVGMouseUp}
                onClick={handleSVGClick}
                style={{ cursor: connectingFrom ? "crosshair" : "default" }}
              >
                <ArrowDefs />

                {/* Grid dots */}
                <pattern id="grid" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
                  <circle cx="0.5" cy="0.5" r="0.5" fill="currentColor" className="text-slate-300 dark:text-slate-600" />
                </pattern>
                <rect width={CANVAS_W} height={CANVAS_H} fill="url(#grid)" />

                {/* Branches */}
                {branches.map((b) => (
                  <BranchArrow
                    key={b.id}
                    branch={b}
                    nodes={nodes}
                    selected={selection?.kind === "branch" && selection.id === b.id}
                    onClick={() => setSelection({ kind: "branch", id: b.id })}
                  />
                ))}

                {/* Preview line while connecting */}
                {connectingFrom && connectingNode && (
                  <line
                    x1={connectingNode.x + NODE_W / 2}
                    y1={connectingNode.y + NODE_H}
                    x2={mousePos.x}
                    y2={mousePos.y}
                    stroke="#cbd5e1"
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                    markerEnd="url(#arrow-dashed)"
                    style={{ pointerEvents: "none" }}
                  />
                )}

                {/* Nodes */}
                {nodes.map((node) => (
                  <NodeShape
                    key={node.id}
                    node={node}
                    selected={selection?.kind === "node" && selection.id === node.id}
                    connectingFrom={connectingFrom}
                    onClick={() => setSelection({ kind: "node", id: node.id })}
                    onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                  />
                ))}
              </svg>
            )}
          </div>
        </div>

        {/* ── Properties panel ── */}
        <div className="w-72 shrink-0 border-l border-border bg-card">
          <PropertiesPanel
            selection={selection}
            nodes={nodes}
            branches={branches}
            onUpdateNode={updateNode}
            onUpdateBranch={updateBranch}
            onDeleteNode={deleteNode}
            onDeleteBranch={deleteBranch}
          />
        </div>
      </div>
    </div>
  );
}
