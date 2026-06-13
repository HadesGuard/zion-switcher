/**
 * Minimal .env reader/writer. Only does what the extension needs: read a single
 * key, upsert a single key while preserving every other line, and delete a
 * single key. Not a full dotenv parser (no interpolation, no export keyword).
 */

/** Read the value of one key from .env text, or undefined if absent. */
export function readEnvKey(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = matchKey(line);
    if (m && m.key === key) {
      return stripQuotes(m.value);
    }
  }
  return undefined;
}

/** Return .env text with `key` set to `value`, preserving all other lines. */
export function upsertEnvKey(text: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const m = matchKey(lines[i]);
    if (m && m.key === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) {
    // Append, keeping a single trailing newline.
    if (lines.length && lines[lines.length - 1] === "") {
      lines[lines.length - 1] = `${key}=${value}`;
      lines.push("");
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join("\n");
}

/** Return .env text with `key` removed. Returns {text, changed}. */
export function removeEnvKey(text: string, key: string): { text: string; changed: boolean } {
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const m = matchKey(line);
    return !(m && m.key === key);
  });
  const changed = kept.length !== lines.length;
  return { text: kept.join("\n"), changed };
}

interface KeyMatch {
  key: string;
  value: string;
}

/** Match a `KEY=value` line (ignoring blank lines and # comments). */
function matchKey(line: string): KeyMatch | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) {
    return undefined;
  }
  const eq = line.indexOf("=");
  if (eq <= 0) {
    return undefined;
  }
  return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return v.slice(1, -1);
  }
  return v;
}
