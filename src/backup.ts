import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Tool, toolFiles } from "./paths";

const MAX_BACKUPS = 10;
const CAPTURED_KEY = "zion.originalsCaptured"; // Record<Tool, boolean>

/** Copy a file to `<path>.zion-bak-<ISO>`; prune to the most recent MAX_BACKUPS. No-op if file is missing. */
export function backupFile(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${filePath}.zion-bak-${ts}`;
  fs.copyFileSync(filePath, dest);
  pruneBackups(filePath);
  return dest;
}

function pruneBackups(filePath: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const prefix = `${base}.zion-bak-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
  } catch {
    return;
  }
  if (entries.length <= MAX_BACKUPS) {
    return;
  }
  // Names sort lexicographically in timestamp order (ISO).
  entries.sort();
  const toDelete = entries.slice(0, entries.length - MAX_BACKUPS);
  for (const f of toDelete) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
}

/** Directory under globalStorage holding the pristine snapshot for a tool. */
function originalsDir(context: vscode.ExtensionContext, tool: Tool): string {
  return path.join(context.globalStorageUri.fsPath, "originals", tool);
}

/**
 * Read the captured snapshot of a specific config file (by basename) for a tool.
 * Returns undefined if no snapshot exists or it was recorded as originally absent.
 */
export function readSnapshot(
  context: vscode.ExtensionContext,
  tool: Tool,
  basename: string
): string | undefined {
  const snap = path.join(originalsDir(context, tool), basename);
  if (fs.existsSync(`${snap}.absent`)) {
    return undefined;
  }
  try {
    return fs.readFileSync(snap, "utf8");
  } catch {
    return undefined;
  }
}

function capturedMap(context: vscode.ExtensionContext): Record<string, boolean> {
  return context.globalState.get<Record<string, boolean>>(CAPTURED_KEY, {});
}

export function isOriginalCaptured(context: vscode.ExtensionContext, tool: Tool): boolean {
  return capturedMap(context)[tool] === true;
}

/**
 * Snapshot the tool's current config files into globalStorage as the "original".
 * Overwrites any prior snapshot. Files that don't exist are recorded as absent
 * (so restore can delete a file that originally wasn't there).
 */
export async function captureOriginal(context: vscode.ExtensionContext, tool: Tool): Promise<void> {
  const files = toolFiles(tool, context);
  // No files to snapshot (e.g. an unresolved-path tool like Open Claw before its
  // config location is known). Do NOT mark captured: a true flag with an empty
  // snapshot makes a later "restore" a silent no-op while the UI claims native.
  // Leaving it false lets restoreNativeConfig fall back to removeGateway and lets
  // capture retry once a real config exists.
  if (files.length === 0) {
    return;
  }
  const destDir = originalsDir(context, tool);
  fs.mkdirSync(destDir, { recursive: true });
  for (const src of files) {
    const name = path.basename(src);
    const snap = path.join(destDir, name);
    const marker = `${snap}.absent`;
    // Clean prior state for this file.
    try { fs.unlinkSync(snap); } catch { /* ignore */ }
    try { fs.unlinkSync(marker); } catch { /* ignore */ }
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, snap);
    } else {
      fs.writeFileSync(marker, "");
    }
  }
  const map = capturedMap(context);
  map[tool] = true;
  // Await so the "captured" flag is persisted before we return, otherwise a
  // crash right after snapshotting could leave the flag unset and re-capture a
  // gateway config as "native" on next launch.
  await context.globalState.update(CAPTURED_KEY, map);
}

/** Capture the original on first touch only; safe to call on every activation. */
export async function captureOriginalIfNeeded(context: vscode.ExtensionContext, tool: Tool): Promise<void> {
  if (!isOriginalCaptured(context, tool)) {
    await captureOriginal(context, tool);
  }
}

/** Delete all `<config>.zion-bak-*` files this extension wrote for a tool. Returns count removed. */
export function purgeBackups(context: vscode.ExtensionContext, tool: Tool): number {
  let removed = 0;
  for (const filePath of toolFiles(tool, context)) {
    const dir = path.dirname(filePath);
    const prefix = `${path.basename(filePath)}.zion-bak-`;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
    } catch {
      continue;
    }
    for (const f of entries) {
      try {
        fs.unlinkSync(path.join(dir, f));
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

/** Forget the captured "Original" snapshot for a tool (globalStorage + flag). */
export function forgetOriginal(context: vscode.ExtensionContext, tool: Tool): void {
  const dir = originalsDir(context, tool);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const map = capturedMap(context);
  delete map[tool];
  void context.globalState.update(CAPTURED_KEY, map);
}

/**
 * Restore the tool's files verbatim from the original snapshot.
 * Backs up the current files first. Throws if no snapshot exists.
 */
export function restoreOriginal(context: vscode.ExtensionContext, tool: Tool): void {
  if (!isOriginalCaptured(context, tool)) {
    throw new Error(`No original snapshot captured for ${tool}.`);
  }
  const dir = originalsDir(context, tool);
  for (const target of toolFiles(tool, context)) {
    const name = path.basename(target);
    const snap = path.join(dir, name);
    const marker = `${snap}.absent`;
    backupFile(target);
    if (fs.existsSync(marker)) {
      // File originally absent → remove current if present.
      try { fs.unlinkSync(target); } catch { /* ignore */ }
    } else if (fs.existsSync(snap)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(snap, target);
    }
  }
}
