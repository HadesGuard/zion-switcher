import * as vscode from "vscode";
import { GatewayProfile, Tool } from "../paths";

/** A tool's stable id, e.g. "claude", "codex", "openclaw", "hermes". */
export type ToolId = Tool;

/** Everything an adapter needs from the host to do its work. */
export interface AdapterCtx {
  /** For reading/writing resolved config paths and other per-tool state. */
  context: vscode.ExtensionContext;
  /** Provider names this extension owns for the tool (Codex TOML tables, Open
   *  Claw JSON providers). Empty for tools that use a fixed provider. */
  ownedProviders: string[];
}

export interface ApplyInput {
  baseUrl: string;
  secret: string;
  profile: GatewayProfile;
}

/**
 * One CLI tool the extension can point at a gateway and switch back. Each tool
 * is a single self-contained adapter registered in adapters/index.ts. Adding a
 * tool means writing one of these and registering it, nothing else.
 */
export interface ToolAdapter {
  /** Stable id, also the key for profiles / active map / snapshot dirs. */
  id: ToolId;
  /** Human label, e.g. "Claude Code". */
  label: string;
  /** Name used in the restart toast, e.g. "Claude Code", "Codex". */
  cliName: string;
  /** What the secret is called for this tool: "auth token" | "API key". */
  secretLabel: string;

  /** Config files to back up / restore. Empty if a path isn't resolved yet. */
  files(ctx: AdapterCtx): string[];
  /** Write gateway settings into the tool's config. */
  applyGateway(input: ApplyInput, ctx: AdapterCtx): void | Promise<void>;
  /** Remove only what this extension wrote. Return true if anything changed. */
  removeGateway(ctx: AdapterCtx): boolean | Promise<boolean>;
  /** Is the config currently pointed at a custom endpoint? (first-run detect) */
  isOnGateway(ctx: AdapterCtx): boolean;
  /** The custom base URL currently configured, if any. */
  currentBaseUrl(ctx: AdapterCtx): string | undefined;

  // ---- optional capabilities ----

  /**
   * Custom "switch back to native" logic. If omitted, the host runs the generic
   * restore-from-snapshot flow. Claude (clear env) and Codex (smart OAuth
   * restore) provide their own.
   */
  restoreNative?(ctx: AdapterCtx): Promise<void>;
  /** Extra Test Connection headers (Claude adds x-api-key + anthropic-version). */
  testHeaders?(secret: string): Record<string, string>;
  /**
   * True if this tool writes a *named* provider into a shared config that needs
   * tracked cleanup later (Codex TOML table, Open Claw JSON provider). Drives
   * the owned-provider list. False/omitted for fixed-provider tools (Hermes).
   */
  usesNamedProvider?: boolean;
  /** Provider name for a profile (Codex/Open Claw). Required when usesNamedProvider. */
  providerNameFor?(profile: GatewayProfile): string;
  /**
   * The provider key actually present in the live config right now (Codex TOML
   * table key, Open Claw active provider). Used when adopting an endpoint the
   * user was already on, so cleanup targets the real key rather than a fresh slug.
   */
  currentProviderName?(ctx: AdapterCtx): string | undefined;
  /**
   * Resolve the config path when it isn't at a known location (Open Claw). May
   * prompt the user. Returns the resolved path, or undefined if unresolved.
   */
  resolvePath?(ctx: AdapterCtx): Promise<string | undefined>;
}
