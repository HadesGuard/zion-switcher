import * as vscode from "vscode";
import { GatewayProfile, ORIGINAL_ID, Tool } from "./paths";
import { findAdapter } from "./adapters";

const PROFILES_KEY = "zion.gatewayProfiles"; // GatewayProfile[]
const ACTIVE_KEY = "zion.activeProfile"; // Record<Tool, string>  (profile id or ORIGINAL_ID)
const OWNED_CODEX_KEY = "zion.ownedCodexProviders"; // legacy: string[] of codex TOML provider keys
const OWNED_KEY = "zion.ownedProviders"; // Record<Tool, string[]>  named providers we wrote

function secretKey(profileId: string): string {
  return `zion.secret.${profileId}`;
}

/** Persists gateway profiles in globalState and their secrets in SecretStorage. */
export class ProfileStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): GatewayProfile[] {
    return this.context.globalState.get<GatewayProfile[]>(PROFILES_KEY, []);
  }

  listForTool(tool: Tool): GatewayProfile[] {
    return this.list().filter((p) => p.tool === tool);
  }

  get(id: string): GatewayProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  async upsert(profile: GatewayProfile, secret?: string): Promise<void> {
    const all = this.list();
    const idx = all.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
      all[idx] = profile;
    } else {
      all.push(profile);
    }
    await this.context.globalState.update(PROFILES_KEY, all);
    if (secret !== undefined && secret !== "") {
      await this.context.secrets.store(secretKey(profile.id), secret);
    }
    // Remember named-provider keys we write into a shared config (Codex TOML,
    // Open Claw JSON), so Clean can strip them even after the profile is gone.
    const adapter = findAdapter(profile.tool);
    if (adapter?.usesNamedProvider && profile.providerName) {
      const map = this.ownedMap();
      const owned = new Set(map[profile.tool] ?? []);
      owned.add(profile.providerName);
      map[profile.tool] = [...owned];
      await this.context.globalState.update(OWNED_KEY, map);
    }
  }

  /**
   * Remove a profile and its secret. Returns the tools for which this profile
   * was the active one, so the caller can decide whether to restore native.
   */
  async delete(id: string): Promise<Tool[]> {
    const all = this.list().filter((p) => p.id !== id);
    await this.context.globalState.update(PROFILES_KEY, all);
    await this.context.secrets.delete(secretKey(id));
    const active = this.activeMap();
    const wasActiveFor: Tool[] = [];
    for (const tool of Object.keys(active) as Tool[]) {
      if (active[tool] === id) {
        active[tool] = ORIGINAL_ID;
        wasActiveFor.push(tool);
      }
    }
    if (wasActiveFor.length > 0) {
      await this.context.globalState.update(ACTIVE_KEY, active);
    }
    return wasActiveFor;
  }

  getSecret(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(secretKey(id));
  }

  private activeMap(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(ACTIVE_KEY, {});
  }

  /** Active profile id for a tool; defaults to ORIGINAL_ID when nothing set. */
  getActive(tool: Tool): string {
    return this.activeMap()[tool] ?? ORIGINAL_ID;
  }

  async setActive(tool: Tool, profileId: string): Promise<void> {
    const active = this.activeMap();
    active[tool] = profileId;
    await this.context.globalState.update(ACTIVE_KEY, active);
  }

  /** Display label for whatever is active on a tool. */
  activeLabel(tool: Tool): string {
    const id = this.getActive(tool);
    if (id === ORIGINAL_ID) {
      return "native";
    }
    return this.get(id)?.label ?? "native";
  }

  /**
   * The per-tool map of named provider keys we've written. Lazily migrates the
   * legacy codex-only `zion.ownedCodexProviders` string[] into `{ codex: [...] }`.
   */
  private ownedMap(): Record<string, string[]> {
    const map = this.context.globalState.get<Record<string, string[]>>(OWNED_KEY, {});
    if (!map.codex) {
      const legacy = this.context.globalState.get<string[]>(OWNED_CODEX_KEY, []);
      if (legacy.length) {
        map.codex = [...legacy];
      }
    }
    return map;
  }

  /**
   * Named provider keys this extension owns for a tool: the union of the durable
   * owned-list and current profiles. Survives "forget profiles" so a later Clean
   * can still strip stale providers from the tool's config.
   */
  ownedProviders(tool: Tool): string[] {
    const names = new Set<string>(this.ownedMap()[tool] ?? []);
    for (const p of this.list()) {
      if (p.tool === tool && p.providerName) {
        names.add(p.providerName);
      }
    }
    return [...names];
  }

  /** Wipe profiles and secrets for a single tool; leave the other tool's untouched. */
  async clearForTool(tool: Tool): Promise<void> {
    const keep: GatewayProfile[] = [];
    for (const p of this.list()) {
      if (p.tool === tool) {
        await this.context.secrets.delete(secretKey(p.id));
      } else {
        keep.push(p);
      }
    }
    await this.context.globalState.update(PROFILES_KEY, keep);
    const active = this.activeMap();
    if (active[tool] !== undefined) {
      delete active[tool];
      await this.context.globalState.update(ACTIVE_KEY, active);
    }
  }

  /** Clear the durable owned-provider list for a tool (full reset, after config is cleaned). */
  async clearOwnedProviders(tool: Tool): Promise<void> {
    const map = this.ownedMap();
    if (map[tool]) {
      delete map[tool];
      await this.context.globalState.update(OWNED_KEY, map);
    }
    // Also drop the legacy key when clearing codex, so it can't resurrect.
    if (tool === "codex") {
      await this.context.globalState.update(OWNED_CODEX_KEY, []);
    }
  }
}
