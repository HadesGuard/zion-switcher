# Zion Switcher

One place to flip **Claude Code** and **Codex CLI** between your **native subscription** and **any gateway** — Zion, OpenRouter, a self-hosted proxy, or a raw API endpoint. No more hand-editing config files.

## What it does

Each tool can point at one of:

- **Native login** — a byte-for-byte snapshot of your config files captured the first time the extension runs. Restoring it brings back exactly what you had, including any native OAuth login (Claude Keychain / Codex ChatGPT token).
- **Gateway profile** — a `{ label, base URL, secret }` you declare for any OpenAI/Anthropic-compatible endpoint. The secret is kept in VS Code **SecretStorage**, never in plain settings.

Add as many gateways as you like and switch between them in one click. The active profile per tool shows in the status bar: `$(rocket) Claude: prod · Codex: native`. Click it to switch, add, edit, view, test, or clean.

> After switching, restart the running Claude Code / Codex CLI for the new endpoint to take effect.

> **Test connection:** when adding a profile (or from its view panel) you can probe the gateway — it does a `GET <base URL>/v1/models` with your key and reports whether the endpoint is reachable and the key accepted.

## How each tool is switched

| Tool   | Files touched | Gateway write | Restore |
|--------|---------------|---------------|---------|
| Claude | `~/.claude/settings.json` | sets `env.ANTHROPIC_BASE_URL` + `env.ANTHROPIC_AUTH_TOKEN`; every other key preserved | copies the snapshot back verbatim |
| Codex  | `~/.codex/config.toml`, `~/.codex/auth.json` | sets `model_provider` + `[model_providers.<name>]` (`base_url`, `wire_api = "responses"`) and `auth.json` `OPENAI_API_KEY` (`auth_mode = "apikey"`); other tables preserved | copies both snapshots back verbatim |

Every write is preceded by a timestamped backup next to the file (`<file>.zion-bak-<ISO>`, last 10 kept).

> **Note:** `@iarna/toml` does not preserve comments or key ordering when it rewrites `config.toml`. This only affects the gateway config the extension generates; switching back to **Native login** restores your file verbatim from the snapshot.

## Commands

- **Zion: Switch Login** — status bar / palette; pick where each tool connects, add a custom endpoint, or open Clean Up. Each saved endpoint has inline view / edit / delete buttons.
- **Zion: Add a Custom Endpoint** — save an endpoint (name, tool, base URL, token/key).
- **Zion: Edit / Delete a Custom Endpoint**
- **Zion: Update Backup of My Login** — save the current files as the new "Native login" backup. Use if you installed the extension *after* your config already pointed at a gateway — set the files back to your own login first, then run this.
- **Zion: Open Config Files** — quick-open the underlying files.
- **Zion: Clean Up** — two choices: *switch everything back to your own login* (keeps saved endpoints), or *reset everything* (also erases saved endpoints, keys, and all backups — like a fresh install).

## First run

On activation the extension silently snapshots your current Claude and Codex configs as their "Native login". If at that moment your files already point at a gateway, run **Re-capture Original Config** once your own config is in place.

## Settings

Set a default base URL that pre-fills when you add a new profile, so you don't retype it each time. Leave blank to type it in each time.

| Setting | Applies to |
|---------|-----------|
| `zion.defaultBaseUrl.claude` | Claude gateway profiles |
| `zion.defaultBaseUrl.codex` | Codex gateway profiles (usually ends in `/v1`) |

## Develop

```bash
npm install
npm run build          # esbuild → dist/extension.js
npm run watch          # rebuild on change
npm run typecheck      # tsc --noEmit
```

Press **F5** in VS Code to launch an Extension Development Host, or `npm run package` (needs `@vscode/vsce`) to produce a `.vsix` and install it via *Extensions: Install from VSIX…*.
