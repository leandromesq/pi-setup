/**
 * Lelezonio Pi Kit
 *
 * Manages which extensions from this personal Pi kit are loaded.
 * Writes package resource filters to the matching Pi settings file, then reloads Pi.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, Text, type AutocompleteItem, type SelectItem, truncateToWidth } from "@earendil-works/pi-tui";

type PackageEntry = string | ({ source?: string; extensions?: string[] } & Record<string, unknown>);
type Settings = Record<string, unknown> & { packages?: PackageEntry[] };

type SetupAction = "save" | "cancel";

interface ExtensionDefinition {
  id: string;
  label: string;
  path: string;
  description: string;
  locked?: boolean;
  minimal?: boolean;
  dependencies?: string[];
}

interface PresetDefinition {
  enabledExtensions: string[];
  updatedAt?: string;
}

type PresetFile = Record<string, PresetDefinition | string[]> | { presets?: Record<string, PresetDefinition | string[]> };

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function presetsPath(): string {
  return join(getAgentDir(), "lelezonio-pi-kit-presets.json");
}
const CURRENT_PACKAGE_SOURCE = "git:github.com/leandromesq/lelezonio-pi-kit";
const PACKAGE_SOURCE_ALIASES = [
  CURRENT_PACKAGE_SOURCE,
  "npm:lelezonio-pi-kit",
  "lelezonio-pi-kit",
  "npm:@leandromesq/lelezonio-pi-kit",
  "@leandromesq/lelezonio-pi-kit",
  // Backward-compatible matches for installations made before the rename.
  "git:github.com/leandromesq/pi-setup",
  "npm:@leandromesq/pi-setup",
  "@leandromesq/pi-setup",
];

const MANAGER_ID = "lelezonio-pi-kit";

const EXTENSIONS: ExtensionDefinition[] = [
  {
    id: MANAGER_ID,
    label: "Lelezonio Pi Kit",
    path: "./extensions/lelezonio-pi-kit/index.ts",
    description: "Checkbox menu, package filters, and kit presets.",
    locked: true,
    minimal: true,
  },
  {
    id: "favs",
    label: "Model favorites",
    path: "./extensions/favs/index.ts",
    description: "Favorite model slots and shortcuts.",
    minimal: true,
  },
  {
    id: "git-pr",
    label: "Git PR workflow",
    path: "./extensions/git-pr/index.ts",
    description: "Guarded GitHub PR creation workflow.",
  },
  {
    id: "pi-update",
    label: "Pi updater",
    path: "./extensions/pi-update/index.ts",
    description: "Update Pi and installed packages from inside Pi.",
    minimal: true,
  },
  {
    id: "pwsh-user-bash",
    label: "PowerShell user bash",
    path: "./extensions/pwsh-user-bash/index.ts",
    description: "Use PowerShell 7 for user ! shell commands on Windows.",
    minimal: true,
  },
  {
    id: "scratchpad",
    label: "Scratchpad",
    path: "./extensions/scratchpad/index.ts",
    description: "Persistent pinned notes above the editor.",
  },
  {
    id: "yeet",
    label: "Yeet",
    path: "./extensions/yeet/index.ts",
    description: "Commit and push workflow shortcut.",
  },
  {
    id: "diff",
    label: "Diff tracker",
    path: "./extensions/diff/index.ts",
    description: "Track files changed during the last agent run.",
  },
  {
    id: "zed",
    label: "Zed opener",
    path: "./extensions/zed/index.ts",
    description: "Open the current directory in Zed.",
    minimal: true,
  },
  {
    id: "subagents",
    label: "Subagents",
    path: "./extensions/subagents/index.ts",
    description: "Subagent tool and bundled agent definitions.",
  },
  {
    id: "orchestrator",
    label: "Foreground agents",
    path: "./extensions/orchestrator/index.ts",
    description: "Foreground agent selector and background-agent routing.",
    dependencies: ["subagents"],
  },
  {
    id: "theme-cycler",
    label: "Theme cycler",
    path: "./extensions/theme-cycler/index.ts",
    description: "Theme picker and next/previous shortcuts.",
    minimal: true,
  },
  {
    id: "pi-ui",
    label: "Custom Pi UI",
    path: "./extensions/pi-ui/index.ts",
    description: "Custom header, footer, editor styling, and text stash.",
  },
  {
    id: "usage-bar",
    label: "Usage bars",
    path: "./extensions/usage-bar/index.ts",
    description: "Provider quota and reset countdown overlay.",
  },
];

const EXTENSION_BY_ID = new Map(EXTENSIONS.map((extension) => [extension.id, extension]));

function allExtensionIds(): string[] {
  return EXTENSIONS.map((extension) => extension.id);
}

function packageFilterPath(extension: ExtensionDefinition): string {
  return extension.path.replace(/^\.\//, "");
}

function minimalExtensionIds(): string[] {
  return EXTENSIONS.filter((extension) => extension.locked || extension.minimal).map((extension) => extension.id);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function packageEntrySource(entry: PackageEntry): string | undefined {
  return typeof entry === "string" ? entry : entry.source;
}

function pathLikeSource(source: string): boolean {
  return source.startsWith(".") || source.startsWith("/") || source.startsWith("~") || /^[A-Za-z]:[\\/]/.test(source);
}

function resolveSourcePath(source: string, baseDir: string): string | undefined {
  if (!pathLikeSource(source)) return undefined;
  const expanded = source.startsWith("~") ? join(homedir(), source.slice(1)) : source;
  return resolve(baseDir, expanded);
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sourceMatchesThisPackage(source: string | undefined, settingsDir: string): boolean {
  if (!source) return false;
  const configuredSource = process.env.PI_KIT_PACKAGE_SOURCE ?? process.env.PI_SETUP_PACKAGE_SOURCE;
  if (configuredSource && source === configuredSource) return true;
  if (PACKAGE_SOURCE_ALIASES.includes(source)) return true;
  if (source.includes("github.com/leandromesq/lelezonio-pi-kit")) return true;
  if (source.includes("lelezonio-pi-kit")) return true;
  if (source.includes("github.com/leandromesq/pi-setup")) return true;
  if (source.includes("@leandromesq/pi-setup")) return true;

  const resolvedSource = resolveSourcePath(source, settingsDir);
  return resolvedSource ? samePath(resolvedSource, PACKAGE_ROOT) : false;
}

function canonicalPackageSource(source: string | undefined): string {
  if (!source) return CURRENT_PACKAGE_SOURCE;
  if (
    source === "git:github.com/leandromesq/pi-setup" ||
    source === "npm:@leandromesq/pi-setup" ||
    source === "@leandromesq/pi-setup" ||
    source.includes("github.com/leandromesq/pi-setup")
  ) {
    return CURRENT_PACKAGE_SOURCE;
  }
  return source;
}

function findPackageEntry(settings: Settings, settingsPath: string): { index: number; entry: PackageEntry } | undefined {
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const settingsDir = dirname(settingsPath);
  for (let index = 0; index < packages.length; index += 1) {
    const entry = packages[index];
    if (sourceMatchesThisPackage(packageEntrySource(entry), settingsDir)) return { index, entry };
  }
  return undefined;
}

async function findTargetSettings(cwd: string): Promise<{ path: string; settings: Settings; found?: { index: number; entry: PackageEntry } }> {
  const candidates = [projectSettingsPath(cwd), globalSettingsPath()];

  for (const path of candidates) {
    const settings = await readJson<Settings>(path, {});
    const found = findPackageEntry(settings, path);
    if (found) return { path, settings, found };
  }

  const path = globalSettingsPath();
  return { path, settings: await readJson<Settings>(path, {}) };
}

function patternMatchesExtension(pattern: string, extension: ExtensionDefinition): boolean {
  const normalizedPattern = pattern.replace(/^\.\//, "").replace(/\\/g, "/");
  const normalizedPath = packageFilterPath(extension).replace(/\\/g, "/");
  if (normalizedPattern === normalizedPath || normalizedPattern === extension.id) return true;
  if (!normalizedPattern.includes("*") && !normalizedPattern.includes("?")) return false;

  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(normalizedPath);
}

function enabledIdsFromEntry(entry: PackageEntry | undefined): Set<string> {
  if (!entry || typeof entry === "string" || !Array.isArray(entry.extensions)) {
    return new Set(allExtensionIds());
  }

  if (entry.extensions.length === 0) return normalizeSelection([]);

  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];

  for (const filter of entry.extensions) {
    if (filter.startsWith("+")) forceIncludes.push(filter.slice(1));
    else if (filter.startsWith("-")) forceExcludes.push(filter.slice(1));
    else if (filter.startsWith("!")) excludes.push(filter.slice(1));
    else includes.push(filter);
  }

  const enabled = new Set<string>();
  const startingExtensions = includes.length === 0
    ? EXTENSIONS
    : EXTENSIONS.filter((extension) => includes.some((pattern) => patternMatchesExtension(pattern, extension)));

  for (const extension of startingExtensions) enabled.add(extension.id);
  for (const extension of EXTENSIONS) {
    if (excludes.some((pattern) => patternMatchesExtension(pattern, extension))) enabled.delete(extension.id);
    if (forceIncludes.some((pattern) => patternMatchesExtension(pattern, extension))) enabled.add(extension.id);
    if (forceExcludes.some((pattern) => patternMatchesExtension(pattern, extension))) enabled.delete(extension.id);
  }

  return normalizeSelection(enabled);
}

function normalizeSelection(selection: Iterable<string>): Set<string> {
  const normalized = new Set<string>();
  for (const id of selection) {
    if (EXTENSION_BY_ID.has(id)) normalized.add(id);
  }

  normalized.add(MANAGER_ID);

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Array.from(normalized)) {
      const extension = EXTENSION_BY_ID.get(id);
      for (const dependency of extension?.dependencies ?? []) {
        if (!normalized.has(dependency)) {
          normalized.add(dependency);
          changed = true;
        }
      }
    }
  }

  return normalized;
}

function disableWithDependents(selection: Set<string>, id: string): Set<string> {
  if (id === MANAGER_ID) return selection;
  const next = new Set(selection);
  const removeQueue = [id];

  for (let index = 0; index < removeQueue.length; index += 1) {
    const current = removeQueue[index];
    next.delete(current);
    for (const extension of EXTENSIONS) {
      if (extension.dependencies?.includes(current) && next.has(extension.id)) {
        removeQueue.push(extension.id);
      }
    }
  }

  return normalizeSelection(next);
}

function toggleSelection(selection: Set<string>, id: string): Set<string> {
  const extension = EXTENSION_BY_ID.get(id);
  if (!extension || extension.locked) return selection;
  if (selection.has(id)) return disableWithDependents(selection, id);
  const next = new Set(selection);
  next.add(id);
  return normalizeSelection(next);
}

function updatePackageEntry(settings: Settings, settingsPath: string, enabledIds: Iterable<string>): Settings {
  const selection = normalizeSelection(enabledIds);
  const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
  const found = findPackageEntry({ ...settings, packages }, settingsPath);
  const enabledPaths = EXTENSIONS.filter((extension) => selection.has(extension.id)).map(packageFilterPath);

  if (!found) {
    packages.push({ source: CURRENT_PACKAGE_SOURCE, extensions: enabledPaths });
    return { ...settings, packages };
  }

  const source = canonicalPackageSource(packageEntrySource(found.entry));
  const nextEntry = typeof found.entry === "string" ? { source } : { ...found.entry, source };
  nextEntry.extensions = enabledPaths;
  packages[found.index] = nextEntry;
  return { ...settings, packages };
}

async function getCurrentSelection(cwd: string): Promise<Set<string>> {
  const target = await findTargetSettings(cwd);
  return enabledIdsFromEntry(target.found?.entry);
}

async function saveSelection(enabledIds: Iterable<string>, cwd: string): Promise<Set<string>> {
  const selection = normalizeSelection(enabledIds);
  const target = await findTargetSettings(cwd);
  await writeJson(target.path, updatePackageEntry(target.settings, target.path, selection));
  return selection;
}

function formatExtensionList(selection: Set<string>): string {
  return EXTENSIONS.map((extension) => `${selection.has(extension.id) ? "☑" : "☐"} ${extension.id}`).join("\n");
}

function parsePresetFile(raw: PresetFile): Record<string, PresetDefinition> {
  const source = "presets" in raw && raw.presets ? raw.presets : raw;
  const presets: Record<string, PresetDefinition> = {};

  for (const [name, value] of Object.entries(source)) {
    if (name === "presets") continue;
    if (Array.isArray(value)) {
      presets[name] = { enabledExtensions: value };
    } else if (value && typeof value === "object" && Array.isArray((value as PresetDefinition).enabledExtensions)) {
      presets[name] = value as PresetDefinition;
    }
  }

  return presets;
}

async function loadPresets(): Promise<Record<string, PresetDefinition>> {
  return parsePresetFile(await readJson<PresetFile>(presetsPath(), {}));
}

async function writePresets(presets: Record<string, PresetDefinition>): Promise<void> {
  await writeJson(presetsPath(), { presets });
}

function presetNamesWithBuiltIns(presets: Record<string, PresetDefinition>): string[] {
  return ["full", "minimal", ...Object.keys(presets).filter((name) => name !== "full" && name !== "minimal").sort()];
}

function resolvePreset(name: string, presets: Record<string, PresetDefinition>): PresetDefinition | undefined {
  if (name === "full") return { enabledExtensions: allExtensionIds() };
  if (name === "minimal") return { enabledExtensions: minimalExtensionIds() };
  return presets[name];
}

async function saveCurrentAsPreset(name: string, cwd: string): Promise<PresetDefinition> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("Preset name is required.");
  if (["full", "minimal"].includes(normalizedName)) throw new Error(`"${normalizedName}" is a built-in preset and cannot be overwritten.`);

  const presets = await loadPresets();
  const selection = await getCurrentSelection(cwd);
  const preset = { enabledExtensions: Array.from(selection), updatedAt: new Date().toISOString() };
  presets[normalizedName] = preset;
  await writePresets(presets);
  return preset;
}

async function applyNamedPreset(name: string, ctx: ExtensionCommandContext): Promise<void> {
  const presets = await loadPresets();
  const preset = resolvePreset(name, presets);
  if (!preset) {
    ctx.ui.notify(`Unknown setup preset "${name}". Available: ${presetNamesWithBuiltIns(presets).join(", ")}`, "error");
    return;
  }

  const selection = await saveSelection(preset.enabledExtensions, ctx.cwd);
  ctx.ui.notify(`Setup preset "${name}" saved to settings. Reloading with ${selection.size}/${EXTENSIONS.length} extensions.`, "info");
  await ctx.reload();
}

function buildPresetDescription(name: string, preset: PresetDefinition): string {
  const selection = normalizeSelection(preset.enabledExtensions);
  const count = selection.size;
  const suffix = name === "full" || name === "minimal" ? "built-in" : preset.updatedAt ? `saved ${preset.updatedAt.slice(0, 10)}` : "saved";
  return `${count}/${EXTENSIONS.length} extensions, ${suffix}`;
}

class SetupCheckboxMenu {
  private selectedIndex = 0;
  private readonly selection: Set<string>;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    initialSelection: Set<string>,
    private readonly theme: any,
    private readonly done: (result: { action: SetupAction; enabledExtensions: string[] }) => void,
  ) {
    this.selection = new Set(initialSelection);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(EXTENSIONS.length - 1, this.selectedIndex + 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.space)) {
      const id = EXTENSIONS[this.selectedIndex]?.id;
      if (id) {
        const next = toggleSelection(this.selection, id);
        this.selection.clear();
        for (const nextId of next) this.selection.add(nextId);
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.enter) || data.toLowerCase() === "s") {
      this.done({ action: "save", enabledExtensions: Array.from(normalizeSelection(this.selection)) });
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done({ action: "cancel", enabledExtensions: [] });
      return;
    }
    if (data.toLowerCase() === "a") {
      this.selection.clear();
      for (const id of allExtensionIds()) this.selection.add(id);
      this.invalidate();
      return;
    }
    if (data.toLowerCase() === "m") {
      this.selection.clear();
      for (const id of minimalExtensionIds()) this.selection.add(id);
      this.invalidate();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    lines.push(this.theme.fg("accent", this.theme.bold("Lelezonio Pi Kit extensions")));
    lines.push(this.theme.fg("dim", "Space toggles, Enter or s saves and reloads, Esc cancels, a all, m minimal"));
    lines.push("");

    for (let index = 0; index < EXTENSIONS.length; index += 1) {
      const extension = EXTENSIONS[index];
      const selected = index === this.selectedIndex;
      const checked = this.selection.has(extension.id) ? "☑" : "☐";
      const lock = extension.locked ? " locked" : "";
      const deps = extension.dependencies?.length ? ` needs ${extension.dependencies.join(",")}` : "";
      const prefix = selected ? "›" : " ";
      const raw = `${prefix} ${checked} ${extension.id.padEnd(18)} ${extension.label}${lock}${deps} · ${extension.description}`;
      const truncated = truncateToWidth(raw, Math.max(1, width));
      lines.push(selected ? this.theme.fg("accent", truncated) : truncated);
    }

    lines.push("");
    lines.push(this.theme.fg("muted", `${this.selection.size}/${EXTENSIONS.length} selected. ${MANAGER_ID} is always kept on so you cannot lock yourself out.`));

    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, Math.max(1, width)));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

async function showSetupMenu(ctx: ExtensionCommandContext): Promise<void> {
  const initialSelection = await getCurrentSelection(ctx.cwd);

  const result = await ctx.ui.custom<{ action: SetupAction; enabledExtensions: string[] }>((tui, theme, _kb, done) => {
    const menu = new SetupCheckboxMenu(initialSelection, theme, done);
    return {
      render(width: number) {
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        return [...border.render(width), ...menu.render(width), ...border.render(width)];
      },
      invalidate() {
        menu.invalidate();
      },
      handleInput(data: string) {
        menu.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!result || result.action === "cancel") return;

  const selection = await saveSelection(result.enabledExtensions, ctx.cwd);
  ctx.ui.notify(`Saved ${selection.size}/${EXTENSIONS.length} Lelezonio Pi Kit extensions. Reloading Pi.`, "info");
  await ctx.reload();
}

async function showPresetSelector(ctx: ExtensionCommandContext): Promise<void> {
  const presets = await loadPresets();
  const names = presetNamesWithBuiltIns(presets);
  const items: SelectItem[] = names.map((name) => {
    const preset = resolvePreset(name, presets)!;
    return { value: name, label: name, description: buildPresetDescription(name, preset) };
  });

  const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const list = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);

    return {
      render(width: number) {
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        return [
          ...border.render(width),
          ...new Text(theme.fg("accent", theme.bold("Lelezonio Pi Kit presets")), 0, 0).render(width),
          ...list.render(width),
          theme.fg("dim", "Type to filter, Enter applies, Esc cancels"),
          ...border.render(width),
        ];
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data: string) {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (choice) await applyNamedPreset(choice, ctx);
}

function parseSetupArgs(args: string): { command: string; rest: string } {
  const trimmed = args.trim();
  const [command = "", ...restParts] = trimmed.split(/\s+/);
  return { command: command.toLowerCase(), rest: restParts.join(" ").trim() };
}

function resolveExtensionId(input: string): string | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  return EXTENSIONS.find((extension) => extension.id === normalized || extension.label.toLowerCase() === normalized)?.id;
}

export default function piSetupManager(pi: ExtensionAPI) {
  async function applySelectionAndReload(selection: Iterable<string>, ctx: ExtensionCommandContext, message: string): Promise<void> {
    const saved = await saveSelection(selection, ctx.cwd);
    ctx.ui.notify(`${message} Reloading with ${saved.size}/${EXTENSIONS.length} extensions.`, "info");
    await ctx.reload();
  }

  async function handlePresetCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const { command, rest } = parseSetupArgs(args);

    if (!command) {
      await showPresetSelector(ctx);
      return;
    }

    if (command === "save") {
      const name = rest || await ctx.ui.input("Save setup preset", "preset name");
      if (!name) return;
      await saveCurrentAsPreset(name, ctx.cwd);
      ctx.ui.notify(`Saved setup preset "${name}".`, "info");
      return;
    }

    if (command === "delete" || command === "rm") {
      const name = rest;
      if (!name) {
        ctx.ui.notify("Usage: /preset delete <name>", "warning");
        return;
      }
      if (["full", "minimal"].includes(name)) {
        ctx.ui.notify(`"${name}" is a built-in preset and cannot be deleted.`, "warning");
        return;
      }
      const presets = await loadPresets();
      if (!presets[name]) {
        ctx.ui.notify(`No saved setup preset named "${name}".`, "warning");
        return;
      }
      delete presets[name];
      await writePresets(presets);
      ctx.ui.notify(`Deleted setup preset "${name}".`, "info");
      return;
    }

    if (command === "list") {
      const presets = await loadPresets();
      const lines = presetNamesWithBuiltIns(presets).map((name) => {
        const preset = resolvePreset(name, presets)!;
        return `${name}: ${buildPresetDescription(name, preset)}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    await applyNamedPreset(args.trim(), ctx);
  }

  pi.registerCommand("setup", {
    description: "Manage which personal setup extensions are loaded",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const query = prefix.trim().toLowerCase();
      const commands = ["status", "enable", "disable", "toggle", "full", "minimal", "save", "use", "list", "delete"];
      const extensionItems = EXTENSIONS.map((extension) => ({ value: extension.id, label: extension.id, description: extension.description }));
      const commandItems = commands.map((command) => ({ value: command, label: command, description: `/setup ${command}` }));
      const items = [...commandItems, ...extensionItems].filter((item) => !query || item.value.toLowerCase().includes(query));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const { command, rest } = parseSetupArgs(args ?? "");

      if (!command) {
        await showSetupMenu(ctx);
        return;
      }

      if (command === "status") {
        const selection = await getCurrentSelection(ctx.cwd);
        ctx.ui.notify(formatExtensionList(selection), "info");
        return;
      }

      if (command === "full") {
        await applySelectionAndReload(allExtensionIds(), ctx, "Enabled all setup extensions.");
        return;
      }

      if (command === "minimal") {
        await applySelectionAndReload(minimalExtensionIds(), ctx, "Applied the minimal setup profile.");
        return;
      }

      if (command === "enable" || command === "disable" || command === "toggle") {
        const id = resolveExtensionId(rest);
        if (!id) {
          ctx.ui.notify(`Usage: /setup ${command} <extension>\nExtensions: ${allExtensionIds().join(", ")}`, "warning");
          return;
        }
        const current = await getCurrentSelection(ctx.cwd);
        const next = command === "enable"
          ? normalizeSelection(new Set([...current, id]))
          : command === "disable"
            ? disableWithDependents(current, id)
            : toggleSelection(current, id);
        await applySelectionAndReload(next, ctx, `${command} ${id}.`);
        return;
      }

      if (command === "save") {
        const name = rest || await ctx.ui.input("Save setup preset", "preset name");
        if (!name) return;
        await saveCurrentAsPreset(name, ctx.cwd);
        ctx.ui.notify(`Saved setup preset "${name}".`, "info");
        return;
      }

      if (command === "use") {
        if (!rest) {
          await showPresetSelector(ctx);
          return;
        }
        await applyNamedPreset(rest, ctx);
        return;
      }

      if (command === "list") {
        await handlePresetCommand("list", ctx);
        return;
      }

      if (command === "delete" || command === "rm") {
        await handlePresetCommand(`delete ${rest}`, ctx);
        return;
      }

      ctx.ui.notify("Usage: /setup, /setup status, /setup enable|disable|toggle <extension>, /setup full, /setup minimal, /setup save <name>, /setup use <name>", "warning");
    },
  });

  pi.registerCommand("preset", {
    description: "Select, save, apply, or delete Lelezonio Pi Kit presets",
    getArgumentCompletions: (): AutocompleteItem[] | null => null,
    handler: async (args, ctx) => {
      await handlePresetCommand(args ?? "", ctx);
    },
  });
}
