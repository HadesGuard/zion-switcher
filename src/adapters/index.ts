import { ToolAdapter, ToolId } from "./types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { openclawAdapter } from "./openclaw";
import { hermesAdapter } from "./hermes";

/**
 * The registry of tools the extension supports. Order is the display order in
 * the switch menu. Add a tool by writing one adapter and appending it here.
 */
export const ADAPTERS: ToolAdapter[] = [
  claudeAdapter,
  codexAdapter,
  openclawAdapter,
  hermesAdapter,
];

const BY_ID = new Map<ToolId, ToolAdapter>(ADAPTERS.map((a) => [a.id, a]));

/** Look up an adapter by id. Throws if unknown (a programming error). */
export function getAdapter(id: ToolId): ToolAdapter {
  const a = BY_ID.get(id);
  if (!a) {
    throw new Error(`Unknown tool: ${id}`);
  }
  return a;
}

/** Look up an adapter by id, or undefined for an unknown/legacy id. */
export function findAdapter(id: ToolId): ToolAdapter | undefined {
  return BY_ID.get(id);
}

/** All tool ids, in display order. Replaces the old hardcoded TOOLS array. */
export const TOOLS: ToolId[] = ADAPTERS.map((a) => a.id);

/** Tool id → human label. Replaces the old hardcoded TOOL_LABELS record. */
export const TOOL_LABELS: Record<ToolId, string> = Object.fromEntries(
  ADAPTERS.map((a) => [a.id, a.label])
);

