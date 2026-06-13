import * as os from "os";
import * as path from "path";
import type * as vscode from "vscode";

/**
 * A tool's stable id. Was a strict union; now an open string so new tools are
 * added purely by registering an adapter (see ./adapters). The ids "claude" and
 * "codex" are preserved for backward compatibility with stored profiles.
 */
export type Tool = string;

/** Sentinel id meaning "your captured original config" for a tool. */
export const ORIGINAL_ID = "__original__";

/** A user-declared gateway profile (base URL + secret stored separately). */
export interface GatewayProfile {
  id: string;
  tool: Tool;
  label: string;
  baseUrl: string;
  /** For tools that key providers by name (Codex TOML, Open Claw JSON). */
  providerName?: string;
}

function home(): string {
  return os.homedir();
}

/** Absolute paths of the config files each tool owns. */
export function claudeSettingsPath(): string {
  return path.join(home(), ".claude", "settings.json");
}

export function codexConfigPath(): string {
  return path.join(home(), ".codex", "config.toml");
}

export function codexAuthPath(): string {
  return path.join(home(), ".codex", "auth.json");
}

/**
 * All files the extension reads/writes for a given tool. Delegates to the tool's
 * adapter. Imported lazily to avoid a load-time cycle (adapters import paths).
 */
export function toolFiles(tool: Tool, context: vscode.ExtensionContext): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { findAdapter } = require("./adapters") as typeof import("./adapters");
  const adapter = findAdapter(tool);
  if (!adapter) {
    return [];
  }
  return adapter.files({ context, ownedProviders: [] });
}
