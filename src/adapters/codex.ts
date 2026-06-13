import * as vscode from "vscode";
import { CodexConfigManager } from "../codex";
import { isOriginalCaptured, readSnapshot, restoreOriginal } from "../backup";
import { slugProvider } from "../util/slug";
import { ApplyInput, AdapterCtx, ToolAdapter } from "./types";
import { GatewayProfile } from "../paths";

/** Codex: ~/.codex/config.toml provider + ~/.codex/auth.json key. Native is ChatGPT OAuth. */
const manager = new CodexConfigManager();

export const codexAdapter: ToolAdapter = {
  id: "codex",
  label: "Codex",
  cliName: "Codex",
  secretLabel: "API key",
  usesNamedProvider: true,

  files() {
    return manager.files();
  },

  providerNameFor(profile: GatewayProfile) {
    return profile.providerName || slugProvider(profile.label, profile.id);
  },

  currentProviderName() {
    return manager.currentProviderName();
  },

  applyGateway(input: ApplyInput) {
    const providerName =
      input.profile.providerName || slugProvider(input.profile.label, input.profile.id);
    manager.applyGateway(providerName, input.profile.label, input.baseUrl, input.secret);
  },

  removeGateway(ctx: AdapterCtx) {
    return manager.removeGateway(ctx.ownedProviders);
  },

  isOnGateway() {
    return manager.isOnGateway();
  },

  currentBaseUrl() {
    return manager.currentBaseUrl();
  },

  /**
   * Native is the ChatGPT OAuth token in auth.json. Prefer restoring the
   * verbatim snapshot when it holds a real login (and isn't itself a gateway
   * config we captured by mistake), so the user doesn't re-login. Otherwise
   * strip our provider + key and fall back to whatever login remains.
   */
  async restoreNative(ctx: AdapterCtx) {
    const snapConfig = readSnapshot(ctx.context, "codex", "config.toml");
    const snapAuth = readSnapshot(ctx.context, "codex", "auth.json");

    // Only restore the verbatim snapshot when it positively looks like a real
    // native ChatGPT login (OAuth tokens, not api-key mode, no gateway key,
    // model_provider openai/unset). Deciding from content rather than the
    // owned-provider list avoids restoring a captured gateway config as "native"
    // when the owned list is empty/stale (e.g. first-run "this is my own login").
    if (
      isOriginalCaptured(ctx.context, "codex") &&
      manager.snapshotIsNativeLogin(snapConfig, snapAuth)
    ) {
      restoreOriginal(ctx.context, "codex");
      return;
    }

    manager.removeGateway(ctx.ownedProviders);
    manager.clearApiKey();
    if (!manager.hasNativeLogin()) {
      vscode.window.showWarningMessage(
        "Zion: Codex is back to native, but you're not signed in. Open a terminal and run `codex login` to sign in with your ChatGPT account."
      );
    }
  },
};
