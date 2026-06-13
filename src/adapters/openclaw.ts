import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { backupFile, isOriginalCaptured, restoreOriginal } from "../backup";
import { slugProvider } from "../util/slug";
import { ApplyInput, AdapterCtx, ToolAdapter } from "./types";

const PATH_KEY = "zion.path.openclaw";
const OPENAI_API = "openai-completions";

/** Candidate locations for openclaw.json, in priority order. */
function candidatePaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".openclaw", "openclaw.json"),
    path.join(home, ".config", "openclaw", "openclaw.json"),
    path.join(home, ".open-claw", "openclaw.json"),
  ];
}

/** Resolve the config path: persisted choice, else first existing candidate. */
function knownPath(ctx: AdapterCtx): string | undefined {
  const saved = ctx.context.globalState.get<string>(PATH_KEY);
  if (saved && fs.existsSync(saved)) {
    return saved;
  }
  return candidatePaths().find((p) => fs.existsSync(p));
}

/** Lenient JSON read: tolerate trailing commas (Open Claw uses a relaxed shape). */
function readJson(file: string): Record<string, any> {
  if (!fs.existsSync(file)) {
    return {};
  }
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw === "") {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Strip trailing commas before } or ] and retry.
    const relaxed = raw.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(relaxed);
  }
}

function writeJson(file: string, data: Record<string, any>): void {
  backupFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${file}.zion-tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** Read models.providers as an object (creating the nested shape lazily). */
function providers(data: Record<string, any>): Record<string, any> {
  if (!data.models || typeof data.models !== "object") {
    data.models = {};
  }
  if (!data.models.providers || typeof data.models.providers !== "object") {
    data.models.providers = {};
  }
  return data.models.providers;
}

/** The currently-selected "provider/model" primary, or undefined. */
function primary(data: Record<string, any>): string | undefined {
  const p = data?.agents?.defaults?.model?.primary;
  return typeof p === "string" ? p : undefined;
}

export const openclawAdapter: ToolAdapter = {
  id: "openclaw",
  label: "Open Claw",
  cliName: "Open Claw",
  secretLabel: "API key",
  usesNamedProvider: true,

  providerNameFor(profile) {
    return profile.providerName || slugProvider(profile.label, profile.id);
  },

  currentProviderName(ctx) {
    const file = knownPath(ctx);
    if (!file || !fs.existsSync(file)) {
      return undefined;
    }
    try {
      const active = primary(readJson(file));
      return active ? active.split("/")[0] : undefined;
    } catch {
      return undefined;
    }
  },

  files(ctx) {
    const p = knownPath(ctx);
    return p ? [p] : [];
  },

  async resolvePath(ctx) {
    const existing = knownPath(ctx);
    if (existing) {
      return existing;
    }
    const picked = await vscode.window.showOpenDialog({
      title: "Locate your Open Claw config (openclaw.json)",
      canSelectMany: false,
      openLabel: "Use this file",
      filters: { "Open Claw config": ["json"] },
    });
    const file = picked?.[0]?.fsPath;
    if (file) {
      await ctx.context.globalState.update(PATH_KEY, file);
    }
    return file;
  },

  applyGateway(input: ApplyInput, ctx: AdapterCtx) {
    const file = knownPath(ctx) ?? candidatePaths()[0];
    const name = input.profile.providerName || slugProvider(input.profile.label, input.profile.id);
    const data = readJson(file);

    const provs = providers(data);
    const existing = provs[name] && typeof provs[name] === "object" ? provs[name] : {};
    const modelId = `${name}/model`;
    provs[name] = {
      ...existing,
      baseUrl: input.baseUrl,
      apiKey: input.secret,
      api: existing.api ?? OPENAI_API,
      models: Array.isArray(existing.models) && existing.models.length
        ? existing.models
        : [{ id: modelId, name: "model" }],
    };

    // Point the default agent model at this provider.
    if (!data.agents || typeof data.agents !== "object") {
      data.agents = {};
    }
    if (!data.agents.defaults || typeof data.agents.defaults !== "object") {
      data.agents.defaults = {};
    }
    if (!data.agents.defaults.model || typeof data.agents.defaults.model !== "object") {
      data.agents.defaults.model = {};
    }
    const firstModel = provs[name].models[0]?.id ?? modelId;
    data.agents.defaults.model.primary = firstModel;

    writeJson(file, data);
  },

  removeGateway(ctx: AdapterCtx) {
    const file = knownPath(ctx);
    if (!file || !fs.existsSync(file)) {
      return false;
    }
    const data = readJson(file);
    const provs = data?.models?.providers;
    let changed = false;

    if (provs && typeof provs === "object") {
      for (const name of ctx.ownedProviders) {
        if (name in provs) {
          delete provs[name];
          changed = true;
        }
      }
    }
    // If the active primary points at one of our providers, clear it.
    const active = primary(data);
    if (active && ctx.ownedProviders.some((n) => active.startsWith(`${n}/`))) {
      delete data.agents.defaults.model.primary;
      changed = true;
    }
    if (changed) {
      writeJson(file, data);
    }
    return changed;
  },

  // Open Claw has no separate OAuth store: native is whatever the file held
  // before. Restore the verbatim snapshot when one was captured, otherwise just
  // strip our gateway provider so we never leave the gateway block behind even
  // if no snapshot exists (e.g. the path was unresolved at first run).
  async restoreNative(ctx: AdapterCtx) {
    if (isOriginalCaptured(ctx.context, "openclaw")) {
      restoreOriginal(ctx.context, "openclaw");
      return;
    }
    openclawAdapter.removeGateway(ctx);
  },

  isOnGateway(ctx: AdapterCtx) {
    const file = knownPath(ctx);
    if (!file || !fs.existsSync(file)) {
      return false;
    }
    try {
      const data = readJson(file);
      const active = primary(data);
      if (!active) {
        return false;
      }
      // On a gateway if the active provider has a custom baseUrl defined.
      const provName = active.split("/")[0];
      const prov = data?.models?.providers?.[provName];
      return !!(prov && typeof prov === "object" && prov.baseUrl);
    } catch {
      return false;
    }
  },

  currentBaseUrl(ctx: AdapterCtx) {
    const file = knownPath(ctx);
    if (!file || !fs.existsSync(file)) {
      return undefined;
    }
    try {
      const data = readJson(file);
      const active = primary(data);
      if (!active) {
        return undefined;
      }
      const prov = data?.models?.providers?.[active.split("/")[0]];
      const url = prov?.baseUrl;
      return typeof url === "string" && url ? url : undefined;
    } catch {
      return undefined;
    }
  },
};
