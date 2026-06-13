import { ClaudeConfigManager } from "../claude";
import { ApplyInput, AdapterCtx, ToolAdapter } from "./types";

/** Claude Code: ~/.claude/settings.json env keys. Native login is in the OS keychain. */
const manager = new ClaudeConfigManager();

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

  // Native login lives in the OS keychain, not settings.json: just strip the
  // env keys we wrote and Claude falls back to it. No snapshot needed.
  async restoreNative(_ctx: AdapterCtx) {
    manager.removeGateway();
  },

  // Anthropic-style gateways may key off x-api-key instead of Authorization.
  testHeaders(secret: string) {
    return { "x-api-key": secret, "anthropic-version": "2023-06-01" };
  },
};
