import * as os from "os";
import * as path from "path";

export type Tool = "claude" | "codex";

export const TOOLS: Tool[] = ["claude", "codex"];

export const TOOL_LABELS: Record<Tool, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** Sentinel id meaning "your captured original config" for a tool. */
export const ORIGINAL_ID = "__original__";

/** A user-declared gateway profile (base URL + secret stored separately). */
export interface GatewayProfile {
  id: string;
  tool: Tool;
  label: string;
  baseUrl: string;
  /** For codex: the provider name used as the TOML table key. Defaults to a slug of label. */
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

/** All files the extension reads/writes for a given tool. */
export function toolFiles(tool: Tool): string[] {
  if (tool === "claude") {
    return [claudeSettingsPath()];
  }
  return [codexConfigPath(), codexAuthPath()];
}
