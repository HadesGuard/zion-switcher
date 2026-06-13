import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as YAML from "js-yaml";
import { backupFile } from "../backup";
import { removeEnvKey, upsertEnvKey } from "../util/dotenv";
import { ApplyInput, AdapterCtx, ToolAdapter } from "./types";

// The env var the "custom" provider reads for its key. The Zion dashboard uses
// OPENAI_API_KEY; if Hermes ever reads a different name this is the one knob.
const ENV_KEY = "OPENAI_API_KEY";
const CUSTOM_PROVIDER = "custom";

/** Hermes config dir: %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere. */
function hermesDir(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "hermes");
  }
  return path.join(os.homedir(), ".hermes");
}

/** The YAML config file: prefer an existing cli-config.yaml / config.yaml, else default. */
function configPath(): string {
  const dir = hermesDir();
  const names = ["cli-config.yaml", "config.yaml", "cli-config.yml", "config.yml"];
  const existing = names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  return existing ?? path.join(dir, "cli-config.yaml");
}

function envPath(): string {
  return path.join(hermesDir(), ".env");
}

function readYaml(file: string): Record<string, any> {
  if (!fs.existsSync(file)) {
    return {};
  }
  const raw = fs.readFileSync(file, "utf8");
  const doc = YAML.load(raw);
  return doc && typeof doc === "object" ? (doc as Record<string, any>) : {};
}

function writeYaml(file: string, data: Record<string, any>): void {
  backupFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = YAML.dump(data, { lineWidth: 0 });
  const tmp = `${file}.zion-tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function readEnvText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function writeEnvText(file: string, text: string): void {
  backupFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.zion-tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function modelBlock(data: Record<string, any>): Record<string, any> {
  if (!data.model || typeof data.model !== "object") {
    data.model = {};
  }
  return data.model;
}

export const hermesAdapter: ToolAdapter = {
  id: "hermes",
  label: "Hermes Agent",
  cliName: "Hermes",
  secretLabel: "API key",

  files() {
    return [configPath(), envPath()];
  },

  applyGateway(input: ApplyInput) {
    // YAML: provider=custom + base_url.
    const cfgFile = configPath();
    const data = readYaml(cfgFile);
    const model = modelBlock(data);
    model.provider = CUSTOM_PROVIDER;
    model.base_url = input.baseUrl;
    writeYaml(cfgFile, data);

    // .env: the API key.
    const envFile = envPath();
    const text = upsertEnvKey(readEnvText(envFile), ENV_KEY, input.secret);
    writeEnvText(envFile, text);
  },

  removeGateway() {
    let changed = false;

    const cfgFile = configPath();
    if (fs.existsSync(cfgFile)) {
      const data = readYaml(cfgFile);
      const model = data.model;
      if (model && typeof model === "object") {
        if (model.provider === CUSTOM_PROVIDER) {
          delete model.provider;
          changed = true;
        }
        if ("base_url" in model) {
          delete model.base_url;
          changed = true;
        }
        if (changed) {
          writeYaml(cfgFile, data);
        }
      }
    }

    const envFile = envPath();
    if (fs.existsSync(envFile)) {
      const result = removeEnvKey(readEnvText(envFile), ENV_KEY);
      if (result.changed) {
        writeEnvText(envFile, result.text);
        changed = true;
      }
    }

    return changed;
  },

  isOnGateway() {
    const cfgFile = configPath();
    if (!fs.existsSync(cfgFile)) {
      return false;
    }
    try {
      const model = readYaml(cfgFile).model;
      return !!(model && typeof model === "object" && (model.provider === CUSTOM_PROVIDER || model.base_url));
    } catch {
      return false;
    }
  },

  currentBaseUrl() {
    const cfgFile = configPath();
    if (!fs.existsSync(cfgFile)) {
      return undefined;
    }
    try {
      const url = readYaml(cfgFile).model?.base_url;
      return typeof url === "string" && url ? url : undefined;
    } catch {
      return undefined;
    }
  },
};
