# Zion Switcher

One place to flip **Claude Code** and **Codex CLI** between your **own login** (Claude subscription or ChatGPT) and **any custom endpoint**: a gateway, a self-hosted proxy, or a raw API. No more hand-editing config files.

## What it does

Each tool can point at one of:

- **Native login**: a byte-for-byte backup of your config files, taken the first time the extension runs. Switching back brings back exactly what you had, including your native OAuth login (Claude Keychain or Codex ChatGPT token).
- **Custom endpoint**: a `{ name, base URL, token/key }` you save for any OpenAI/Anthropic-compatible service. The token is kept in VS Code **SecretStorage**, never in plain settings.

Save as many endpoints as you like and switch in one click. The status bar shows what's active and turns amber when a tool is on a custom endpoint, so you always know whether you're on your own account. Click it to switch, add, edit, view, test, or clean up.

> After switching, restart the tool for the change to take effect: close and reopen the `claude` / `codex` session in your terminal, or reload the window if you run it as a VS Code extension.

> **Test connection:** when adding an endpoint (or from its view panel) you can probe it. The extension does a `GET <base URL>/v1/models` with your key and reports whether the endpoint is reachable and the key accepted.

## How each tool is switched

| Tool   | Files touched | Gateway write | Switch back |
|--------|---------------|---------------|---------|
| Claude | `~/.claude/settings.json` | sets `env.ANTHROPIC_BASE_URL` + `env.ANTHROPIC_AUTH_TOKEN`; every other key preserved | removes those two keys, so Claude falls back to your keychain login |
| Codex  | `~/.codex/config.toml`, `~/.codex/auth.json` | sets `model_provider` + `[model_providers.<name>]` (`base_url`, `wire_api = "responses"`) and `auth.json` `OPENAI_API_KEY` (`auth_mode = "apikey"`); other tables preserved | restores your saved login when possible, otherwise clears the API key and prompts `codex login` |

Every write is preceded by a timestamped backup next to the file (`<file>.zion-bak-<ISO>`, last 10 kept).

> **Note:** `@iarna/toml` does not preserve comments or key ordering when it rewrites `config.toml`. This only affects the gateway config the extension generates. Switching back to **Native login** restores your file verbatim from the backup.

## Commands

- **Zion: Switch Login**: from the status bar or command palette. Pick where each tool connects, add a custom endpoint, or open Clean Up. Each saved endpoint has inline view / edit / delete buttons.
- **Zion: Add a Custom Endpoint**: save an endpoint (name, tool, base URL, token/key).
- **Zion: Edit / Delete a Custom Endpoint**
- **Zion: Update Backup of My Login**: save the current files as the new "Native login" backup. Use this if you installed the extension *after* your config already pointed at a gateway: set the files back to your own login first, then run it.
- **Zion: Open Config Files**: quick-open the underlying files.
- **Zion: Clean Up**: pick which tools to act on (Claude, Codex, or both), then choose. *Switch back to your own login* (keeps your saved endpoints), or *reset everything* (also erases saved endpoints, keys, and all backups, like a fresh install).

## First run

On activation the extension quietly backs up your current Claude and Codex configs as their "Native login". If a tool is already pointed at a custom endpoint when you install, the extension can't tell what your original login was, so it asks: is this your own login, or a custom endpoint? If you say it's custom, it skips the backup and saves that endpoint to your list instead. Get back on your own login, then run **Update Backup of My Login** so switching back works.

## Settings

Set a default base URL that pre-fills when you add an endpoint, so you don't retype it each time. Leave blank to type it in each time.

| Setting | Applies to |
|---------|-----------|
| `zion.defaultBaseUrl.claude` | Claude endpoints |
| `zion.defaultBaseUrl.codex` | Codex endpoints (usually ends in `/v1`) |

## Develop

```bash
npm install
npm run build          # esbuild bundle to dist/extension.js
npm run watch          # rebuild on change
npm run typecheck      # tsc --noEmit
```

Press **F5** in VS Code to launch an Extension Development Host, or run `npm run package` (needs `@vscode/vsce`) to produce a `.vsix` and install it via *Extensions: Install from VSIX…*.

## License

MIT
