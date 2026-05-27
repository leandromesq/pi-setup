import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  let swatchTimer: ReturnType<typeof setTimeout> | undefined;

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("theme", `🎨 ${ctx.ui.theme.name}`);
  }

  function safeFg(theme: any, color: string, text: string) {
    try {
      return theme.fg(color, text);
    } catch {
      return text;
    }
  }

  function showSwatch(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (swatchTimer) clearTimeout(swatchTimer);

    ctx.ui.setWidget(
      "theme-swatch",
      (_tui, theme) => ({
        invalidate() {},
        render(width: number): string[] {
          const block = "███";
          const swatch = ["success", "accent", "warning", "thinkingHigh", "thinkingMedium", "muted"]
            .map((color) => safeFg(theme, color, block))
            .join(" ");
          const label = `${safeFg(theme, "accent", " 🎨 ")}${safeFg(theme, "text", ctx.ui.theme.name)}  ${swatch}`;
          const border = safeFg(theme, "borderMuted", "─".repeat(Math.max(0, width)));
          return [border, truncateToWidth(` ${label}`, width), border];
        },
      }),
      { placement: "belowEditor" },
    );

    swatchTimer = setTimeout(() => {
      ctx.ui.setWidget("theme-swatch", undefined);
      swatchTimer = undefined;
    }, 3000);
  }

  function getThemes(ctx: ExtensionContext) {
    return ctx.ui.getAllThemes();
  }

  function findCurrentIndex(ctx: ExtensionContext) {
    return getThemes(ctx).findIndex((theme) => theme.name === ctx.ui.theme.name);
  }

  function setTheme(ctx: ExtensionContext, name: string) {
    const result = ctx.ui.setTheme(name);
    if (!result.success) {
      ctx.ui.notify(`Failed to set theme: ${result.error}`, "error");
      return false;
    }

    updateStatus(ctx);
    showSwatch(ctx);
    ctx.ui.notify(`Theme: ${name}`, "info");
    return true;
  }

  function cycleTheme(ctx: ExtensionContext, direction: 1 | -1) {
    if (!ctx.hasUI) return;
    const themes = getThemes(ctx);
    if (themes.length === 0) {
      ctx.ui.notify("No themes available", "warning");
      return;
    }

    let index = findCurrentIndex(ctx);
    if (index === -1) index = 0;
    index = (index + direction + themes.length) % themes.length;
    const theme = themes[index]!;
    if (setTheme(ctx, theme.name)) ctx.ui.notify(`${theme.name} (${index + 1}/${themes.length})`, "info");
  }

  pi.registerShortcut("ctrl+x", {
    description: "Cycle theme forward",
    handler: async (ctx) => cycleTheme(ctx, 1),
  });

  pi.registerShortcut("ctrl+q", {
    description: "Cycle theme backward",
    handler: async (ctx) => cycleTheme(ctx, -1),
  });

  pi.registerCommand("theme", {
    description: "Select a theme: /theme or /theme <name>",
    getArgumentCompletions: (prefix) => {
      // Theme completions need a live context, so keep this command picker-first.
      return prefix ? null : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const arg = args.trim();
      const themes = getThemes(ctx);

      if (arg) {
        const exact = themes.find((theme) => theme.name.toLowerCase() === arg.toLowerCase());
        setTheme(ctx, exact?.name ?? arg);
        return;
      }

      const selected = await ctx.ui.select(
        "Select Theme",
        themes.map((theme) => {
          const active = theme.name === ctx.ui.theme.name ? " ●" : "";
          const source = theme.path ? theme.path : "built-in";
          return `${theme.name}${active} — ${source}`;
        }),
      );
      if (!selected) return;

      setTheme(ctx, selected.split(/\s/)[0]!);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (swatchTimer) clearTimeout(swatchTimer);
    swatchTimer = undefined;
    if (ctx.hasUI) ctx.ui.setWidget("theme-swatch", undefined);
  });
}
