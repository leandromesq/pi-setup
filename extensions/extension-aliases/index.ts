import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

type SourceInfo = {
  source?: string;
  scope?: "user" | "project" | "temporary";
};

type AliasMap = Record<string, string>;

const DEFAULT_ALIASES: AliasMap = {
  "git:github.com/leandromesq/pi-setup": "pi-setup",
  "git:https://github.com/leandromesq/pi-setup": "pi-setup",
  "https://github.com/leandromesq/pi-setup": "pi-setup",
  "npm:@leandromesq/pi-setup": "pi-setup",
};

function loadAliases(): AliasMap {
  const raw = process.env.PI_EXTENSION_ALIASES;
  if (!raw) return DEFAULT_ALIASES;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_ALIASES;
    }
    return { ...DEFAULT_ALIASES, ...(parsed as AliasMap) };
  } catch {
    return DEFAULT_ALIASES;
  }
}

function normalizeSource(source: string): string {
  return source.trim().replace(/@[^/@:]+$/, "");
}

function findAlias(source: string, aliases: AliasMap): string | undefined {
  if (aliases[source]) return aliases[source];

  const normalized = normalizeSource(source);
  if (aliases[normalized]) return aliases[normalized];

  if (source.includes("github.com/leandromesq/pi-setup")) return aliases["git:github.com/leandromesq/pi-setup"];
  if (source.includes("@leandromesq/pi-setup")) return aliases["npm:@leandromesq/pi-setup"];

  return undefined;
}

function scopePrefix(sourceInfo?: SourceInfo): string {
  return sourceInfo?.scope === "user" ? "u" : sourceInfo?.scope === "project" ? "p" : "t";
}

async function patchInteractiveMode(aliases: AliasMap): Promise<boolean> {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@earendil-works/pi-coding-agent");
  const packageRoot = dirname(dirname(indexPath));
  const interactiveModePath = join(packageRoot, "dist", "modes", "interactive", "interactive-mode.js");
  const mod = await import(pathToFileURL(interactiveModePath).href);
  const InteractiveMode = mod.InteractiveMode;
  if (!InteractiveMode?.prototype || InteractiveMode.prototype.__piSetupAliasesPatched) {
    return Boolean(InteractiveMode?.prototype?.__piSetupAliasesPatched);
  }

  const proto = InteractiveMode.prototype;
  const originalGetCompactPackageSourceLabel = proto.getCompactPackageSourceLabel;
  const originalGetAutocompleteSourceTag = proto.getAutocompleteSourceTag;
  const originalGetDisplaySourceInfo = proto.getDisplaySourceInfo;

  proto.getCompactPackageSourceLabel = function (sourceInfo?: SourceInfo) {
    const source = sourceInfo?.source ?? "";
    return findAlias(source, aliases) ?? originalGetCompactPackageSourceLabel.call(this, sourceInfo);
  };

  proto.getAutocompleteSourceTag = function (sourceInfo?: SourceInfo) {
    const source = sourceInfo?.source ?? "";
    const alias = findAlias(source, aliases);
    if (alias) return `${scopePrefix(sourceInfo)}:${alias}`;
    return originalGetAutocompleteSourceTag.call(this, sourceInfo);
  };

  proto.getDisplaySourceInfo = function (sourceInfo?: SourceInfo) {
    const source = sourceInfo?.source ?? "";
    const alias = findAlias(source, aliases);
    if (alias) {
      const original = originalGetDisplaySourceInfo.call(this, sourceInfo);
      return { ...original, label: alias };
    }
    return originalGetDisplaySourceInfo.call(this, sourceInfo);
  };

  Object.defineProperty(proto, "__piSetupAliasesPatched", { value: true });
  return true;
}

export default function (pi: ExtensionAPI) {
  const aliases = loadAliases();

  patchInteractiveMode(aliases).catch((error) => {
    console.warn(`[extension-aliases] failed to patch Pi UI labels: ${error instanceof Error ? error.message : String(error)}`);
  });

  pi.registerCommand("extension-aliases", {
    description: "Show configured extension source aliases",
    handler: async (_args, ctx) => {
      const lines = Object.entries(aliases).map(([source, alias]) => `${source} -> ${alias}`);
      ctx.ui.notify(lines.length ? lines.join("\n") : "No extension aliases configured", "info");
    },
  });
}
