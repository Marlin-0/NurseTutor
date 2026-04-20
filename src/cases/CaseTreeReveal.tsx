import { useState } from "react";
import { cn } from "@/lib/utils";
import type { CaseTree, CaseNode, CaseBranch } from "../types/case";

// ─── Constants (match CaseCanvas) ────────────────────────────────────────────

const NODE_W = 140;
const NODE_H = 56;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nodeStyle(
  node: CaseNode,
  visitedIds: Set<string>,
  isActive: boolean
): { fill: string; stroke: string; strokeWidth: number; textColor: string; opacity: number } {
  const visited = visitedIds.has(node.id);

  if (isActive) {
    return { fill: "#eff6ff", stroke: "#3b82f6", strokeWidth: 3, textColor: "#1d4ed8", opacity: 1 };
  }
  if (visited) {
    return { fill: "#dbeafe", stroke: "#3b82f6", strokeWidth: 2, textColor: "#1d4ed8", opacity: 1 };
  }
  if (node.isEnd) {
    if (node.outcome === "good")    return { fill: "#f0fdf4", stroke: "#86efac", strokeWidth: 1.5, textColor: "#15803d", opacity: 0.5 };
    if (node.outcome === "poor")    return { fill: "#fff1f2", stroke: "#fca5a5", strokeWidth: 1.5, textColor: "#b91c1c", opacity: 0.5 };
    return { fill: "#fefce8", stroke: "#fde68a", strokeWidth: 1.5, textColor: "#92400e", opacity: 0.5 };
  }
  return { fill: "#f8fafc", stroke: "#e2e8f0", strokeWidth: 1, textColor: "#94a3b8", opacity: 0.45 };
}

function endNodeBadge(node: CaseNode): string | null {
  if (!node.isEnd) return null;
  if (node.outcome === "good")    return "✓ Good outcome";
  if (node.outcome === "poor")    return "✗ Poor outcome";
  return "~ Neutral outcome";
}

function endNodeBadgeColor(node: CaseNode): string {
  if (node.outcome === "good") return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-300";
  if (node.outcome === "poor") return "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-300";
  return "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-300";
}

// ─── Arrow defs ───────────────────────────────────────────────────────────────

function RevealArrowDefs() {
  return (
    <defs>
      <marker id="reveal-arrow-blue" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
        <polygon points="0 0, 10 3.5, 0 7" fill="#3b82f6" />
      </marker>
      <marker id="reveal-arrow-gray" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
        <polygon points="0 0, 10 3.5, 0 7" fill="#cbd5e1" />
      </marker>
    </defs>
  );
}

// ─── Tooltip state ────────────────────────────────────────────────────────────

interface TooltipState {
  node: CaseNode;
  x: number;
  y: number;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CaseTreeReveal({
  tree,
  visitedNodeIds,
}: {
  tree: CaseTree;
  visitedNodeIds: string[];
}) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const visited = new Set(visitedNodeIds);
  const lastVisited = visitedNodeIds[visitedNodeIds.length - 1] ?? null;

  // Compute visited branch IDs — a branch is "visited" if both endpoints are visited
  // and the path went from→to in that order
  const visitedBranchIds = new Set<string>();
  for (let i = 0; i < visitedNodeIds.length - 1; i++) {
    const from = visitedNodeIds[i];
    const to   = visitedNodeIds[i + 1];
    const branch = tree.branches.find((b) => b.fromNodeId === from && b.toNodeId === to);
    if (branch) visitedBranchIds.add(branch.id);
  }

  // Compute bounding box for auto-scaling
  const minX = tree.nodes.length > 0 ? Math.min(...tree.nodes.map((n) => n.x)) : 0;
  const minY = tree.nodes.length > 0 ? Math.min(...tree.nodes.map((n) => n.y)) : 0;
  const maxX = tree.nodes.length > 0 ? Math.max(...tree.nodes.map((n) => n.x + NODE_W)) : 400;
  const maxY = tree.nodes.length > 0 ? Math.max(...tree.nodes.map((n) => n.y + NODE_H)) : 300;
  const padding = 32;
  const viewWidth  = maxX - minX + padding * 2;
  const viewHeight = maxY - minY + padding * 2;

  function handleNodeClick(node: CaseNode, svgX: number, svgY: number) {
    if (tooltip?.node.id === node.id) { setTooltip(null); return; }
    if (!node.description && !endNodeBadge(node)) return;
    setTooltip({ node, x: svgX, y: svgY });
  }

  if (tree.nodes.length === 0) return null;

  return (
    <div className="mt-4 border border-red-200 dark:border-red-800 rounded-2xl bg-gradient-to-br from-red-50/60 to-slate-50 dark:from-red-950/20 dark:to-slate-900/30 overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-5 py-4 border-b border-red-200/60 dark:border-red-800/50 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-foreground">Your Decision Path</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {visitedNodeIds.length} node{visitedNodeIds.length !== 1 ? "s" : ""} visited · Blue = your path · Gray = alternate routes
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-blue-200 border border-blue-400"></span>
            Your path
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-slate-200 border border-slate-300"></span>
            Other routes
          </span>
        </div>
      </div>

      {/* SVG tree */}
      <div className="overflow-auto" onClick={() => setTooltip(null)}>
        <svg
          width={viewWidth}
          height={viewHeight}
          viewBox={`${minX - padding} ${minY - padding} ${viewWidth} ${viewHeight}`}
          className="block mx-auto"
          style={{ maxWidth: "100%" }}
        >
          <RevealArrowDefs />

          {/* Branches */}
          {tree.branches.map((branch: CaseBranch) => {
            const from = tree.nodes.find((n) => n.id === branch.fromNodeId);
            const to   = tree.nodes.find((n) => n.id === branch.toNodeId);
            if (!from || !to) return null;
            const isVisited = visitedBranchIds.has(branch.id);
            const x1 = from.x + NODE_W / 2;
            const y1 = from.y + NODE_H;
            const x2 = to.x + NODE_W / 2;
            const y2 = to.y;
            const mx = (x1 + x2) / 2;
            const my = (y1 + y2) / 2;
            const color = isVisited ? "#3b82f6" : "#cbd5e1";
            const marker = isVisited ? "url(#reveal-arrow-blue)" : "url(#reveal-arrow-gray)";
            return (
              <g key={branch.id}>
                <line
                  x1={x1} y1={y1 + 2}
                  x2={x2} y2={y2 - 10}
                  stroke={color}
                  strokeWidth={isVisited ? 2.5 : 1}
                  markerEnd={marker}
                  opacity={isVisited ? 1 : 0.4}
                />
                {branch.label && (
                  <text
                    x={mx} y={my}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={9}
                    fill={color}
                    opacity={isVisited ? 1 : 0.5}
                    style={{ userSelect: "none" }}
                  >
                    {branch.label.length > 18 ? branch.label.slice(0, 17) + "…" : branch.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {tree.nodes.map((node: CaseNode) => {
            const style = nodeStyle(node, visited, node.id === lastVisited);
            const isVisited = visited.has(node.id);
            const badge = endNodeBadge(node);
            const hasInfo = !!(node.description || badge);
            return (
              <g
                key={node.id}
                style={{ cursor: hasInfo ? "pointer" : "default" }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleNodeClick(node, node.x + NODE_W / 2, node.y);
                }}
              >
                <rect
                  x={node.x}
                  y={node.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                  fill={style.fill}
                  stroke={style.stroke}
                  strokeWidth={style.strokeWidth}
                  opacity={style.opacity}
                />
                {/* Visited pulse ring */}
                {isVisited && (
                  <rect
                    x={node.x - 3}
                    y={node.y - 3}
                    width={NODE_W + 6}
                    height={NODE_H + 6}
                    rx={13}
                    fill="none"
                    stroke="#93c5fd"
                    strokeWidth={1.5}
                    opacity={0.5}
                  />
                )}
                {/* Corner labels */}
                {node.isRoot && (
                  <text x={node.x + 7} y={node.y + 13} fontSize={8} fill={style.textColor} fontWeight="700" opacity={style.opacity}>ROOT</text>
                )}
                {node.isEnd && (
                  <text x={node.x + NODE_W - 7} y={node.y + 13} fontSize={8} fill={style.textColor} fontWeight="700" textAnchor="end" opacity={style.opacity}>END</text>
                )}
                {/* Node label */}
                <text
                  x={node.x + NODE_W / 2}
                  y={node.y + NODE_H / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={11}
                  fontWeight={isVisited ? "700" : "500"}
                  fill={style.textColor}
                  opacity={style.opacity}
                  style={{ pointerEvents: "none", userSelect: "none" }}
                >
                  {node.label.length > 18 ? node.label.slice(0, 17) + "…" : node.label}
                </text>
                {/* Info indicator for nodes with coaching note */}
                {hasInfo && (
                  <circle
                    cx={node.x + NODE_W - 8}
                    cy={node.y + NODE_H - 8}
                    r={5}
                    fill={isVisited ? "#3b82f6" : "#cbd5e1"}
                    opacity={style.opacity}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Tooltip panel — shown when a node is clicked */}
      {tooltip && (
        <div className="mx-5 mb-4 mt-0 p-3 rounded-xl border border-red-200 dark:border-red-700 bg-card shadow-sm space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-foreground">{tooltip.node.label}</p>
            {endNodeBadge(tooltip.node) && (
              <span className={cn(
                "text-[10px] font-semibold px-2 py-0.5 rounded-full border",
                endNodeBadgeColor(tooltip.node)
              )}>
                {endNodeBadge(tooltip.node)}
              </span>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setTooltip(null); }}
              className="text-muted-foreground hover:text-foreground text-xs ml-auto"
            >
              ✕
            </button>
          </div>
          {tooltip.node.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{tooltip.node.description}</p>
          )}
          {!tooltip.node.description && !endNodeBadge(tooltip.node) && (
            <p className="text-xs text-muted-foreground italic">No coaching note added for this node.</p>
          )}
        </div>
      )}

      {/* Footer summary */}
      <div className="px-5 py-3 border-t border-red-200/60 dark:border-red-800/50 bg-red-50/40 dark:bg-red-950/10">
        <p className="text-[10px] text-muted-foreground">
          💡 Click any node to see the coaching note. Blue nodes = decisions you made. Gray = paths not taken.
        </p>
      </div>
    </div>
  );
}
