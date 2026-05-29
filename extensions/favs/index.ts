import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface Favorite {
  name: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

interface FavoritesConfig {
  favorites: Favorite[];
  shortcuts?: Record<string, string>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "model-favorites.json");
const DEFAULT_CONFIG: FavoritesConfig = {
  favorites: [
    { name: "codex-low", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "low" },
    { name: "codex-high", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "high" },
  ],
  shortcuts: {
    cycleNext: "alt+m",
    cyclePrevious: "alt+p",
    cyclePreviousAlt: "ctrl+alt+m",
    slot1: "alt+1",
    slot2: "alt+2",
    slot3: "alt+3",
    slot4: "alt+4",
  },
};

function loadConfig(): FavoritesConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return DEFAULT_CONFIG;
    }
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : DEFAULT_CONFIG.favorites,
      shortcuts: { ...DEFAULT_CONFIG.shortcuts, ...(parsed.shortcuts ?? {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: FavoritesConfig) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function label(fav: Favorite) {
  return `${fav.name}: ${fav.provider}/${fav.model}${fav.thinkingLevel ? `:${fav.thinkingLevel}` : ""}`;
}

export default function modelFavoritesExtension(pi: ExtensionAPI) {
  let config = loadConfig();
  let currentIndex = 0;

  function reload() {
    config = loadConfig();
  }

  function findCurrentFavorite(ctx: ExtensionContext) {
    const provider = ctx.model?.provider;
    const model = ctx.model?.id;
    const thinking = pi.getThinkingLevel();
    const index = config.favorites.findIndex((fav) =>
      fav.provider === provider && fav.model === model && (!fav.thinkingLevel || fav.thinkingLevel === thinking)
    );
    if (index !== -1) currentIndex = index;
    return index;
  }

  async function applyFavorite(ctx: ExtensionContext, index: number) {
    reload();
    const fav = config.favorites[index];
    if (!fav) {
      ctx.ui.notify(`No model favorite in slot ${index + 1}`, "warning");
      return false;
    }

    const model = ctx.modelRegistry.find(fav.provider, fav.model);
    if (!model) {
      ctx.ui.notify(`Favorite not found: ${fav.provider}/${fav.model}`, "error");
      return false;
    }

    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(`Could not switch to ${fav.provider}/${fav.model}; auth may be missing`, "error");
      return false;
    }

    if (fav.thinkingLevel) pi.setThinkingLevel(fav.thinkingLevel);
    currentIndex = index;
    ctx.ui.notify(`Model favorite: ${label(fav)}`, "success");
    return true;
  }

  async function cycle(ctx: ExtensionContext, direction: 1 | -1) {
    reload();
    if (config.favorites.length === 0) {
      ctx.ui.notify(`No model favorites. Edit ${CONFIG_PATH}`, "warning");
      return;
    }
    findCurrentFavorite(ctx);
    const next = (currentIndex + direction + config.favorites.length) % config.favorites.length;
    await applyFavorite(ctx, next);
  }

  pi.on("session_start", (_event, ctx) => {
    reload();
    findCurrentFavorite(ctx);
  });

  const shortcuts = config.shortcuts ?? DEFAULT_CONFIG.shortcuts!;
  pi.registerShortcut(shortcuts.cycleNext ?? "alt+m", {
    description: "Cycle to next model favorite",
    handler: async (ctx) => cycle(ctx, 1),
  });
  pi.registerShortcut(shortcuts.cyclePrevious ?? "alt+p", {
    description: "Cycle to previous model favorite",
    handler: async (ctx) => cycle(ctx, -1),
  });
  const previousAlt = shortcuts.cyclePreviousAlt;
  if (previousAlt) {
    pi.registerShortcut(previousAlt, {
      description: "Cycle to previous model favorite (alternate)",
      handler: async (ctx) => cycle(ctx, -1),
    });
  }

  for (let i = 1; i <= 4; i++) {
    const key = shortcuts[`slot${i}`] ?? `alt+${i}`;
    pi.registerShortcut(key, {
      description: `Switch to model favorite slot ${i}`,
      handler: async (ctx) => applyFavorite(ctx, i - 1),
    });
  }

  pi.registerCommand("fav", {
    description: "Model favorites: /fav, /fav <name|n>, /fav add <name>, /fav reload",
    handler: async (args, ctx) => {
      reload();
      const input = args.trim();
      if (!input || input === "list") {
        if (config.favorites.length === 0) {
          ctx.ui.notify(`No favorites. Edit ${CONFIG_PATH}`, "info");
          return;
        }
        findCurrentFavorite(ctx);
        ctx.ui.notify(config.favorites.map((fav, i) => `${i === currentIndex ? "*" : " "} ${i + 1}. ${label(fav)}`).join("\n"), "info");
        return;
      }

      const [cmd, ...rest] = input.split(/\s+/);
      if (cmd === "reload") {
        reload();
        ctx.ui.notify(`Reloaded ${config.favorites.length} favorites`, "success");
        return;
      }

      if (cmd === "add") {
        const name = rest.join("-") || `${ctx.model?.provider ?? "model"}-${ctx.model?.id ?? config.favorites.length + 1}`;
        if (!ctx.model) {
          ctx.ui.notify("No current model selected", "warning");
          return;
        }
        const fav: Favorite = {
          name,
          provider: ctx.model.provider,
          model: ctx.model.id,
          thinkingLevel: pi.getThinkingLevel(),
        };
        config.favorites.push(fav);
        saveConfig(config);
        ctx.ui.notify(`Added favorite: ${label(fav)}`, "success");
        return;
      }

      const index = /^\d+$/.test(input)
        ? Number(input) - 1
        : config.favorites.findIndex((fav) => fav.name === input);
      await applyFavorite(ctx, index);
    },
  });
}
