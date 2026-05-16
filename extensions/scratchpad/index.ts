import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

interface ScratchpadState {
  pinned: string[];
  visible: boolean;
}

const STATE_PATH = join(homedir(), ".pi", "agent", "scratchpad.json");
const DEFAULT_STATE: ScratchpadState = { pinned: [], visible: true };

function loadState(): ScratchpadState {
  try {
    if (!existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return {
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned.filter((x: unknown) => typeof x === "string") : [],
      visible: typeof parsed.visible === "boolean" ? parsed.visible : true,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state: ScratchpadState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function fit(line: string, width: number) {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

export default function scratchpadExtension(pi: ExtensionAPI) {
  let state = loadState();
  let requestRender: (() => void) | undefined;

  function persistAndRender() {
    saveState(state);
    requestRender?.();
  }

  function installWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("session-scratchpad", (tui, theme) => {
      requestRender = () => tui.requestRender();
      return {
        render(width: number) {
          if (!state.visible || state.pinned.length === 0) return [];
          const title = theme.fg("accent", "󰓎 notes");
          const lines = [fit(`${title} ${theme.fg("dim", "—")} ${theme.fg("dim", "Alt+N toggle · /note")}`, width)];
          for (const [index, note] of state.pinned.entries()) {
            lines.push(fit(`${theme.fg("dim", `${index + 1}.`)} ${note}`, width));
          }
          return lines.slice(0, 6);
        },
        invalidate() {
          tui.requestRender();
        },
      } satisfies Component;
    }, { placement: "aboveEditor" });
  }

  pi.on("session_start", (_event, ctx) => installWidget(ctx));

  pi.registerShortcut("alt+n", {
    description: "Toggle session scratchpad notes",
    handler: async (ctx) => {
      state.visible = !state.visible;
      persistAndRender();
      ctx.ui.notify(`Scratchpad ${state.visible ? "shown" : "hidden"}`, "info");
    },
  });

  pi.registerCommand("note", {
    description: "Manage pinned session notes: /note add <text>, /note rm <n>, /note clear, /note toggle, /note list",
    handler: async (args, ctx) => {
      const input = args.trim();
      const [cmd = "list", ...rest] = input.split(/\s+/);
      const text = rest.join(" ").trim();

      switch (cmd.toLowerCase()) {
        case "add":
        case "pin": {
          if (!text) {
            ctx.ui.notify("Usage: /note add <text>", "warning");
            return;
          }
          state.pinned.push(text);
          state.visible = true;
          persistAndRender();
          ctx.ui.notify("Note pinned", "success");
          return;
        }
        case "rm":
        case "remove":
        case "del": {
          const index = Number(text) - 1;
          if (!Number.isInteger(index) || index < 0 || index >= state.pinned.length) {
            ctx.ui.notify("Usage: /note rm <number>", "warning");
            return;
          }
          const [removed] = state.pinned.splice(index, 1);
          persistAndRender();
          ctx.ui.notify(`Removed: ${removed}`, "info");
          return;
        }
        case "clear":
          state.pinned = [];
          persistAndRender();
          ctx.ui.notify("Scratchpad cleared", "info");
          return;
        case "toggle":
          state.visible = !state.visible;
          persistAndRender();
          ctx.ui.notify(`Scratchpad ${state.visible ? "shown" : "hidden"}`, "info");
          return;
        case "list":
        default:
          if (state.pinned.length === 0) {
            ctx.ui.notify("Scratchpad empty. Use /note add <text>", "info");
          } else {
            ctx.ui.notify(state.pinned.map((note, i) => `${i + 1}. ${note}`).join("\n"), "info");
          }
      }
    },
  });
}
