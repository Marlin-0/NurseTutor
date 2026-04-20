import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { CaseTree, CaseNode, CaseBranch, NodeConsequence } from "../types/case";
import { defaultPatientProfile } from "../types/case";
import CaseMediaPanel from "./CaseMediaPanel";
import CasePatientPanel from "./CasePatientPanel";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }

// ─── Main-track helpers ───────────────────────────────────────────────────────

/** Ordered spine from root → end, following mainTrack branches */
function getMainTrackChain(nodes: CaseNode[], branches: CaseBranch[]): CaseNode[] {
  const root = nodes.find(n => n.isRoot);
  if (!root) return [];
  const chain: CaseNode[] = [root];
  const visited = new Set<string>([root.id]);
  let current = root;
  while (true) {
    const next = branches.find(b => b.fromNodeId === current.id && b.mainTrack);
    if (!next) break;
    const node = nodes.find(n => n.id === next.toNodeId);
    if (!node || visited.has(node.id)) break;
    visited.add(node.id);
    chain.push(node);
    current = node;
  }
  return chain;
}

/**
 * Direct branch (non-main-track) children of a node.
 * mainTrackIds: if provided, excludes nodes that are already on the main track
 * (those are shown as reconnect badges instead, to avoid duplicate rendering).
 */
function getBranchChildren(
  nodeId: string,
  nodes: CaseNode[],
  branches: CaseBranch[],
  mainTrackIds?: Set<string>,
): CaseNode[] {
  return branches
    .filter(b => b.fromNodeId === nodeId && !b.mainTrack)
    .map(b => nodes.find(n => n.id === b.toNodeId))
    .filter((n): n is CaseNode => n !== undefined)
    .filter(n => !mainTrackIds || !mainTrackIds.has(n.id));
}

/**
 * Migration: if no branch has mainTrack=true, walk root → first outgoing branch
 * at each step and mark those as mainTrack:true. Returns updated branches array.
 */
function autoDetectMainTrack(nodes: CaseNode[], branches: CaseBranch[]): CaseBranch[] {
  if (branches.some(b => b.mainTrack)) return branches;
  const root = nodes.find(n => n.isRoot);
  if (!root) return branches;
  const toMark = new Set<string>();
  const visited = new Set<string>([root.id]);
  let currentId = root.id;
  while (true) {
    const first = branches.find(b => b.fromNodeId === currentId);
    if (!first || visited.has(first.toNodeId)) break;
    toMark.add(first.id);
    visited.add(first.toNodeId);
    currentId = first.toNodeId;
  }
  if (toMark.size === 0) return branches;
  return branches.map(b => toMark.has(b.id) ? { ...b, mainTrack: true } : b);
}

// ─── Node card ────────────────────────────────────────────────────────────────

type ConnectState = "source" | "target" | "normal";

function NodeCard({
  node,
  selected,
  isMainTrack,
  connectState = "normal",
  onClick,
}: {
  node: CaseNode;
  selected: boolean;
  isMainTrack: boolean;
  connectState?: ConnectState;
  onClick: () => void;
}) {
  const endBorder =
    node.isEnd && node.outcome === "good" ? "border-b-emerald-500 border-b-[3px]" :
    node.isEnd && node.outcome === "poor" ? "border-b-red-500 border-b-[3px]" :
    node.isEnd                            ? "border-b-amber-400 border-b-[3px]" : "";

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "relative rounded-xl cursor-pointer transition-all select-none",
        "border",
        isMainTrack
          ? "w-40 bg-white dark:bg-slate-800 border-border shadow-sm border-t-[3px] border-t-brand-500"
          : "w-36 bg-slate-50 dark:bg-slate-900/80 border-dashed border-orange-300 dark:border-orange-700",
        endBorder,
        selected && "ring-2 ring-blue-500 ring-offset-2",
        connectState === "source" && "ring-2 ring-blue-400 ring-offset-1",
        connectState === "target" && "ring-2 ring-emerald-400 ring-dashed cursor-crosshair opacity-90 hover:opacity-100",
      )}
    >
      {/* Top badges */}
      <div className="absolute top-1.5 left-2 right-2 flex items-center justify-between gap-1 pointer-events-none">
        <div className="flex items-center gap-1">
          {node.isRoot && (
            <span className="text-[8px] font-bold bg-brand-100 text-brand-700 dark:bg-brand-900/60 dark:text-brand-300 px-1 py-px rounded leading-none">
              ROOT
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          {(node.consequences?.length ?? 0) > 0 && (
            <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" title="Has deterioration events" />
          )}
          {node.isEnd && (
            <span className={cn(
              "text-[8px] font-bold px-1 py-px rounded leading-none",
              node.outcome === "good" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" :
              node.outcome === "poor" ? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300" :
              "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
            )}>
              END
            </span>
          )}
        </div>
      </div>

      {/* Label */}
      <div className="pt-6 pb-3 px-2.5 flex items-center justify-center min-h-[4rem]">
        <p className={cn(
          "text-center font-semibold leading-tight",
          isMainTrack ? "text-xs text-foreground" : "text-[11px] text-muted-foreground",
          selected && "text-blue-700 dark:text-blue-300",
        )}>
          {node.label.length > 22 ? node.label.slice(0, 21) + "…" : node.label}
        </p>
      </div>

      {/* Connect target hint */}
      {connectState === "target" && (
        <div className="absolute -bottom-5 inset-x-0 text-center pointer-events-none">
          <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400">click to connect</span>
        </div>
      )}
    </div>
  );
}

// ─── Connectors ───────────────────────────────────────────────────────────────

/** Vertical ↓ connector between branch nodes in a sub-chain (orange) */
function BranchVerticalConnector() {
  return (
    <div className="flex flex-col items-center py-0.5 pointer-events-none">
      <div className="w-px h-4 bg-orange-300 dark:bg-orange-700" />
      <svg width="10" height="6" viewBox="0 0 10 6" className="shrink-0">
        <polygon points="5,6 0,0 10,0" className="fill-orange-300 dark:fill-orange-700" />
      </svg>
    </div>
  );
}

/** Horizontal → connector from a main-track node to its first branch (orange) */
function BranchHArrow() {
  return (
    <div className="flex items-center self-start mt-[1.6rem] shrink-0 pointer-events-none">
      <div className="h-px w-5 bg-orange-300 dark:bg-orange-700" />
      <svg width="6" height="10" viewBox="0 0 6 10" className="shrink-0">
        <polygon points="6,5 0,0 0,10" className="fill-orange-300 dark:fill-orange-700" />
      </svg>
    </div>
  );
}

// ─── Branch chain (vertical sub-chain below a branch node) ────────────────────

function BranchChain({
  nodeId,
  nodes,
  branches,
  selection,
  onSelectNode,
  onAddBranch,
  connectingFrom,
  connectExistingNode,
  mainTrackNodeIds,
}: {
  nodeId: string;
  nodes: CaseNode[];
  branches: CaseBranch[];
  selection: Selection;
  onSelectNode: (id: string) => void;
  onAddBranch: (fromNodeId: string) => void;
  connectingFrom: string | null;
  connectExistingNode: (toNodeId: string) => void;
  mainTrackNodeIds: Set<string>;
}) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return null;

  const children = getBranchChildren(nodeId, nodes, branches, mainTrackNodeIds);

  // Reconnect targets: this node has a connection TO a main-track node
  const reconnectTargets = branches
    .filter(b => b.fromNodeId === nodeId && !b.mainTrack && mainTrackNodeIds.has(b.toNodeId))
    .map(b => nodes.find(n => n.id === b.toNodeId))
    .filter((n): n is CaseNode => !!n);

  const isSelected = selection?.kind === "node" && selection.id === nodeId;
  const connectState: ConnectState =
    connectingFrom ? (nodeId === connectingFrom ? "source" : "target") : "normal";

  return (
    <div className="flex flex-row items-start">
      {/* Node card + reconnect badges stacked vertically */}
      <div className="flex flex-col items-center">
        <NodeCard
          node={node}
          selected={isSelected}
          isMainTrack={false}
          connectState={connectState}
          onClick={() => {
            if (connectingFrom) connectExistingNode(nodeId);
            else onSelectNode(nodeId);
          }}
        />

        {/* Reconnect to main track — bracket visual pointing left toward spine */}
        {reconnectTargets.length > 0 && (
          <div className="flex flex-col items-center gap-1 mt-2 w-full">
            {reconnectTargets.map(target => (
              <div key={target.id} className="flex flex-col items-center w-full">
                <div className="w-px h-2.5 bg-blue-400 dark:bg-blue-500" />
                <div className="flex items-center gap-1.5 bg-blue-500 hover:bg-blue-600 text-white text-[9px] font-bold px-2.5 py-1 rounded-lg shadow-sm border border-blue-600 dark:border-blue-400 transition-colors">
                  <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="shrink-0">
                    <path d="M9 4H1.5M1.5 4L4.5 1.5M1.5 4L4.5 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>joins: {target.label.length > 14 ? target.label.slice(0, 13) + "…" : target.label}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Sub-branch vertical chain */}
        {children.map(child => (
          <div key={child.id} className="flex flex-col items-center">
            <BranchVerticalConnector />
            <BranchChain
              nodeId={child.id}
              nodes={nodes}
              branches={branches}
              selection={selection}
              onSelectNode={onSelectNode}
              onAddBranch={onAddBranch}
              connectingFrom={connectingFrom}
              connectExistingNode={connectExistingNode}
              mainTrackNodeIds={mainTrackNodeIds}
            />
          </div>
        ))}
      </div>

      {/* Add-branch button — fixed inline beside this node, never stacks */}
      {!connectingFrom && (
        <button
          onClick={(e) => { e.stopPropagation(); onAddBranch(nodeId); }}
          title="Add a branch from this node"
          className="self-start mt-[1.55rem] ml-1.5 shrink-0 w-6 h-6 rounded-full border-2 border-dashed border-orange-300 dark:border-orange-700 text-orange-400 dark:text-orange-500 hover:border-orange-500 hover:text-orange-600 dark:hover:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center justify-center text-sm font-bold transition-all leading-none"
        >
          +
        </button>
      )}
    </div>
  );
}

// ─── Train track canvas (top-to-bottom spine, branches to the right) ──────────

function TrainTrackCanvas({
  nodes,
  branches,
  selection,
  onSelectNode,
  onSelectBranch: _onSelectBranch,
  addMainTrackNode,
  addBranchNode,
  connectingFrom,
  connectExistingNode,
  onCancelConnect,
}: {
  nodes: CaseNode[];
  branches: CaseBranch[];
  selection: Selection;
  onSelectNode: (id: string) => void;
  onSelectBranch: (id: string) => void;
  addMainTrackNode: () => void;
  addBranchNode: (fromNodeId: string) => void;
  connectingFrom: string | null;
  connectExistingNode: (toNodeId: string) => void;
  onCancelConnect: () => void;
}) {
  const mainChain = getMainTrackChain(nodes, branches);
  const mainTrackNodeIds = new Set(mainChain.map(n => n.id));

  // Map: main-track node ID → branch nodes that reconnect into it
  const reconnectsByTarget = new Map<string, CaseNode[]>();
  for (const b of branches) {
    if (!b.mainTrack && mainTrackNodeIds.has(b.toNodeId)) {
      const src = nodes.find(n => n.id === b.fromNodeId);
      if (src && !mainTrackNodeIds.has(src.id)) {
        const arr = reconnectsByTarget.get(b.toNodeId) ?? [];
        reconnectsByTarget.set(b.toNodeId, [...arr, src]);
      }
    }
  }

  // Build full reachable set for orphan detection
  const reachable = new Set<string>(mainChain.map(n => n.id));
  let frontier = mainChain.map(n => n.id);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const nid of frontier) {
      getBranchChildren(nid, nodes, branches, mainTrackNodeIds).forEach(c => {
        if (!reachable.has(c.id)) { reachable.add(c.id); next.push(c.id); }
      });
    }
    frontier = next;
  }
  const orphans = nodes.filter(n => !reachable.has(n.id));

  return (
    <div
      className="min-h-full p-10 bg-slate-50 dark:bg-slate-900/50 relative"
      style={{ backgroundImage: "radial-gradient(circle, #cbd5e1 0.5px, transparent 0.5px)", backgroundSize: "20px 20px" }}
      onClick={() => { if (connectingFrom) onCancelConnect(); }}
    >
      {/* Connect mode banner */}
      {connectingFrom && (
        <div
          className="fixed top-0 left-0 right-0 z-30 flex items-center justify-between gap-3 px-5 py-2.5 bg-blue-500 text-white text-xs font-semibold shadow-lg"
          onClick={e => e.stopPropagation()}
        >
          <span className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
            </svg>
            Click any node to connect to it — or press Esc to cancel
          </span>
          <button onClick={onCancelConnect} className="text-white/80 hover:text-white font-bold text-base leading-none">✕</button>
        </div>
      )}

      {nodes.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-center">
          <div className="w-12 h-12 rounded-2xl bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center">
            <svg className="w-6 h-6 text-brand-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="5" r="2" /><circle cx="12" cy="19" r="2" />
              <line x1="12" y1="7" x2="12" y2="17" />
              <circle cx="19" cy="12" r="2" /><line x1="14" y1="12" x2="17" y2="12" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-foreground">No steps yet</p>
          <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
            Add the first step on the main track. Each step is a clinical checkpoint the student must complete.
            Branch off any step for deterioration or escalation paths.
          </p>
          <button
            onClick={addMainTrackNode}
            className="mt-2 text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-xl px-5 h-9 font-semibold shadow-sm"
          >
            + Add first step
          </button>
        </div>
      ) : (
        <div className="inline-flex flex-col">

          {/* ── Main track: vertical spine ── */}
          {mainChain.map((node, i) => {
            const isLastNode = i === mainChain.length - 1;
            const branchRoots = getBranchChildren(node.id, nodes, branches, mainTrackNodeIds);
            const isSelected = selection?.kind === "node" && selection.id === node.id;
            const connectState: ConnectState =
              connectingFrom ? (node.id === connectingFrom ? "source" : "target") : "normal";
            const incomingReconnects = reconnectsByTarget.get(node.id) ?? [];

            return (
              // Single flex-row per spine node — no outer wrapper needed
              // self-stretch on left column lets the connector fill the full row height
              <div key={node.id} className="flex flex-row items-start" onClick={e => e.stopPropagation()}>

                {/* ── Left spine column ── fixed width, stretches to fill row height */}
                <div className="w-40 shrink-0 flex flex-col items-center self-stretch">

                  {/* Incoming reconnect badges — shown above the card when branches rejoin here */}
                  {incomingReconnects.length > 0 && (
                    <div className="flex flex-wrap justify-center gap-1 mb-1.5 w-full">
                      {incomingReconnects.map(src => (
                        <div
                          key={src.id}
                          className="flex items-center gap-1 text-[8px] font-bold text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 px-1.5 py-0.5 rounded-full border border-blue-300 dark:border-blue-700"
                        >
                          {/* right-pointing arrow — reconnect arrives from the right */}
                          <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="shrink-0">
                            <path d="M1 3H6.5M6.5 3L4 1M6.5 3L4 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {src.label.length > 11 ? src.label.slice(0, 10) + "…" : src.label}
                        </div>
                      ))}
                    </div>
                  )}

                  <NodeCard
                    node={node}
                    selected={isSelected}
                    isMainTrack={true}
                    connectState={connectState}
                    onClick={() => {
                      if (connectingFrom) connectExistingNode(node.id);
                      else onSelectNode(node.id);
                    }}
                  />

                  {/* Stretchy connector OR add-step button — fills remaining row height */}
                  {!isLastNode ? (
                    <div className="flex-1 flex flex-col items-center pt-1.5 min-h-[2.5rem]">
                      <div className="flex-1 w-px bg-brand-300 dark:bg-brand-600" />
                      <svg width="10" height="6" viewBox="0 0 10 6" className="shrink-0 mb-px">
                        <polygon points="5,6 0,0 10,0" className="fill-brand-300 dark:fill-brand-600" />
                      </svg>
                    </div>
                  ) : !connectingFrom ? (
                    <div className="flex flex-col items-center mt-3 gap-1">
                      <div className="w-px h-3 bg-brand-300 dark:bg-brand-600" />
                      <button
                        onClick={addMainTrackNode}
                        className="text-xs text-brand-600 hover:text-brand-700 dark:text-brand-400 font-semibold border border-dashed border-brand-400 rounded-xl px-3 h-8 transition-all hover:bg-brand-50 dark:hover:bg-brand-950/20 flex items-center gap-1.5 whitespace-nowrap"
                      >
                        ↓ Add step
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* ── Add-branch button — fixed position next to node card ── */}
                {!connectingFrom && (
                  <button
                    onClick={() => addBranchNode(node.id)}
                    title="Add a branch from this step"
                    className="self-start mt-[1.55rem] mx-2 shrink-0 w-6 h-6 rounded-full border-2 border-dashed border-orange-300 dark:border-orange-700 text-orange-400 dark:text-orange-500 hover:border-orange-500 hover:text-orange-600 dark:hover:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center justify-center text-sm font-bold transition-all leading-none"
                  >
                    +
                  </button>
                )}

                {/* ── Right: branch chains ── */}
                <div className="flex flex-col items-start pt-1.5 gap-2">
                  {branchRoots.map(branchRoot => (
                    <div key={branchRoot.id} className="flex flex-row items-start">
                      <BranchHArrow />
                      <BranchChain
                        nodeId={branchRoot.id}
                        nodes={nodes}
                        branches={branches}
                        selection={selection}
                        onSelectNode={(id) => {
                          if (connectingFrom) connectExistingNode(id);
                          else onSelectNode(id);
                        }}
                        onAddBranch={addBranchNode}
                        connectingFrom={connectingFrom}
                        connectExistingNode={connectExistingNode}
                        mainTrackNodeIds={mainTrackNodeIds}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* No root node warning */}
          {mainChain.length === 0 && nodes.length > 0 && !connectingFrom && (
            <div className="flex items-center gap-3 p-4 border border-dashed border-border rounded-xl bg-muted/30">
              <p className="text-xs text-muted-foreground">No root node set — mark a node as root in its Settings tab.</p>
            </div>
          )}

          {/* ── Orphan nodes ── */}
          {orphans.length > 0 && (
            <div className="border-t border-dashed border-border/60 pt-6 mt-8">
              <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-4">
                Unconnected nodes
              </p>
              <div className="flex flex-row flex-wrap gap-3">
                {orphans.map(node => {
                  const connectState: ConnectState =
                    connectingFrom ? (node.id === connectingFrom ? "source" : "target") : "normal";
                  return (
                    <NodeCard
                      key={node.id}
                      node={node}
                      selected={selection?.kind === "node" && selection.id === node.id}
                      isMainTrack={false}
                      connectState={connectState}
                      onClick={() => {
                        if (connectingFrom) connectExistingNode(node.id);
                        else onSelectNode(node.id);
                      }}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Consequences editor ──────────────────────────────────────────────────────

function ConsequencesEditor({
  consequences,
  onChange,
  branchNodes,
}: {
  consequences: NodeConsequence[];
  onChange: (updated: NodeConsequence[]) => void;
  branchNodes: CaseNode[];
}) {
  function addConsequence() {
    onChange([
      ...consequences,
      { id: uid(), afterTurns: 3, description: "", severity: "warning" },
    ]);
  }

  function updateConsequence(id: string, patch: Partial<NodeConsequence>) {
    onChange(consequences.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function deleteConsequence(id: string) {
    onChange(consequences.filter((c) => c.id !== id));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Deterioration Events
        </label>
        <button
          onClick={addConsequence}
          className="text-[10px] text-brand-500 hover:text-brand-700 font-semibold"
        >
          + Add
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        If the student stays too long without completing this step, the AI narrates the event and routes them to the linked branch node.
      </p>

      {consequences.length === 0 && (
        <p className="text-[10px] text-muted-foreground italic">No events — student can stay as long as needed</p>
      )}

      <div className="space-y-2">
        {consequences.map((c) => {
          const linkedNode = branchNodes.find(n => n.id === c.linkedNodeId);
          return (
            <div key={c.id} className={cn(
              "border rounded-lg p-2.5 space-y-2",
              c.linkedNodeId
                ? "border-orange-300 dark:border-orange-700 bg-orange-50/40 dark:bg-orange-950/10"
                : "border-border bg-muted/20"
            )}>
              {/* Row 1: turns + severity + delete */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground shrink-0">After</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={c.afterTurns}
                  onChange={(e) => updateConsequence(c.id, { afterTurns: parseInt(e.target.value) || 1 })}
                  className="w-12 text-xs border border-border rounded px-1.5 h-6 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 text-center"
                />
                <span className="text-[10px] text-muted-foreground shrink-0">turns</span>
                <select
                  value={c.severity}
                  onChange={(e) => updateConsequence(c.id, { severity: e.target.value as NodeConsequence["severity"] })}
                  className="flex-1 text-[10px] border border-border rounded px-1.5 h-6 bg-background focus:outline-none"
                >
                  <option value="warning">Warning</option>
                  <option value="deterioration">Deterioration</option>
                  <option value="critical">Critical</option>
                </select>
                <button
                  onClick={() => deleteConsequence(c.id)}
                  className="text-[10px] text-red-400 hover:text-red-600"
                >
                  ✕
                </button>
              </div>

              {/* Row 2: description */}
              <textarea
                value={c.description}
                onChange={(e) => updateConsequence(c.id, { description: e.target.value })}
                placeholder="e.g. Patient's O2 drops to 88%, becomes more dyspneic and anxious"
                rows={2}
                className="w-full text-[10px] border border-border rounded px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none leading-relaxed"
              />

              {/* Row 3: route-to selector */}
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground shrink-0">Route to</span>
                  <select
                    value={c.linkedNodeId ?? ""}
                    onChange={(e) =>
                      updateConsequence(c.id, {
                        linkedNodeId: e.target.value === "" ? undefined : e.target.value,
                      })
                    }
                    className="flex-1 text-[10px] border border-border rounded px-1.5 h-6 bg-background focus:outline-none focus:ring-1 focus:ring-orange-400"
                  >
                    <option value="">— narrate only, no routing —</option>
                    {branchNodes.map((n) => (
                      <option key={n.id} value={n.id}>{n.label || "(unlabelled node)"}</option>
                    ))}
                  </select>
                </div>
                {/* Confirmation label when a node is linked */}
                {linkedNode && (
                  <p className="text-[9px] font-semibold text-orange-600 dark:text-orange-400 flex items-center gap-1">
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="shrink-0">
                      <path d="M1 4H6.5M6.5 4L4 2M6.5 4L4 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Student will be routed to: <span className="font-bold">{linkedNode.label}</span>
                  </p>
                )}
                {branchNodes.length === 0 && (
                  <p className="text-[9px] text-muted-foreground italic">Add a branch node to this step first to enable routing.</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Selection type ───────────────────────────────────────────────────────────

type Selection =
  | { kind: "node"; id: string }
  | { kind: "branch"; id: string }
  | null;

type NodeSubTab = "clinical" | "settings";

// ─── Properties panel ─────────────────────────────────────────────────────────

function PropertiesPanel({
  selection,
  nodes,
  branches,
  mainTrackNodeIds,
  onUpdateNode,
  onUpdateBranch,
  onDeleteNode,
  onDeleteBranch,
  onAddBranchNode,
  onSelectBranch,
  connectingFrom,
  onStartConnect,
}: {
  selection: Selection;
  nodes: CaseNode[];
  branches: CaseBranch[];
  mainTrackNodeIds: Set<string>;
  onUpdateNode: (id: string, patch: Partial<CaseNode>) => void;
  onUpdateBranch: (id: string, patch: Partial<CaseBranch>) => void;
  onDeleteNode: (id: string) => void;
  onDeleteBranch: (id: string) => void;
  onAddBranchNode: (fromNodeId: string) => void;
  onSelectBranch: (id: string) => void;
  connectingFrom: string | null;
  onStartConnect: (fromNodeId: string) => void;
}) {
  const [nodeTab, setNodeTab] = useState<NodeSubTab>("clinical");

  if (!selection) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 gap-2">
        <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
          <svg className="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </div>
        <p className="text-xs text-muted-foreground">Click a node or branch to edit its properties</p>
      </div>
    );
  }

  if (selection.kind === "node") {
    const node = nodes.find((n) => n.id === selection.id);
    if (!node) return null;

    const outgoingBranches = branches.filter(b => b.fromNodeId === node.id);
    const isOnMainTrack = mainTrackNodeIds.has(node.id);

    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="shrink-0 px-4 pt-4 pb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-xs font-bold text-foreground uppercase tracking-wide shrink-0">Node</p>
            <span className={cn(
              "text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider shrink-0",
              isOnMainTrack
                ? "bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300"
                : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
            )}>
              {isOnMainTrack ? "Main track" : "Branch"}
            </span>
          </div>
          <button
            onClick={() => onDeleteNode(node.id)}
            className="text-[10px] text-red-400 hover:text-red-600 font-semibold border border-red-200 rounded px-1.5 py-0.5 hover:bg-red-50 transition-all shrink-0"
          >
            Delete
          </button>
        </div>

        {/* Sub-tab switcher */}
        <div className="shrink-0 px-4 pb-2">
          <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30">
            <button
              onClick={() => setNodeTab("clinical")}
              className={cn(
                "flex-1 text-[11px] rounded-md px-2 h-6 font-semibold transition-all",
                nodeTab === "clinical"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Clinical
            </button>
            <button
              onClick={() => setNodeTab("settings")}
              className={cn(
                "flex-1 text-[11px] rounded-md px-2 h-6 font-semibold transition-all flex items-center justify-center gap-1",
                nodeTab === "settings"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Settings
              {(node.consequences?.length ?? 0) > 0 && (
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-orange-500 text-white text-[8px] font-bold">
                  {node.consequences?.length}
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">

          {/* ── Clinical tab ── */}
          {nodeTab === "clinical" && (
            <>
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Label</label>
                <p className="text-[10px] text-muted-foreground">Short name shown on the canvas node</p>
                <input
                  value={node.label}
                  onChange={(e) => onUpdateNode(node.id, { label: e.target.value })}
                  placeholder="e.g. Assess Respiratory"
                  className="w-full text-xs border border-border rounded-lg px-2.5 h-8 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Situation</label>
                <p className="text-[10px] text-muted-foreground">Clinical description of what's happening right now — the challenge the student faces</p>
                <textarea
                  value={node.situation}
                  onChange={(e) => onUpdateNode(node.id, { situation: e.target.value })}
                  placeholder="e.g. Patient is increasingly short of breath. SpO₂ is 92% and dropping."
                  rows={4}
                  className="w-full text-xs border border-border rounded-lg px-2.5 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none leading-relaxed"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Completion Criteria</label>
                <p className="text-[10px] text-muted-foreground">What must the student do or say to complete this node?</p>
                <textarea
                  value={node.completionCriteria}
                  onChange={(e) => onUpdateNode(node.id, { completionCriteria: e.target.value })}
                  placeholder="e.g. Student assesses lung sounds, checks respiratory rate, or requests supplemental oxygen"
                  rows={3}
                  className="w-full text-xs border border-border rounded-lg px-2.5 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none leading-relaxed"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Completion Narration</label>
                <p className="text-[10px] text-muted-foreground">What the AI narrates when the student hits this checkpoint</p>
                <textarea
                  value={node.completionNarration}
                  onChange={(e) => onUpdateNode(node.id, { completionNarration: e.target.value })}
                  placeholder="e.g. Your colleague nods: 'Good call — I'm hearing decreased air entry on the right side.'"
                  rows={3}
                  className="w-full text-xs border border-border rounded-lg px-2.5 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none leading-relaxed"
                />
              </div>
            </>
          )}

          {/* ── Settings tab ── */}
          {nodeTab === "settings" && (
            <>
              <div className="flex items-start gap-3 py-1">
                <label className="flex items-center gap-2 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={node.required}
                    onChange={(e) => onUpdateNode(node.id, { required: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-xs text-foreground font-medium">Required</span>
                </label>
                <span className="text-[10px] text-muted-foreground leading-snug">
                  {node.required ? "Missed = consequences apply" : "Optional — no penalty if skipped"}
                </span>
              </div>

              <ConsequencesEditor
                consequences={node.consequences ?? []}
                onChange={(updated) => onUpdateNode(node.id, { consequences: updated })}
                branchNodes={nodes.filter(n => !mainTrackNodeIds.has(n.id) && n.id !== node.id)}
              />

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Coaching Note</label>
                <p className="text-[10px] text-muted-foreground">Shown to student post-case on hover</p>
                <textarea
                  value={node.description}
                  onChange={(e) => onUpdateNode(node.id, { description: e.target.value })}
                  placeholder="e.g. Assessing respiratory status first is the correct priority because…"
                  rows={3}
                  className="w-full text-xs border border-border rounded-lg px-2.5 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none leading-relaxed"
                />
              </div>

              {/* End node settings */}
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={node.isEnd}
                    onChange={(e) => onUpdateNode(node.id, { isEnd: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-xs text-foreground font-medium">End node</span>
                </label>

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
                              ? o === "good"  ? "bg-emerald-500 text-white border-emerald-500"
                              : o === "poor"  ? "bg-red-500 text-white border-red-500"
                              :                "bg-amber-400 text-white border-amber-400"
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
            </>
          )}

          {/* ── Branches section (always visible) ── */}
          <div className="pt-2 space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Branches</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {outgoingBranches.length === 0 && (
              <p className="text-[10px] text-muted-foreground italic">No branches from this node yet</p>
            )}

            <div className="space-y-1.5">
              {outgoingBranches.map((b) => {
                const targetNode = nodes.find(n => n.id === b.toNodeId);
                return (
                  <button
                    key={b.id}
                    onClick={() => onSelectBranch(b.id)}
                    className="w-full text-left border border-border rounded-lg px-2.5 py-2 hover:border-brand-400 hover:bg-brand-50/40 dark:hover:bg-brand-950/20 transition-all group"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={cn(
                        "text-[8px] font-bold px-1 rounded shrink-0",
                        b.mainTrack
                          ? "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                          : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
                      )}>
                        {b.mainTrack ? "MAIN" : "BRANCH"}
                      </span>
                      <p className="text-[11px] font-semibold text-foreground group-hover:text-brand-700 dark:group-hover:text-brand-300 truncate">
                        → {targetNode?.label ?? "Unknown"}
                      </p>
                    </div>
                    {b.label && (
                      <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{b.label}</p>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Add branch button */}
            <button
              onClick={() => onAddBranchNode(node.id)}
              className="w-full text-xs border border-dashed border-orange-300 dark:border-orange-700 text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-950/20 rounded-lg px-3 h-8 font-semibold transition-all"
            >
              → Add branch
            </button>

            {/* Connect back to track (for branch nodes only) */}
            {!isOnMainTrack && (
              <button
                onClick={() => onStartConnect(node.id)}
                className={cn(
                  "w-full text-xs rounded-lg px-3 h-8 font-semibold transition-all flex items-center justify-center gap-1.5",
                  connectingFrom === node.id
                    ? "bg-blue-500 text-white border border-blue-500"
                    : "border border-dashed border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20"
                )}
              >
                {connectingFrom === node.id
                  ? "Click any node to connect…"
                  : "↗ Connect to another node"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Branch selected ──
  const branch = branches.find((b) => b.id === selection.id);
  if (!branch) return null;
  const fromNode = nodes.find((n) => n.id === branch.fromNodeId);
  const toNode   = nodes.find((n) => n.id === branch.toNodeId);

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-xs font-bold text-foreground uppercase tracking-wide">Branch</p>
          <span className={cn(
            "text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider",
            branch.mainTrack
              ? "bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300"
              : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300"
          )}>
            {branch.mainTrack ? "Main track" : "Side branch"}
          </span>
        </div>
        <button
          onClick={() => onDeleteBranch(branch.id)}
          className="text-[10px] text-red-400 hover:text-red-600 font-semibold border border-red-200 rounded px-1.5 py-0.5 hover:bg-red-50 transition-all"
        >
          Delete
        </button>
      </div>

      {fromNode && toNode && (
        <p className="text-[10px] text-muted-foreground">
          <span className="font-semibold text-foreground">{fromNode.label}</span>
          {" → "}
          <span className="font-semibold text-foreground">{toNode.label}</span>
        </p>
      )}

      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Arrow Label</label>
        <p className="text-[10px] text-muted-foreground">Short text shown on the branch indicator</p>
        <input
          value={branch.label}
          onChange={(e) => onUpdateBranch(branch.id, { label: e.target.value })}
          placeholder="e.g. Patient worsens"
          className="w-full text-xs border border-border rounded-lg px-2.5 h-8 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">AI Trigger Phrase</label>
        <p className="text-[10px] text-muted-foreground">
          Natural language — the AI uses this to detect when a student's action takes this branch
        </p>
        <textarea
          value={branch.triggerPhrase}
          onChange={(e) => onUpdateBranch(branch.id, { triggerPhrase: e.target.value })}
          placeholder="e.g. Student asks about or assesses respiratory system, breathing, lung sounds, or oxygen saturation"
          rows={4}
          className="w-full text-xs border border-border rounded-lg px-2.5 py-2 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none leading-relaxed"
        />
      </div>

      {/* Auto-trigger on idle */}
      <div className="space-y-1 pt-2 border-t border-border">
        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Auto-trigger on idle
        </label>
        <p className="text-[10px] text-muted-foreground">
          If set, this branch fires automatically once the student spends this many turns on the source node without triggering another branch.
        </p>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={branch.autoTriggerAfterTurns !== undefined}
              onChange={(e) =>
                onUpdateBranch(branch.id, {
                  autoTriggerAfterTurns: e.target.checked ? 3 : undefined,
                })
              }
              className="rounded"
            />
            <span className="text-xs text-foreground font-medium">Enabled</span>
          </label>
          {branch.autoTriggerAfterTurns !== undefined && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-muted-foreground">after</span>
              <input
                type="number"
                min={1}
                max={20}
                value={branch.autoTriggerAfterTurns}
                onChange={(e) =>
                  onUpdateBranch(branch.id, {
                    autoTriggerAfterTurns: Math.max(1, parseInt(e.target.value) || 1),
                  })
                }
                className="w-14 text-xs border border-border rounded-lg px-2 h-7 bg-background focus:outline-none focus:ring-1 focus:ring-brand-400 tabular-nums"
              />
              <span className="text-[10px] text-muted-foreground">turns</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main CaseCanvas component ────────────────────────────────────────────────

type CanvasTab = "canvas" | "patient" | "files";

export default function CaseCanvas({
  tree,
  onChange,
  onBack,
}: {
  tree: CaseTree;
  onChange: (updated: CaseTree) => void;
  onBack: () => void;
}) {
  const [nodes, setNodes]         = useState<CaseNode[]>(tree.nodes);
  const [branches, setBranches]   = useState<CaseBranch[]>(() => autoDetectMainTrack(tree.nodes, tree.branches));
  const [selection, setSelection] = useState<Selection>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [caseTitle, setCaseTitle] = useState(tree.title);
  const [caseDiagnosis, setCaseDiagnosis] = useState(tree.diagnosis);
  const [caseDescription, setCaseDescription] = useState(tree.description);
  const [activeTab, setActiveTab] = useState<CanvasTab>("canvas");

  // Sync up to parent on every mutation
  useEffect(() => {
    onChange({
      ...tree,
      title: caseTitle,
      diagnosis: caseDiagnosis,
      description: caseDescription,
      nodes,
      branches,
      updatedAt: new Date().toISOString(),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, branches, caseTitle, caseDiagnosis, caseDescription]);

  // Escape cancels connect mode
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setConnectingFrom(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Main track node IDs (for Properties Panel badge) ──
  const mainTrackNodeIds = new Set(getMainTrackChain(nodes, branches).map(n => n.id));

  // ── Mutations ──

  function addMainTrackNode() {
    const chain = getMainTrackChain(nodes, branches);
    const lastNode = chain[chain.length - 1];
    const newId = uid();
    const newNode: CaseNode = {
      id: newId,
      label: "New Step",
      situation: "",
      completionCriteria: "",
      completionNarration: "",
      required: true,
      consequences: [],
      description: "",
      x: 0,
      y: 0,
      isRoot: chain.length === 0,
      isEnd: false,
    };
    const newBranch: CaseBranch | null = lastNode
      ? { id: uid(), fromNodeId: lastNode.id, toNodeId: newId, label: "", triggerPhrase: "", mainTrack: true }
      : null;
    setNodes(prev => [...prev, newNode]);
    if (newBranch) setBranches(prev => [...prev, newBranch]);
    setSelection({ kind: "node", id: newId });
  }

  function addBranchNode(fromNodeId: string) {
    const newId = uid();
    const newNode: CaseNode = {
      id: newId,
      label: "New Branch",
      situation: "",
      completionCriteria: "",
      completionNarration: "",
      required: true,
      consequences: [],
      description: "",
      x: 0,
      y: 0,
      isRoot: false,
      isEnd: false,
    };
    const newBranch: CaseBranch = {
      id: uid(),
      fromNodeId,
      toNodeId: newId,
      label: "",
      triggerPhrase: "",
      mainTrack: false,
    };
    setNodes(prev => [...prev, newNode]);
    setBranches(prev => [...prev, newBranch]);
    setSelection({ kind: "node", id: newId });
  }

  function connectExistingNode(toNodeId: string) {
    if (!connectingFrom || toNodeId === connectingFrom) {
      setConnectingFrom(null);
      return;
    }
    const duplicate = branches.some(b => b.fromNodeId === connectingFrom && b.toNodeId === toNodeId);
    if (!duplicate) {
      const newBranch: CaseBranch = {
        id: uid(),
        fromNodeId: connectingFrom,
        toNodeId,
        label: "",
        triggerPhrase: "",
        mainTrack: false,
      };
      setBranches(prev => [...prev, newBranch]);
      setSelection({ kind: "branch", id: newBranch.id });
    }
    setConnectingFrom(null);
  }

  function deleteNode(id: string) {
    const reachable = new Set<string>([id]);
    let frontier = [id];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const nid of frontier) {
        branches.filter(b => b.fromNodeId === nid).forEach(b => {
          if (!reachable.has(b.toNodeId)) { reachable.add(b.toNodeId); next.push(b.toNodeId); }
        });
      }
      frontier = next;
    }
    const toRemove = new Set<string>([id]);
    for (const nid of reachable) {
      if (nid === id) continue;
      const hasExternal = branches.some(b => b.toNodeId === nid && !reachable.has(b.fromNodeId));
      if (!hasExternal) toRemove.add(nid);
    }
    setNodes(prev => prev.filter(n => !toRemove.has(n.id)));
    setBranches(prev => prev.filter(b => !toRemove.has(b.fromNodeId) && !toRemove.has(b.toNodeId)));
    setSelection(null);
    setConnectingFrom(null);
  }

  function deleteBranch(id: string) {
    setBranches(prev => prev.filter(b => b.id !== id));
    setSelection(null);
  }

  function updateNode(id: string, patch: Partial<CaseNode>) {
    setNodes(prev => prev.map(n => n.id === id ? { ...n, ...patch } : n));
  }

  function updateBranch(id: string, patch: Partial<CaseBranch>) {
    setBranches(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b));
  }

  function handleMediaUpdate(patch: Partial<CaseTree>) {
    onChange({ ...tree, ...patch, updatedAt: new Date().toISOString() });
  }

  const fileCount = (tree.docFiles?.length ?? 0) + (tree.mediaFiles?.length ?? 0);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ── Header ── */}
      <div className="shrink-0 border-b border-border bg-card px-4 py-3 flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-xs text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 h-7 transition-all shrink-0"
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

        {/* Tab switcher */}
        <div className="flex items-center gap-1 border border-border rounded-lg p-0.5 bg-muted/30 shrink-0">
          {(["canvas", "patient", "files"] as CanvasTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "text-xs rounded-md px-3 h-6 font-semibold transition-all flex items-center",
                activeTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab === "canvas" && "Canvas"}
              {tab === "patient" && "Patient"}
              {tab === "files" && (
                <>
                  Files & Media
                  {fileCount > 0 && (
                    <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-brand-500 text-white text-[9px] font-bold">
                      {fileCount}
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>

        {/* Canvas-only: Add step button */}
        {activeTab === "canvas" && (
          <button
            onClick={addMainTrackNode}
            className="text-xs bg-brand-500 hover:bg-brand-600 text-white rounded-lg px-3 h-7 font-semibold transition-all shrink-0"
          >
            + Add step
          </button>
        )}
      </div>

      {/* ── Patient tab ── */}
      {activeTab === "patient" && (
        <div className="flex-1 overflow-hidden">
          <CasePatientPanel
            profile={tree.patientProfile ?? defaultPatientProfile()}
            onChange={(p) => onChange({ ...tree, patientProfile: p, updatedAt: new Date().toISOString() })}
          />
        </div>
      )}

      {/* ── Files & Media tab ── */}
      {activeTab === "files" && (
        <div className="flex-1 overflow-hidden">
          <CaseMediaPanel tree={tree} onUpdate={handleMediaUpdate} />
        </div>
      )}

      {/* ── Canvas tab ── */}
      {activeTab === "canvas" && (
        <div className="flex flex-1 overflow-hidden">
          {/* Track area */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Meta subheader */}
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

            {/* Train track canvas */}
            <div className="flex-1 overflow-auto">
              <TrainTrackCanvas
                nodes={nodes}
                branches={branches}
                selection={selection}
                onSelectNode={(id) => setSelection({ kind: "node", id })}
                onSelectBranch={(id) => setSelection({ kind: "branch", id })}
                addMainTrackNode={addMainTrackNode}
                addBranchNode={addBranchNode}
                connectingFrom={connectingFrom}
                connectExistingNode={connectExistingNode}
                onCancelConnect={() => setConnectingFrom(null)}
              />
            </div>
          </div>

          {/* ── Properties panel ── */}
          <div className="w-72 shrink-0 border-l border-border bg-card overflow-hidden">
            <PropertiesPanel
              selection={selection}
              nodes={nodes}
              branches={branches}
              mainTrackNodeIds={mainTrackNodeIds}
              onUpdateNode={updateNode}
              onUpdateBranch={updateBranch}
              onDeleteNode={deleteNode}
              onDeleteBranch={deleteBranch}
              onAddBranchNode={addBranchNode}
              onSelectBranch={(id) => setSelection({ kind: "branch", id })}
              connectingFrom={connectingFrom}
              onStartConnect={(fromNodeId) =>
                setConnectingFrom(prev => prev === fromNodeId ? null : fromNodeId)
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
