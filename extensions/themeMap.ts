/**
 * Per-extension default theme/title helpers.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, dirname } from "path";
import { fileURLToPath } from "url";

export const THEME_MAP: Record<string, string> = {
    orchestrator: "dracula",
    "agent-chain": "midnight-ocean",
    "agent-team": "dracula",
    "subagent-widget": "cyberpunk",
};

function extensionName(fileUrl: string): string {
    const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
    const base = basename(filePath).replace(/\.[^.]+$/, "");
    return base === "index" ? basename(dirname(filePath)) : base;
}

function primaryExtensionName(): string | null {
    const argv = process.argv;
    for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === "-e" || argv[i] === "--extension") {
            const extPath = argv[i + 1];
            const base = basename(extPath).replace(/\.[^.]+$/, "");
            return base === "index" ? basename(dirname(extPath)) : base;
        }
    }
    return null;
}

export function applyExtensionTheme(fileUrl: string, ctx: ExtensionContext): boolean {
    if (!ctx.hasUI) return false;

    const name = extensionName(fileUrl);
    const primaryExt = primaryExtensionName();
    if (primaryExt && primaryExt !== name) return true;

    const themeName = THEME_MAP[name] || "dracula";
    const result = ctx.ui.setTheme(themeName);
    if (!result.success && themeName !== "dracula") return ctx.ui.setTheme("dracula").success;
    return result.success;
}

function applyExtensionTitle(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const name = primaryExtensionName() || "orchestrator";
    setTimeout(() => ctx.ui.setTitle(`π - ${name}`), 150);
}

export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
    applyExtensionTheme(fileUrl, ctx);
    applyExtensionTitle(ctx);
}
