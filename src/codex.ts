import * as fs from "fs";
import * as path from "path";
import * as TOML from "@iarna/toml";
import { backupFile } from "./backup";
import { codexAuthPath, codexConfigPath } from "./paths";

/**
 * Manages ~/.codex/config.toml + ~/.codex/auth.json for API-key gateway access.
 *
 * NOTE: @iarna/toml does not preserve comments or key ordering on rewrite. Every
 * write is preceded by a timestamped backup, and the verbatim "original" snapshot
 * is what gets restored when switching back, so the round-trip is lossless where
 * it matters (restore), lossy only on the gateway-config we generate ourselves.
 */
export class CodexConfigManager {
  private readonly configFile = codexConfigPath();
  private readonly authFile = codexAuthPath();

  /** Config files this tool owns (for backup / restore). */
  files(): string[] {
    return [this.configFile, this.authFile];
  }

  /**
   * Point Codex at a gateway:
   *  - config.toml: model_provider = <providerName>, upsert [model_providers.<providerName>]
   *  - auth.json:   auth_mode = "apikey", OPENAI_API_KEY = <key> (other keys preserved)
   */
  applyGateway(providerName: string, displayName: string, baseUrl: string, key: string): void {
    const config = this.readToml();
    config.model_provider = providerName;

    const providers =
      config.model_providers && typeof config.model_providers === "object"
        ? (config.model_providers as Record<string, any>)
        : {};
    const existing =
      providers[providerName] && typeof providers[providerName] === "object"
        ? (providers[providerName] as Record<string, any>)
        : {};
    providers[providerName] = {
      ...existing,
      name: displayName,
      base_url: baseUrl,
      wire_api: existing.wire_api ?? "responses",
    };
    config.model_providers = providers;
    this.writeToml(config);

    const auth = this.readAuth();
    auth.auth_mode = "apikey";
    auth.OPENAI_API_KEY = key;
    this.writeAuth(auth);
  }

  /**
   * Remove gateway providers this extension created from config.toml.
   * `providerNames` are the table keys under [model_providers.*] we own.
   * If the active model_provider points at one of them, it is cleared.
   * auth.json is left untouched (OPENAI_API_KEY may be the user's own);
   * the caller decides whether to also clear it. Returns true if changed.
   */
  removeGateway(providerNames: string[]): boolean {
    if (!fs.existsSync(this.configFile)) {
      return false;
    }
    const config = this.readToml();
    let changed = false;

    const providers =
      config.model_providers && typeof config.model_providers === "object"
        ? (config.model_providers as Record<string, any>)
        : undefined;
    if (providers) {
      for (const name of providerNames) {
        if (name in providers) {
          delete providers[name];
          changed = true;
        }
      }
      if (Object.keys(providers).length === 0) {
        delete config.model_providers;
      }
    }
    if (typeof config.model_provider === "string" && providerNames.includes(config.model_provider)) {
      delete config.model_provider;
      changed = true;
    }
    if (changed) {
      this.writeToml(config);
    }
    return changed;
  }

  /** True if auth.json currently holds a ChatGPT OAuth login (a `tokens` block). */
  hasNativeLogin(): boolean {
    if (!fs.existsSync(this.authFile)) {
      return false;
    }
    const auth = this.readAuth();
    return auth.tokens != null && typeof auth.tokens === "object";
  }

  /**
   * Strip the api-key fields this extension writes from auth.json, so Codex falls
   * back to its OAuth login (if `tokens` are still present) or a clean state.
   * Leaves `tokens` and everything else intact. Returns true if changed.
   */
  clearApiKey(): boolean {
    if (!fs.existsSync(this.authFile)) {
      return false;
    }
    const auth = this.readAuth();
    let changed = false;
    for (const k of ["OPENAI_API_KEY", "auth_mode"]) {
      if (k in auth) {
        delete auth[k];
        changed = true;
      }
    }
    if (changed) {
      this.writeAuth(auth);
    }
    return changed;
  }

  /** True if this config.toml text selects one of the given gateway providers as active. */
  isGatewayConfigText(raw: string, ownedNames: string[]): boolean {
    try {
      const cfg = TOML.parse(raw) as Record<string, any>;
      return typeof cfg.model_provider === "string" && ownedNames.includes(cfg.model_provider);
    } catch {
      return false;
    }
  }

  /**
   * True if config.toml currently points Codex at a custom provider, i.e.
   * `model_provider` is set to anything other than the built-in "openai".
   * Used at first run to spot a config that was already on a gateway.
   */
  isOnGateway(): boolean {
    if (!fs.existsSync(this.configFile)) {
      return false;
    }
    try {
      const cfg = this.readToml();
      return typeof cfg.model_provider === "string" && cfg.model_provider !== "openai";
    } catch {
      return false;
    }
  }

  /** The base URL of the provider Codex is currently set to, or undefined. */
  currentBaseUrl(): string | undefined {
    if (!fs.existsSync(this.configFile)) {
      return undefined;
    }
    try {
      const cfg = this.readToml();
      const active = cfg.model_provider;
      if (typeof active !== "string") {
        return undefined;
      }
      const providers = cfg.model_providers as Record<string, any> | undefined;
      const url = providers?.[active]?.base_url;
      return typeof url === "string" && url ? url : undefined;
    } catch {
      return undefined;
    }
  }

  private readToml(): Record<string, any> {
    if (!fs.existsSync(this.configFile)) {
      return {};
    }
    const raw = fs.readFileSync(this.configFile, "utf8");
    return TOML.parse(raw) as Record<string, any>;
  }

  private writeToml(data: Record<string, any>): void {
    backupFile(this.configFile);
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    const text = TOML.stringify(data as TOML.JsonMap);
    const tmp = `${this.configFile}.zion-tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, this.configFile);
  }

  private readAuth(): Record<string, any> {
    if (!fs.existsSync(this.authFile)) {
      return {};
    }
    const raw = fs.readFileSync(this.authFile, "utf8").trim();
    if (raw === "") {
      return {};
    }
    return JSON.parse(raw);
  }

  private writeAuth(data: Record<string, any>): void {
    backupFile(this.authFile);
    fs.mkdirSync(path.dirname(this.authFile), { recursive: true });
    const text = JSON.stringify(data, null, 2) + "\n";
    const tmp = `${this.authFile}.zion-tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, this.authFile);
  }
}
