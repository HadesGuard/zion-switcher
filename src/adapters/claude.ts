import { ClaudeConfigManager } from "../claude";
import { isOriginalCaptured, readSnapshot, restoreOriginal } from "../backup";
import { ApplyInput, AdapterCtx, ToolAdapter } from "./types";

/** Claude Code: ~/.claude/settings.json env keys. Native login is usually the OS keychain. */
const manager = new ClaudeConfigManager();

/** Does the captured settings.json snapshot itself carry an ANTHROPIC_BASE_URL? */
function snapshotHasBaseUrl(ctx: AdapterCtx): boolean {
  const text = readSnapshot(ctx.context, "claude", "settings.json");
  if (text === undefined) {
    return false;
  }
  try {
    const env = JSON.parse(text)?.env;
    return !!(env && typeof env === "object" && env.ANTHROPIC_BASE_URL);
  } catch {
    return false;
  }
}

export const claudeAdapter: ToolAdapter = {
  id: "claude",
  label: "Claude Code",
  cliName: "Claude Code",
  secretLabel: "auth token",

  files() {
    return manager.files();
  },

  applyGateway(input: ApplyInput) {
    manager.applyGateway(input.baseUrl, input.secret);
  },

  removeGateway() {
    return manager.removeGateway();
  },

  isOnGateway() {
    return manager.isOnGateway();
  },

  currentBaseUrl() {
    return manager.currentBaseUrl();
  },

  // Usually native login is the OS keychain, so stripping the env keys we wrote
  // is enough. But if the captured "own login" snapshot itself had a base URL
  // (the user's real login IS a custom endpoint, captured via "this is my own
  // login"), restore it verbatim so we don't erase their endpoint. captureOnFirstRun
  // refuses to capture a gateway as native, so a snapshot base URL is theirs.
  async restoreNative(ctx: AdapterCtx) {
    if (isOriginalCaptured(ctx.context, "claude") && snapshotHasBaseUrl(ctx)) {
      restoreOriginal(ctx.context, "claude");
      return;
    }
    manager.removeGateway();
  },

  // Anthropic-style gateways may key off x-api-key instead of Authorization.
  testHeaders(secret: string) {
    return { "x-api-key": secret, "anthropic-version": "2023-06-01" };
  },
};
