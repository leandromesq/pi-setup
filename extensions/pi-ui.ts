import path from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ContextUsage, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { renderFixedEditorCluster } from "./pi-ui-fixed-editor/cluster.ts";
import { emergencyTerminalModeReset, TerminalSplitCompositor } from "./pi-ui-fixed-editor/terminal-split.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PI_LOGO = "⡯⢣"; // 4x4 braille rasterisation of the official Pi SVG mark.

const DEEP_BLUE: Rgb = [31, 111, 235];
const BLUE: Rgb = [56, 139, 253];
const SKY: Rgb = [121, 192, 255];
const ICE: Rgb = [165, 214, 255];
const PALETTE: Rgb[] = [DEEP_BLUE, BLUE, SKY, ICE, SKY, BLUE];

type Rgb = [number, number, number];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string;

const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const t = scaled - index;
  const a = PALETTE[index]!;
  const b = PALETTE[nextIndex]!;
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)] as Rgb;
}

function fg([r, g, b]: Rgb, text: string) {
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const chars = [...text];
  const span = Math.max(chars.length - 1, 1);
  return chars
    .map((char, index) => (char === " " ? char : fg(sampleGradient(index / span + phase), char)))
    .join("");
}

function center(text: string, width: number) {
  const length = visibleWidth(text);
  if (length >= width) return truncateToWidth(text, width, "");
  return `${" ".repeat(Math.floor((width - length) / 2))}${text}`;
}

function projectName(cwd: string) {
  return path.basename(cwd) || "session";
}

function shortCwd(cwd: string) {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  if (normalized === "c:/windows/system32") return "~";

  const home = process.env.USERPROFILE || process.env.HOME;
  return home && cwd.toLowerCase().startsWith(home.toLowerCase()) ? `~${cwd.slice(home.length)}` : cwd;
}

function formatTokens(count: number) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatModel(modelId: string) {
  return modelId.replace(/^models\//, "");
}

function providerLogo(providerId: string | undefined) {
  const id = providerId?.toLowerCase() ?? "";
  if (id.includes("openai") || id.includes("codex")) return "󰚩";
  if (id.includes("copilot") || id.includes("github")) return "";
  if (id.includes("opencode")) return "󰅪";
  return "◆";
}

function renderPiLogo() {
  return `${fg(DEEP_BLUE, PI_LOGO[0] ?? "")}${fg(SKY, PI_LOGO[1] ?? "")}`;
}

function contextMeterIcon(percent: number | null | undefined) {
  if (percent === null || percent === undefined) return "○";
  const slices = ["󰪞", "󰪟", "󰪠", "󰪡", "󰪢", "󰪣", "󰪤", "󰪥"];
  const index = Math.max(0, Math.min(slices.length - 1, Math.ceil(percent / 12.5) - 1));
  return slices[index];
}

function formatContext(usage: ContextUsage | undefined) {
  if (!usage || usage.percent === null) return "○ ?%/?";
  const max = usage.contextWindow ?? 0;
  const maxText = max > 0 ? formatTokens(max) : "?";
  return `${contextMeterIcon(usage.percent)} ${Math.round(usage.percent)}%/${maxText}`;
}

function formatPathSegment(cwd: string, theme: any) {
  const short = shortCwd(cwd).replace(/\\/g, "/");
  if (short === "~") return theme.fg("muted", " ~");

  const slash = short.lastIndexOf("/");
  if (slash === -1) return `${theme.fg("muted", " ")}${theme.fg("text", short)}`;

  const parent = short.slice(0, slash + 1);
  const base = short.slice(slash + 1);
  return `${theme.fg("dim", ` ${parent}`)}${theme.fg("muted", base)}`;
}

function contextColor(percent: number | null | undefined) {
  if (percent === null || percent === undefined) return "dim";
  if (percent >= 85) return "error";
  if (percent >= 65) return "warning";
  return "muted";
}

function thinkingColor(level: ThinkingLevel) {
  switch (level) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    default:
      return "muted";
  }
}

function joinSegments(width: number, segments: string[]) {
  const sep = "  ";
  let line = "";
  for (const segment of segments) {
    const next = line ? `${line}${sep}${segment}` : segment;
    if (visibleWidth(next) > width) break;
    line = next;
  }
  return truncateToWidth(line, width, "");
}

function renderHeader(width: number, phase: number, subtitleText: string) {
  const lines = TITLE_LINES.map((line, row) => gradientText(center(line, width), phase + row * 0.045));
  const subtitle = center(subtitleText, width);

  return ["", ...lines, `${BOLD}${gradientText(subtitle, phase + 0.18)}${RESET}`, ""];
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h${minutes}min${seconds}s`;
  if (minutes > 0) return `${minutes}min${seconds}s`;
  return `${seconds}s`;
}

export default function (pi: ExtensionAPI) {
  let currentModelId = "no model selected";
  let currentProviderId = "";
  let currentThinking: ThinkingLevel = "?";
  let requestHeaderRender: (() => void) | undefined;
  let requestFooterRender: (() => void) | undefined;
  let stashedEditorText: string | undefined;
  let currentEditor: CustomEditor | undefined;
  let fixedEditorCompositor: TerminalSplitCompositor | undefined;
  let fixedEditorContainer: any;
  let fixedStatusContainer: any;
  let fixedWidgetContainerAbove: any;
  let fixedWidgetContainerBelow: any;
  let activeFooterTheme: any;
  let activeFooterData: any;
  let activeCtx: ExtensionContext | undefined;
  let gitDirty = false;
  let workingStartedAt: number | undefined;
  let workingTimer: ReturnType<typeof setInterval> | undefined;

  function installHeader(ctx: ExtensionContext) {
    ctx.ui.setHeader((tui) => {
      requestHeaderRender = () => tui.requestRender();
      return {
        render(width: number) {
          return renderHeader(width, 0, `${formatModel(currentModelId)} · ${projectName(ctx.cwd)}`);
        },
        invalidate() {
          tui.requestRender();
        },
      } satisfies Component;
    });
    ctx.ui.setTitle(`π ${projectName(ctx.cwd)} · ${formatModel(currentModelId)}`);
  }

  function renderFooterLine(ctx: ExtensionContext, theme: any, footerData: any, width: number) {
    const usage = ctx.getContextUsage();
    const branch = footerData.getGitBranch();
    const context = formatContext(usage);
    const contextTheme = contextColor(usage?.percent);

    const sep = theme.fg("dim", "›");
    const leftSegments = [
      renderPiLogo(),
      `${theme.fg("accent", providerLogo(currentProviderId))} ${theme.fg("muted", formatModel(currentModelId))}`,
      theme.fg(thinkingColor(currentThinking) as any, currentThinking),
      formatPathSegment(ctx.cwd, theme),
      ...(branch ? [theme.fg(gitDirty ? "warning" : "success", ` ${branch}${gitDirty ? "*" : ""}`)] : []),
    ];

    const left = joinSegments(width, leftSegments.flatMap((segment, index) => index === 0 ? [segment] : [sep, segment]));
    const right = theme.fg(contextTheme as any, context);
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    if (visibleWidth(left) + 1 + visibleWidth(right) <= width) return `${left}${" ".repeat(gap)}${right}`;
    return joinSegments(width, [...leftSegments, right]);
  }

  async function refreshGitDirty(ctx: ExtensionContext) {
    try {
      const result = await (pi as any).exec?.("git", ["status", "--porcelain"], { cwd: ctx.cwd });
      gitDirty = Boolean(result?.stdout?.trim());
    } catch {
      gitDirty = false;
    }
    requestFooterRender?.();
  }

  function installFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      activeFooterTheme = theme;
      activeFooterData = footerData;
      requestFooterRender = () => tui.requestRender();
      const disposeBranch = footerData.onBranchChange(() => {
        void refreshGitDirty(ctx);
        tui.requestRender();
      });
      void refreshGitDirty(ctx);

      return {
        render(width: number) {
          return fixedEditorCompositor ? [] : [renderFooterLine(ctx, theme, footerData, width)];
        },
        invalidate() {
          tui.requestRender();
        },
        dispose() {
          disposeBranch?.();
        },
      } satisfies Component & { dispose(): void };
    });
  }

  function teardownFixedEditor(options?: { resetExtendedKeyboardModes?: boolean }) {
    const hadCompositor = fixedEditorCompositor !== undefined;
    fixedEditorCompositor?.dispose(options);
    if (!hadCompositor && options?.resetExtendedKeyboardModes) {
      try {
        process.stdout.write(emergencyTerminalModeReset());
      } catch {
        // Best-effort terminal cleanup on shutdown.
      }
    }
    fixedEditorCompositor = undefined;
    fixedEditorContainer = undefined;
    fixedStatusContainer = undefined;
    fixedWidgetContainerAbove = undefined;
    fixedWidgetContainerBelow = undefined;
  }

  function renderFixedFooterLines(ctx: ExtensionContext, width: number) {
    if (!activeFooterData) return [];
    return [renderFooterLine(ctx, activeFooterTheme ?? ctx.ui.theme, activeFooterData, width)];
  }

  function findContainerWithChild(tui: any, child: any): { container: any; index: number } | null {
    const children = Array.isArray(tui?.children) ? tui.children : [];
    const index = children.findIndex((candidate: any) => Array.isArray(candidate?.children) && candidate.children.includes(child));
    return index === -1 ? null : { container: children[index], index };
  }

  function installFixedEditor(ctx: ExtensionContext, tui: TUI) {
    teardownFixedEditor();
    if (!ctx.hasUI || !(tui as any)?.terminal?.write || !currentEditor) return;

    const editorContainerMatch = findContainerWithChild(tui, currentEditor);
    if (!editorContainerMatch) return;

    const tuiChildren = Array.isArray((tui as any).children) ? (tui as any).children : [];
    fixedEditorContainer = editorContainerMatch.container;
    const statusContainerCandidate = tuiChildren[editorContainerMatch.index - 2] ?? null;
    fixedStatusContainer = statusContainerCandidate && typeof statusContainerCandidate.render === "function"
      ? statusContainerCandidate
      : null;
    fixedWidgetContainerAbove = tuiChildren[editorContainerMatch.index - 1] ?? null;
    fixedWidgetContainerBelow = tuiChildren[editorContainerMatch.index + 1] ?? null;

    let compositor!: TerminalSplitCompositor;
    compositor = new TerminalSplitCompositor({
      tui,
      terminal: (tui as any).terminal,
      mouseScroll: true,
      getShowHardwareCursor: () => typeof (tui as any).getShowHardwareCursor === "function" && (tui as any).getShowHardwareCursor(),
      renderCluster: (width, terminalRows) => renderFixedEditorCluster({
        width,
        terminalRows,
        statusLines: [
          ...(fixedWidgetContainerAbove ? compositor.renderHidden(fixedWidgetContainerAbove, width) : []),
          ...(fixedStatusContainer ? compositor.renderHidden(fixedStatusContainer, width).filter((line) => visibleWidth(line) > 0) : []),
        ],
        topLines: renderFixedFooterLines(ctx, width),
        editorLines: fixedEditorContainer ? compositor.renderHidden(fixedEditorContainer, width) : [],
        secondaryLines: fixedWidgetContainerBelow ? compositor.renderHidden(fixedWidgetContainerBelow, width) : [],
      }),
    });

    fixedEditorCompositor = compositor;
    if (fixedStatusContainer?.render) compositor.hideRenderable(fixedStatusContainer);
    if (fixedWidgetContainerAbove?.render) compositor.hideRenderable(fixedWidgetContainerAbove);
    compositor.hideRenderable(fixedEditorContainer);
    if (fixedWidgetContainerBelow?.render) compositor.hideRenderable(fixedWidgetContainerBelow);
    compositor.install();
    (tui as any).requestRender?.(true);
  }

  function installEditor(ctx: ExtensionContext) {
    ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
      class FixedPiEditor extends CustomEditor {
        constructor() {
          super(tui, theme, keybindings);
          currentEditor = this;
          setTimeout(() => installFixedEditor(ctx, tui), 0);
        }

        borderColor(text: string) {
          return ctx.ui.theme.fg(thinkingColor(currentThinking) as any, text);
        }
      }

      return new FixedPiEditor();
    });
  }

  function stopWorkingTimer() {
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = undefined;
    }
    workingStartedAt = undefined;
  }

  function updateWorkingMessage(ctx: ExtensionContext) {
    if (!workingStartedAt) return;
    ctx.ui.setWorkingMessage(`Working for ${formatDuration(Date.now() - workingStartedAt)}`);
  }

  function startWorkingTimer(ctx: ExtensionContext) {
    stopWorkingTimer();
    workingStartedAt = Date.now();
    updateWorkingMessage(ctx);
    workingTimer = setInterval(() => updateWorkingMessage(ctx), 1000);
  }

  function installUi(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    activeCtx = ctx;
    currentModelId = ctx.model?.id ?? currentModelId;
    currentProviderId = ctx.model?.provider ?? currentProviderId;
    currentThinking = (typeof (ctx as any).getThinkingLevel === "function" ? (ctx as any).getThinkingLevel() : undefined)
      ?? (typeof (pi as any).getThinkingLevel === "function" ? (pi as any).getThinkingLevel() : undefined)
      ?? currentThinking;
    setTimeout(() => {
      const thinking = (typeof (ctx as any).getThinkingLevel === "function" ? (ctx as any).getThinkingLevel() : undefined)
        ?? (typeof (pi as any).getThinkingLevel === "function" ? (pi as any).getThinkingLevel() : undefined);
      if (thinking) {
        currentThinking = thinking;
        requestFooterRender?.();
      }
    }, 0);
    teardownFixedEditor();
    installHeader(ctx);
    installFooter(ctx);
    installEditor(ctx);
    ctx.ui.setWorkingIndicator();
  }

  pi.on("session_start", (_event, ctx) => {
    installUi(ctx);
  });

  pi.on("model_select", (event) => {
    currentModelId = event.model.id;
    currentProviderId = event.model.provider ?? currentProviderId;
    requestHeaderRender?.();
    requestFooterRender?.();
  });

  pi.on("thinking_level_select", (event) => {
    currentThinking = event.level;
    requestFooterRender?.();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    startWorkingTimer(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.hasUI) void refreshGitDirty(ctx);
    requestFooterRender?.();
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.hasUI) {
      stopWorkingTimer();
      ctx.ui.setWorkingMessage();
    }
    requestFooterRender?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ctx.hasUI) return;
    stopWorkingTimer();
    ctx.ui.setWorkingMessage();
    ctx.ui.setHeader(undefined);
    teardownFixedEditor({ resetExtendedKeyboardModes: true });
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setWorkingIndicator();
  });

  pi.registerShortcut("alt+s", {
    description: "Stash/restore editor text",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText();
      if (text.trim()) {
        stashedEditorText = text;
        ctx.ui.setEditorText("");
        ctx.ui.notify("Editor stashed. Press Alt+S with an empty editor to restore.", "info");
        return;
      }

      if (stashedEditorText !== undefined) {
        ctx.ui.setEditorText(stashedEditorText);
        stashedEditorText = undefined;
        ctx.ui.notify("Editor stash restored", "info");
      } else {
        ctx.ui.notify("Editor stash is empty", "info");
      }
    },
  });

  pi.registerCommand("pi-ui", {
    description: "Enable the custom Pi UI header/footer",
    handler: async (_args, ctx) => {
      installUi(ctx);
      ctx.ui.notify("Custom Pi UI enabled", "info");
    },
  });

  pi.registerCommand("pi-ui-builtin", {
    description: "Restore Pi's built-in header/footer for this session",
    handler: async (_args, ctx) => {
      stopWorkingTimer();
      ctx.ui.setWorkingMessage();
      teardownFixedEditor({ resetExtendedKeyboardModes: true });
      ctx.ui.setHeader(undefined);
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.setWorkingIndicator();
      ctx.ui.notify("Built-in Pi UI restored", "info");
    },
  });
}
