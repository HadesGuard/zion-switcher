import * as fs from "fs";
import * as path from "path";
import { backupFile } from "./backup";
import { claudeSettingsPath } from "./paths";

/**
 * Manages ~/.claude/settings.json. Only the two ANTHROPIC_* env keys are ever
 * mutated; every other key (permissions.allow, defaultMode, etc.) is preserved.
 */
export class ClaudeConfigManager {
  private readonly file = claudeSettingsPath();

  /** Point Claude Code at a gateway: set env.ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN. */
  applyGateway(baseUrl: string, token: string): void {
    const data = this.readJson();
    const env = (data.env && typeof data.env === "object") ? data.env : {};
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = token;
    data.env = env;
    this.writeJson(data);
  }

  /** True if settings.json currently points Claude at a custom endpoint. */
  isOnGateway(): boolean {
    if (!fs.existsSync(this.file)) {
      return false;
    }
    try {
      const env = this.readJson().env;
      return !!(env && typeof env === "object" && env.ANTHROPIC_BASE_URL);
    } catch {
      return false;
    }
  }

  /** The base URL Claude is currently pointed at, or undefined if none. */
  currentBaseUrl(): string | undefined {
    if (!fs.existsSync(this.file)) {
      return undefined;
    }
    try {
      const env = this.readJson().env;
      const url = env && typeof env === "object" ? env.ANTHROPIC_BASE_URL : undefined;
      return typeof url === "string" && url ? url : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Remove the gateway keys this extension manages from settings.json.
   * Leaves every other setting intact. Returns true if anything changed.
   */
  removeGateway(): boolean {
    if (!fs.existsSync(this.file)) {
      return false;
    }
    const data = this.readJson();
    const env = (data.env && typeof data.env === "object") ? data.env : undefined;
    if (!env) {
      return false;
    }
    let changed = false;
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
      if (k in env) {
        delete env[k];
        changed = true;
      }
    }
    if (!changed) {
      return false;
    }
    if (Object.keys(env).length === 0) {
      delete data.env;
    } else {
      data.env = env;
    }
    this.writeJson(data);
    return true;
  }

  private readJson(): Record<string, any> {
    if (!fs.existsSync(this.file)) {
      return {};
    }
    const raw = fs.readFileSync(this.file, "utf8").trim();
    if (raw === "") {
      return {};
    }
    return JSON.parse(raw);
  }

  private writeJson(data: Record<string, any>): void {
    backupFile(this.file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify(data, null, 2) + "\n";
    const tmp = `${this.file}.zion-tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, this.file);
  }
}
