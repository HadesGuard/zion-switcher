import * as vscode from "vscode";
import {
  captureOriginal,
  forgetOriginal,
  isOriginalCaptured,
  purgeBackups,
  restoreOriginal,
} from "./backup";
import { GatewayProfile, ORIGINAL_ID, Tool } from "./paths";
import { ADAPTERS, TOOLS, TOOL_LABELS, getAdapter } from "./adapters";
import { AdapterCtx, ToolAdapter } from "./adapters/types";
import { ProfileStore } from "./profiles";

let store: ProfileStore;
let statusBar: vscode.StatusBarItem;
let extContext: vscode.ExtensionContext;

const WELCOME_KEY = "zion.welcomeShown";

/** Build the per-call context an adapter needs (owned provider names for the tool). */
function ctxFor(tool: Tool): AdapterCtx {
  return { context: extContext, ownedProviders: store.ownedProviders(tool) };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;
  store = new ProfileStore(context);

  // Capture pristine originals on first run so the first switch is reversible.
  // If a tool's config already points at a custom endpoint, don't blindly save
  // that as the "native" backup: ask the user first.
  for (const tool of TOOLS) {
    try {
      if (isOriginalCaptured(context, tool)) {
        continue;
      }
      await captureOnFirstRun(tool);
    } catch (e) {
      console.error(`zion: failed to capture original for ${tool}`, e);
    }
  }

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.command = "zion.switch";
  context.subscriptions.push(statusBar);
  refreshStatusBar();
  statusBar.show();

  // First-run welcome, shown once after the initial snapshot is taken.
  if (!context.globalState.get<boolean>(WELCOME_KEY, false)) {
    await context.globalState.update(WELCOME_KEY, true);
    vscode.window.showInformationMessage(
      "Zion Switcher is ready. We've saved a backup of your current login, so you can always switch back. Click 'Zion' in the bottom bar to get started."
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("zion.switch", switchProfile),
    vscode.commands.registerCommand("zion.addGatewayProfile", () => addOrEditProfile()),
    vscode.commands.registerCommand("zion.editProfile", editProfile),
    vscode.commands.registerCommand("zion.deleteProfile", deleteProfile),
    vscode.commands.registerCommand("zion.captureOriginal", recaptureOriginal),
    vscode.commands.registerCommand("zion.openConfigFiles", openConfigFiles),
    vscode.commands.registerCommand("zion.clean", cleanReset)
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}

function refreshStatusBar(): void {
  const onGateway = TOOLS.filter((t) => store.getActive(t) !== ORIGINAL_ID);

  if (onGateway.length === 0) {
    // All native: stay compact and quiet.
    statusBar.text = "$(home) Zion $(chevron-down)";
    statusBar.tooltip = "Claude & Codex are using your own login. Click to switch (Zion Switcher)";
    statusBar.backgroundColor = undefined;
    return;
  }

  // At least one tool routed through a gateway: surface it and warn.
  const parts = TOOLS.map((t) => `${TOOL_LABELS[t]}: ${store.activeLabel(t)}`);
  statusBar.text = `$(rocket) ${parts.join(" · ")} $(chevron-down)`;
  statusBar.tooltip = `Using a custom endpoint: ${onGateway
    .map((t) => `${TOOL_LABELS[t]} → ${store.activeLabel(t)}`)
    .join(", ")}. Click to switch (Zion Switcher).`;
  statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

type SwitchAction = "apply" | "add" | "clean";

interface SwitchItem extends vscode.QuickPickItem {
  tool: Tool;
  profileId: string; // ORIGINAL_ID or a gateway profile id
  action: SwitchAction;
}

const VIEW_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("eye"),
  tooltip: "View details",
};
const EDIT_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("edit"),
  tooltip: "Edit URL & key",
};
const DELETE_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("trash"),
  tooltip: "Delete this profile",
};

function buildSwitchItems(): vscode.QuickPickItem[] {
  const items: vscode.QuickPickItem[] = [];
  for (const tool of TOOLS) {
    const active = store.getActive(tool);
    items.push({
      label: TOOL_LABELS[tool],
      kind: vscode.QuickPickItemKind.Separator,
    });
    // Original entry.
    items.push(<SwitchItem>{
      label: active === ORIGINAL_ID ? `$(check) Native login` : `$(home) Native login`,
      description: "your own Claude/ChatGPT account",
      tool,
      profileId: ORIGINAL_ID,
      action: "apply",
    });
    // Gateway profiles, each carries inline edit/delete buttons.
    for (const p of store.listForTool(tool)) {
      items.push(<SwitchItem>{
        label: active === p.id ? `$(check) ${p.label}` : `$(rocket) ${p.label}`,
        detail: p.baseUrl,
        tool,
        profileId: p.id,
        action: "apply",
        buttons: [VIEW_BUTTON, EDIT_BUTTON, DELETE_BUTTON],
      });
    }
    // Always-visible affordance to add a custom URL & key for this tool.
    items.push(<SwitchItem>{
      label: `$(add) Add a custom endpoint…`,
      detail: `Connect ${TOOL_LABELS[tool]} to another service (its address + your ${getAdapter(tool).secretLabel})`,
      tool,
      profileId: "",
      action: "add",
    });
  }
  // Footer: clean / reset.
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push(<SwitchItem>{
    label: `$(trash) Clean up…`,
    detail: "Undo changes this extension made, remove backups, or forget saved endpoints",
    profileId: "",
    action: "clean",
  });
  return items;
}

async function switchProfile(): Promise<void> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  qp.title = "Switch Claude / Codex login";
  qp.placeholder = "Pick where Claude or Codex should connect, or add your own";
  qp.matchOnDetail = true;
  qp.items = buildSwitchItems();

  const done = new Promise<void>((resolve) => {
    // Inline pencil / trash buttons on a profile row.
    qp.onDidTriggerItemButton(async (e) => {
      const item = e.item as SwitchItem;
      if (!item.profileId || item.profileId === ORIGINAL_ID) {
        return;
      }
      const profile = store.get(item.profileId);
      if (!profile) {
        return;
      }
      qp.hide();
      if (e.button === DELETE_BUTTON) {
        await deleteProfileById(profile);
      } else if (e.button === VIEW_BUTTON) {
        await viewProfileDetails(profile);
      } else {
        await addOrEditProfile(profile);
      }
      resolve();
    });

    qp.onDidAccept(async () => {
      const item = qp.selectedItems[0] as SwitchItem | undefined;
      qp.hide();
      if (!item) {
        resolve();
        return;
      }
      if (item.action === "clean") {
        await cleanReset();
        resolve();
        return;
      }
      if (!item.tool) {
        resolve();
        return;
      }
      if (item.action === "add") {
        await addOrEditProfile(undefined, item.tool);
      } else {
        await applyProfile(item.tool, item.profileId);
      }
      resolve();
    });

    qp.onDidHide(() => resolve());
  });

  qp.show();
  await done;
  qp.dispose();
}

async function applyProfile(tool: Tool, profileId: string): Promise<void> {
  try {
    if (profileId === ORIGINAL_ID) {
      await restoreNative(tool);
      return;
    }
    const profile = store.get(profileId);
    if (!profile) {
      throw new Error("Profile not found.");
    }
    const secret = await store.getSecret(profileId);
    if (!secret) {
      const what = getAdapter(tool).secretLabel;
      const choice = await vscode.window.showWarningMessage(
        `"${profile.label}" doesn't have a ${what} saved yet. Add it now?`,
        "Add it",
        "Cancel"
      );
      if (choice !== "Add it") {
        return;
      }
      const entered = await promptSecret(tool);
      if (!entered) {
        return;
      }
      await store.upsert(profile, entered);
      await applyProfileWithSecret(tool, profile, entered);
      await finishSwitch(tool, profileId, profile.label);
      return;
    }
    await applyProfileWithSecret(tool, profile, secret);
    await finishSwitch(tool, profileId, store.get(profileId)?.label ?? "");
  } catch (e: any) {
    vscode.window.showErrorMessage(`Zion: couldn't switch: ${e?.message ?? e}`);
  }
}

/**
 * Switch a tool back to its native (non-gateway) login.
 *
 * Each adapter may provide its own restoreNative (Claude strips env keys; Codex
 * smart-restores its OAuth snapshot). Tools without one fall back to the generic
 * flow: restore the verbatim snapshot if captured, else just remove the gateway.
 */
async function restoreNative(tool: Tool): Promise<void> {
  const adapter = getAdapter(tool);
  if (adapter.restoreNative) {
    await adapter.restoreNative(ctxFor(tool));
  } else if (isOriginalCaptured(extContext, tool)) {
    restoreOriginal(extContext, tool);
  } else {
    await adapter.removeGateway(ctxFor(tool));
  }
  await finishSwitch(tool, ORIGINAL_ID, "native");
}

/**
 * First-run capture for one tool. If the config already points at a custom
 * endpoint, the current files are NOT your own login, so saving them as the
 * "Native login" backup would be wrong. Ask the user what to do instead of
 * guessing.
 */
async function captureOnFirstRun(tool: Tool): Promise<void> {
  const onGateway = getAdapter(tool).isOnGateway(ctxFor(tool));
  if (!onGateway) {
    // Looks like your own login (or no config yet): safe to back it up quietly.
    await captureOriginal(extContext, tool);
    return;
  }

  const name = TOOL_LABELS[tool];
  const choice = await vscode.window.showWarningMessage(
    `${name} is already pointed at a custom endpoint, not your own login. ` +
      `Zion can't tell what your original login was. What should the "Native login" backup be?`,
    { modal: true },
    "This is my own login",
    "It's a custom endpoint"
  );

  if (choice === "This is my own login") {
    // User insists the current files are their real login: trust them.
    await captureOriginal(extContext, tool);
    return;
  }

  if (choice === "It's a custom endpoint") {
    // Don't capture. Tell them how to set a correct backup later, and record
    // the current endpoint as a saved profile so it isn't lost.
    await adoptCurrentGatewayAsProfile(tool);
    vscode.window.showInformationMessage(
      `Zion: skipped the backup for ${name}. When you're back on your own login, run "Zion: Update Backup of My Login" so switching back works.`
    );
    return;
  }

  // Dismissed: leave uncaptured so we ask again next launch.
}

/**
 * Save the endpoint a tool is currently using as a gateway profile, so a user
 * who installed mid-gateway keeps it in the list instead of losing it. Best
 * effort: reads the base URL from the live config; the secret isn't recoverable
 * from Claude settings / Codex auth in a portable way, so it's left blank for
 * the user to fill on first use.
 */
async function adoptCurrentGatewayAsProfile(tool: Tool): Promise<void> {
  const adapter = getAdapter(tool);
  const baseUrl = adapter.currentBaseUrl(ctxFor(tool));
  if (!baseUrl) {
    return;
  }
  const id = newId();
  const profile: GatewayProfile = {
    id,
    tool,
    label: "Imported endpoint",
    baseUrl,
    providerName: adapter.usesNamedProvider
      ? adapter.providerNameFor?.({ id, tool, label: "Imported endpoint", baseUrl })
      : undefined,
  };
  await store.upsert(profile);
  await store.setActive(tool, id);
}

async function applyProfileWithSecret(
  tool: Tool,
  profile: GatewayProfile,
  secret: string
): Promise<void> {
  await getAdapter(tool).applyGateway({ baseUrl: profile.baseUrl, secret, profile }, ctxFor(tool));
}

async function finishSwitch(tool: Tool, profileId: string, label: string): Promise<void> {
  await store.setActive(tool, profileId);
  refreshStatusBar();
  const cli = getAdapter(tool).cliName;
  const choice = await vscode.window.showInformationMessage(
    `Zion: ${TOOL_LABELS[tool]} → ${label}. To apply: restart ${cli} in your terminal, ` +
      `or reload the window if you run it as a VS Code extension.`,
    "Reload Window"
  );
  if (choice === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

// ---------------------------------------------------------------------------
// Add / edit / delete
// ---------------------------------------------------------------------------

async function addOrEditProfile(
  existing?: GatewayProfile,
  presetTool?: Tool
): Promise<void> {
  const tool = existing
    ? existing.tool
    : presetTool ?? (await pickTool("Which tool is this profile for?"));
  if (!tool) {
    return;
  }

  // Some tools (Open Claw) live at an unknown path; resolve it (may prompt) up
  // front so applying the profile later has somewhere to write.
  const resolver = getAdapter(tool).resolvePath;
  if (resolver) {
    const resolved = await resolver(ctxFor(tool));
    if (!resolved) {
      vscode.window.showWarningMessage(
        `Zion: couldn't locate the ${TOOL_LABELS[tool]} config file, so there's nowhere to save the endpoint.`
      );
      return;
    }
  }

  // Multi-step wizard: label → base URL → secret, with Back support so a cancel
  // at a later step doesn't lose what was already typed.
  let label = existing?.label ?? "";
  let baseUrl = existing?.baseUrl ?? defaultBaseUrl(tool);
  let secret: string | undefined;
  const totalSteps = 3;
  let step = 0;

  while (step < totalSteps) {
    if (step === 0) {
      const r = await inputStep({
        title: "Name this endpoint",
        step: 1,
        totalSteps,
        value: label,
        placeHolder: "e.g. my gateway, work proxy",
        validate: (v) => (v.trim() ? undefined : "Please type a name"),
        showBack: false,
      });
      if (r === BACK || r === undefined) {
        return; // first step: Back/Esc both cancel
      }
      label = r;
      step = 1;
    } else if (step === 1) {
      const r = await inputStep({
        title: "Endpoint address (Base URL)",
        step: 2,
        totalSteps,
        value: baseUrl,
        placeHolder: defaultBaseUrl(tool) || "https://your-gateway.com/v1",
        validate: validateBaseUrl,
        showBack: true,
      });
      if (r === undefined) {
        return; // Esc cancels the whole flow
      }
      if (r === BACK) {
        step = 0;
        continue;
      }
      baseUrl = r;
      step = 2;
    } else {
      const what = getAdapter(tool).secretLabel;
      const r = await inputStep({
        title: `${TOOL_LABELS[tool]} ${what}`,
        step: 3,
        totalSteps,
        value: "",
        password: true,
        placeHolder: existing ? "(leave blank to keep current)" : `Paste the ${what}`,
        showBack: true,
      });
      if (r === undefined) {
        return;
      }
      if (r === BACK) {
        step = 1;
        continue;
      }
      secret = r;
      step = 3;
    }
  }
  if (secret === undefined) {
    return;
  }

  const id = existing?.id ?? newId();
  const adapter = getAdapter(tool);
  const profile: GatewayProfile = {
    id,
    tool,
    label: label.trim(),
    baseUrl: baseUrl.trim(),
    providerName: adapter.usesNamedProvider
      ? existing?.providerName ?? adapter.providerNameFor?.({ id, tool, label: label.trim(), baseUrl: baseUrl.trim() })
      : undefined,
  };
  await store.upsert(profile, secret === "" ? undefined : secret);
  refreshStatusBar();

  // Secret available to test: the one just entered, or the stored one if blank-kept.
  const effectiveSecret = secret !== "" ? secret : await store.getSecret(profile.id);

  // If this profile is currently active, offer to re-apply the updated config.
  if (store.getActive(profile.tool) === profile.id) {
    const reapply = await vscode.window.showInformationMessage(
      `"${profile.label}" is in use right now. Apply your changes to ${TOOL_LABELS[profile.tool]} now?`,
      "Apply now",
      "Test connection",
      "Later"
    );
    if (reapply === "Apply now") {
      if (effectiveSecret) {
        try {
          await applyProfileWithSecret(profile.tool, profile, effectiveSecret);
          vscode.window.showInformationMessage(
            `Zion: applied updated "${profile.label}".`
          );
        } catch (e: any) {
          vscode.window.showErrorMessage(
            `Zion: re-apply failed: ${e?.message ?? e}`
          );
        }
      }
    } else if (reapply === "Test connection" && effectiveSecret) {
      await runConnectionTest(profile.tool, profile.baseUrl, effectiveSecret);
    }
  } else {
    const choice = await vscode.window.showInformationMessage(
      `Zion: saved "${profile.label}" for ${TOOL_LABELS[tool]}.`,
      ...(effectiveSecret ? ["Test connection"] : [])
    );
    if (choice === "Test connection" && effectiveSecret) {
      await runConnectionTest(profile.tool, profile.baseUrl, effectiveSecret);
    }
  }
}

async function editProfile(): Promise<void> {
  const profile = await pickGatewayProfile("Edit which profile?");
  if (profile) {
    await addOrEditProfile(profile);
  }
}

async function deleteProfile(): Promise<void> {
  const profile = await pickGatewayProfile("Delete which profile?");
  if (profile) {
    await deleteProfileById(profile);
  }
}

async function deleteProfileById(profile: GatewayProfile): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Delete profile "${profile.label}"?`,
    { modal: true },
    "Delete"
  );
  if (confirm !== "Delete") {
    return;
  }
  const wasActiveFor = await store.delete(profile.id);
  refreshStatusBar();

  if (wasActiveFor.length > 0) {
    const toolList = wasActiveFor.map((t) => TOOL_LABELS[t]).join(", ");
    const restore = await vscode.window.showWarningMessage(
      `${toolList} ${wasActiveFor.length > 1 ? "are" : "is"} still using "${profile.label}". Switch back to your own login now?`,
      "Switch back",
      "Leave as-is"
    );
    if (restore === "Switch back") {
      for (const tool of wasActiveFor) {
        try {
          await restoreNative(tool);
        } catch (e: any) {
          vscode.window.showErrorMessage(
            `Zion: restore failed for : ${e?.message ?? e}`
          );
        }
      }
      vscode.window.showInformationMessage(
        `Zion: deleted "${profile.label}" and switched back to your own login.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Zion: deleted "${profile.label}". Nothing else changed. Switch whenever you're ready.`
      );
    }
  } else {
    vscode.window.showInformationMessage(`Zion: deleted "${profile.label}".`);
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "•".repeat(secret.length);
  }
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

async function viewProfileDetails(profile: GatewayProfile): Promise<void> {
  const secret = await store.getSecret(profile.id);
  const adapter = getAdapter(profile.tool);
  const what = adapter.secretLabel.charAt(0).toUpperCase() + adapter.secretLabel.slice(1);

  type DetailAction = "copy" | "edit" | "test";
  interface DetailItem extends vscode.QuickPickItem {
    action?: DetailAction;
  }

  const rows: DetailItem[] = [
    { label: `$(tools) Tool`, description: TOOL_LABELS[profile.tool] },
    { label: `$(tag) Label`, description: profile.label },
    { label: `$(link) Base URL`, description: profile.baseUrl },
  ];
  if (adapter.usesNamedProvider && profile.providerName) {
    rows.push({ label: `$(symbol-key) Provider`, description: profile.providerName });
  }
  rows.push({
    label: `$(lock) ${what}`,
    description: secret ? maskSecret(secret) : "(none stored)",
  });
  rows.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  if (secret) {
    rows.push({ label: `$(plug) Test connection`, action: "test" });
    rows.push({ label: `$(copy) Reveal & copy ${what.toLowerCase()}`, action: "copy" });
  }
  rows.push({ label: `$(edit) Edit this profile`, action: "edit" });

  const pick = await vscode.window.showQuickPick(rows, {
    title: `Profile: ${profile.label}`,
    matchOnDescription: false,
  });
  if (!pick?.action) {
    return;
  }
  if (pick.action === "test" && secret) {
    await runConnectionTest(profile.tool, profile.baseUrl, secret);
  } else if (pick.action === "copy" && secret) {
    await vscode.env.clipboard.writeText(secret);
    vscode.window.showInformationMessage(
      `Zion: ${what.toLowerCase()} for "${profile.label}" copied to clipboard.`
    );
  } else if (pick.action === "edit") {
    await addOrEditProfile(profile);
  }
}

async function recaptureOriginal(): Promise<void> {
  const tool = await pickTool("Update the backup of your own login for which tool?");
  if (!tool) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Save the current ${TOOL_LABELS[tool]} login as your new "Native login" backup? ` +
      `Only do this when ${TOOL_LABELS[tool]} is on your own account right now, not a custom endpoint.`,
    { modal: true },
    "Save backup"
  );
  if (confirm !== "Save backup") {
    return;
  }
  await captureOriginal(extContext, tool);
  await store.setActive(tool, ORIGINAL_ID);
  refreshStatusBar();
  vscode.window.showInformationMessage(`Zion: saved your ${TOOL_LABELS[tool]} login as the new backup.`);
}

async function openConfigFiles(): Promise<void> {
  const files = ADAPTERS.flatMap((a) => a.files(ctxFor(a.id)));
  if (files.length === 0) {
    vscode.window.showInformationMessage("Zion: no tool config files found yet.");
    return;
  }
  const pick = await vscode.window.showQuickPick(files, {
    title: "Open a config file",
  });
  if (pick) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pick));
    await vscode.window.showTextDocument(doc);
  }
}

// ---------------------------------------------------------------------------
// Clean / reset
// ---------------------------------------------------------------------------

interface CleanItem extends vscode.QuickPickItem {
  id: "undo" | "everything";
}

async function cleanReset(): Promise<void> {
  const items: CleanItem[] = [
    {
      id: "undo",
      label: "$(discard) Switch back to my own login",
      detail:
        "Put the tool back on your own account. Your saved endpoints stay, so you can switch again later.",
    },
    {
      id: "everything",
      label: "$(warning) Reset everything",
      detail:
        "Back to your own login, then erase saved endpoints, keys, and all backups. Like a fresh install.",
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Zion: clean up",
    placeHolder: "Your settings are backed up before anything changes",
  });
  if (!picked) {
    return;
  }

  // Let the user pick which tools to act on (default: both selected).
  const tools = await pickTools("Clean up which tools?");
  if (!tools || tools.length === 0) {
    return;
  }

  // Both options switch back to native; "everything" additionally wipes saved
  // endpoints, keys, the original-login backup, and the dated backup files.
  const doEverything = picked.id === "everything";

  const toolList = tools.map((t) => TOOL_LABELS[t]).join(" & ");
  const confirm = await vscode.window.showWarningMessage(
    `${picked.label.replace(/^\$\([^)]+\)\s*/, "")} (${toolList})?\n\n${picked.detail}`,
    { modal: true },
    "Proceed"
  );
  if (confirm !== "Proceed") {
    return;
  }

  const done: string[] = [];

  // Always: switch the chosen tools back to native.
  const switched: string[] = [];
  for (const tool of tools) {
    const changed = await getAdapter(tool).removeGateway(ctxFor(tool));
    await store.setActive(tool, ORIGINAL_ID);
    switched.push(`${TOOL_LABELS[tool]}: ${changed ? "done" : "already native"}`);
  }
  done.push(`switched back to your own login (${switched.join(", ")})`);

  if (doEverything) {
    let n = 0;
    for (const tool of tools) {
      await store.clearForTool(tool);
      forgetOriginal(extContext, tool);
      n += purgeBackups(extContext, tool);
      await store.clearOwnedProviders(tool);
    }
    done.push(`erased ${toolList} endpoints, keys, and ${n} backup file(s)`);
  }

  refreshStatusBar();
  vscode.window.showInformationMessage(`Zion: ${done.join("; ")}.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pickTool(title: string): Promise<Tool | undefined> {
  const pick = await vscode.window.showQuickPick(
    TOOLS.map((t) => ({ label: TOOL_LABELS[t], tool: t })),
    { title }
  );
  return pick?.tool;
}

/** Pick one or more tools. Both are pre-selected so the default is "act on all". */
async function pickTools(title: string): Promise<Tool[] | undefined> {
  interface ToolItem extends vscode.QuickPickItem {
    tool: Tool;
  }
  const items: ToolItem[] = TOOLS.map((t) => ({
    label: TOOL_LABELS[t],
    tool: t,
    picked: true,
  }));
  const picks = await vscode.window.showQuickPick(items, {
    title,
    canPickMany: true,
    placeHolder: "Space to toggle, Enter to confirm (both selected by default)",
  });
  return picks?.map((p) => p.tool);
}

async function pickGatewayProfile(title: string): Promise<GatewayProfile | undefined> {
  const all = store.list();
  if (all.length === 0) {
    vscode.window.showInformationMessage("Zion: you haven't added any custom endpoints yet.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    all.map((p) => ({
      label: `${TOOL_LABELS[p.tool]}: ${p.label}`,
      detail: p.baseUrl,
      profile: p,
    })),
    { title, matchOnDetail: true }
  );
  return pick?.profile;
}

// Sentinel returned by inputStep when the user pressed the Back button.
const BACK = Symbol("back");

interface InputStepOpts {
  title: string;
  step: number;
  totalSteps: number;
  value: string;
  placeHolder?: string;
  password?: boolean;
  showBack: boolean;
  validate?: (v: string) => string | undefined;
}

/**
 * One step of a multi-step wizard built on createInputBox. Resolves to the
 * entered string, BACK if the Back button was pressed, or undefined on cancel
 * (Esc). Keeps the typed value so the caller can re-seed earlier/later steps.
 */
function inputStep(opts: InputStepOpts): Promise<string | typeof BACK | undefined> {
  const box = vscode.window.createInputBox();
  box.title = opts.title;
  box.step = opts.step;
  box.totalSteps = opts.totalSteps;
  box.value = opts.value;
  box.placeholder = opts.placeHolder;
  box.password = opts.password ?? false;
  box.ignoreFocusOut = true;
  box.buttons = opts.showBack ? [vscode.QuickInputButtons.Back] : [];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: string | typeof BACK | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      box.hide();
      box.dispose();
      resolve(r);
    };
    box.onDidTriggerButton((b) => {
      if (b === vscode.QuickInputButtons.Back) {
        finish(BACK);
      }
    });
    box.onDidAccept(() => {
      const err = opts.validate?.(box.value);
      if (err) {
        box.validationMessage = err;
        return;
      }
      finish(box.value);
    });
    box.onDidHide(() => finish(undefined));
    box.show();
  });
}

function promptSecret(tool: Tool, hint?: string): Thenable<string | undefined> {
  const what = getAdapter(tool).secretLabel;
  return vscode.window.showInputBox({
    title: `${TOOL_LABELS[tool]} ${what}`,
    password: true,
    placeHolder: hint ?? `Paste the ${what}`,
    ignoreFocusOut: true,
  });
}

/** Validate a base URL: required, no surrounding whitespace, parseable http(s) URL. */
function validateBaseUrl(v: string): string | undefined {
  if (!v.trim()) {
    return "Base URL is required";
  }
  if (v !== v.trim()) {
    return "Remove the leading/trailing spaces";
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return "Enter a full URL, e.g. https://gateway.example.com/v1";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL must start with http:// or https://";
  }
  return undefined;
}

/** Build the `…/models` URL for a base URL, tolerating a trailing `/v1`. */
function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

/**
 * Probe a gateway with the given secret by GETting its models list. Returns a
 * human-readable result; never throws. Runs under a progress notification.
 */
async function testConnection(
  tool: Tool,
  baseUrl: string,
  secret: string
): Promise<{ ok: boolean; detail: string }> {
  const url = modelsUrl(baseUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    ...getAdapter(tool).testHeaders?.(secret),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (res.ok) {
      let count: number | undefined;
      try {
        const body: any = await res.json();
        if (Array.isArray(body?.data)) {
          count = body.data.length;
        }
      } catch {
        /* non-JSON 200 is still a reachable endpoint */
      }
      return {
        ok: true,
        detail: count !== undefined ? `${count} model(s) available` : `HTTP ${res.status}`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `Auth rejected (HTTP ). Check the key` };
    }
    return { ok: false, detail: `HTTP ${res.status} ${res.statusText}` };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return { ok: false, detail: "Timed out after 10s. Check the base URL or network" };
    }
    return { ok: false, detail: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Run testConnection with a progress spinner and surface the result as a toast. */
async function runConnectionTest(tool: Tool, baseUrl: string, secret: string): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Zion: testing ${modelsUrl(baseUrl)}…` },
    () => testConnection(tool, baseUrl, secret)
  );
  if (result.ok) {
    vscode.window.showInformationMessage(`Zion: connection OK: ${result.detail}.`);
  } else {
    vscode.window.showErrorMessage(`Zion: connection failed: ${result.detail}.`);
  }
}

function defaultBaseUrl(tool: Tool): string {
  const configured = vscode.workspace
    .getConfiguration("zion")
    .get<string>(`defaultBaseUrl.${tool}`, "")
    .trim();
  if (configured) {
    return configured;
  }
  // No built-in default: the field starts blank and the placeholder shows the
  // expected shape. Set `zion.defaultBaseUrl.*` to pre-fill your own endpoint.
  return "";
}

function newId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
