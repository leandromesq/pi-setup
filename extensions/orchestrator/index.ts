/**
 * Foreground Agent Orchestrator
 *
 * Select a foreground agent with /agent. Foreground agents are normal agent .md
 * files with `role: foreground` or `role: both`; they can restrict callable
 * background subagents with `background_agents`.
 *
 * Agent files are loaded from bundled defaults, ~/.pi/agent/agents, and project
 * agent directories. Later directories override earlier definitions by name.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const GLOBAL_AGENTS_DIR = path.join(os.homedir(), ".pi", "agent", "agents");
const PREFS_FILE = path.join(os.homedir(), ".pi", "agent", "orchestrator-prefs.json");
const DEFAULT_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "subagents", "agents");

// ── Types ──────────────────────────────────────────────────────────────────────

type AgentRole = "foreground" | "background" | "both";

interface OrchestratorPrefs {
    activeAgent?: string;
}

interface AgentDef {
    name: string;
    description: string;
    tools: string;
    systemPrompt: string;
    model?: string;
    thinking?: string;
    file?: string;
    role?: AgentRole;
    /** Background agents this foreground agent may call through the subagent tool. */
    backgroundAgents?: string[];
    /** Back-compat alias for background_agents. */
    subagentAgents?: string[];
}

// ── Persistence ────────────────────────────────────────────────────────────────

function loadPrefs(): OrchestratorPrefs {
    try {
        const raw = fs.readFileSync(PREFS_FILE, "utf-8");
        const data = JSON.parse(raw);
        // Back-compat: old prefs also contained mode/team/chain fields; ignore them.
        return typeof data === "object" && data ? { activeAgent: data.activeAgent } : {};
    } catch {
        return {};
    }
}

function savePrefs(prefs: OrchestratorPrefs) {
    try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {}
}

// ── Agent discovery ────────────────────────────────────────────────────────────

function splitList(value: string | undefined): string[] | undefined {
    const items = value?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
    return items.length > 0 ? items : undefined;
}

function normalizeName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function parseAgentFile(filePath: string): AgentDef | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        if (!match) return null;

        const fm: Record<string, string> = {};
        for (const line of match[1].split("\n")) {
            const idx = line.indexOf(":");
            if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        if (!fm.name) return null;

        const rawRole = fm.role?.toLowerCase();
        const role = rawRole === "foreground" || rawRole === "background" || rawRole === "both" ? rawRole : undefined;
        return {
            name: fm.name,
            description: fm.description || "",
            tools: fm.tools || "read,grep,find,ls",
            systemPrompt: match[2].trim(),
            model: fm.model || undefined,
            thinking: fm.thinking || undefined,
            file: filePath,
            role,
            backgroundAgents: splitList(fm.background_agents),
            subagentAgents: splitList(fm.subagent_agents),
        };
    } catch {
        return null;
    }
}

function scanAgentDirs(cwd: string): AgentDef[] {
    const dirs = [
        DEFAULT_AGENTS_DIR,
        GLOBAL_AGENTS_DIR,
        path.join(cwd, "agents"),
        path.join(cwd, ".claude", "agents"),
        path.join(cwd, ".pi", "agents"),
    ];
    const agents: AgentDef[] = [];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        try {
            for (const file of fs.readdirSync(dir)) {
                if (!file.endsWith(".md")) continue;
                const def = parseAgentFile(path.resolve(dir, file));
                if (!def) continue;
                const existingIndex = agents.findIndex(agent => normalizeName(agent.name) === normalizeName(def.name));
                if (existingIndex >= 0) agents[existingIndex] = def;
                else agents.push(def);
            }
        } catch {}
    }

    return agents.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    let allAgentDefs: AgentDef[] = [];
    let activeForegroundAgent: AgentDef | undefined;
    let baseTools: string[] = [];

    function foregroundAgents(): AgentDef[] {
        const marked = allAgentDefs.filter(def => def.role === "foreground" || def.role === "both");
        return marked.length > 0 ? marked : allAgentDefs;
    }

    function backgroundAgentsFor(def: AgentDef | undefined): AgentDef[] {
        const allowed = def?.backgroundAgents ?? def?.subagentAgents;
        const backgroundDefs = allAgentDefs.filter(candidate =>
            candidate.role !== "foreground" && normalizeName(candidate.name) !== normalizeName(def?.name ?? "")
        );
        if (!allowed || allowed.length === 0) return backgroundDefs;
        const allowedSet = new Set(allowed.map(normalizeName));
        return backgroundDefs.filter(candidate => allowedSet.has(normalizeName(candidate.name)));
    }

    function resolveAgent(name: string, candidates = allAgentDefs): AgentDef | undefined {
        const normalized = normalizeName(name);
        return candidates.find(def => normalizeName(def.name) === normalized)
            ?? candidates.find(def => def.name.toLowerCase() === name.trim().toLowerCase());
    }

    function setSubagentAllowlist(def: AgentDef | undefined) {
        const allowed = def ? backgroundAgentsFor(def).map(agent => agent.name) : undefined;
        (globalThis as any).__pi_subagents?.setAllowedAgents?.(allowed);
    }

    function activeTools(): string[] {
        if (!activeForegroundAgent) return Array.from(new Set(baseTools));
        const available = new Set(pi.getAllTools().map(tool => tool.name));
        const requested = activeForegroundAgent.tools.split(",").map(tool => tool.trim()).filter(Boolean);
        const selected = requested.filter(tool => available.has(tool));
        return Array.from(new Set(selected.length > 0 ? selected : baseTools));
    }

    function applyAgentRuntime(ctx: any) {
        setSubagentAllowlist(activeForegroundAgent);
        const tools = activeTools();
        if (tools.length > 0) pi.setActiveTools(tools);
        ctx.ui.setStatus("orchestrator", activeForegroundAgent ? `Agent: ${activeForegroundAgent.name}` : "Agent: off");
    }

    async function activateForegroundAgent(def: AgentDef, ctx: any, notify = true) {
        activeForegroundAgent = def;
        setSubagentAllowlist(def);

        const slash = def.model?.indexOf("/") ?? -1;
        if (def.model && slash > 0) {
            const model = ctx.modelRegistry.find(def.model.slice(0, slash), def.model.slice(slash + 1));
            if (model) {
                const ok = await pi.setModel(model);
                if (!ok && notify) ctx.ui.notify(`Could not switch to ${def.model}; auth may be missing`, "warning");
            } else if (notify) {
                ctx.ui.notify(`Foreground agent model not found: ${def.model}`, "warning");
            }
        }
        if (def.thinking) pi.setThinkingLevel(def.thinking as any);

        savePrefs({ activeAgent: def.name });
        applyAgentRuntime(ctx);
    }

    function clearForegroundAgent(ctx: any) {
        activeForegroundAgent = undefined;
        setSubagentAllowlist(undefined);
        savePrefs({});
        applyAgentRuntime(ctx);
    }

    function statusText(): string {
        const foreground = activeForegroundAgent
            ? `${activeForegroundAgent.name} (${backgroundAgentsFor(activeForegroundAgent).map(a => a.name).join(", ") || "no background agents"})`
            : "off";
        const foregroundList = foregroundAgents().map(agent => agent.name).join(", ") || "none";
        const backgroundList = allAgentDefs.filter(agent => agent.role !== "foreground").map(agent => agent.name).join(", ") || "none";
        return `Active foreground agent: ${foreground}\nForeground agents: ${foregroundList}\nBackground agents: ${backgroundList}\nTools: ${activeTools().join(", ")}`;
    }

    pi.registerCommand("agent", {
        description: "Select a foreground agent: /agent, /agent <name>, /agent status, or /agent off",
        getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
            const query = prefix.trim().toLowerCase();
            const special = [
                { value: "status", label: "status", description: "Show active foreground/background agents" },
                { value: "off", label: "off", description: "Disable foreground agent mode" },
            ];
            const agents = foregroundAgents().map(def => ({ value: def.name, label: def.name, description: def.description }));
            const items = [...special, ...agents].filter(item => !query || item.value.toLowerCase().includes(query));
            return items.length > 0 ? items : null;
        },
        handler: async (args, ctx) => {
            const raw = args?.trim() ?? "";
            const lower = raw.toLowerCase();

            if (lower === "status") {
                ctx.ui.notify(statusText(), "info");
                return;
            }

            if (["off", "none", "standard"].includes(lower)) {
                clearForegroundAgent(ctx);
                ctx.ui.notify("Foreground agent disabled; using normal Pi tools.", "info");
                return;
            }

            const candidates = foregroundAgents();
            if (candidates.length === 0) {
                ctx.ui.notify("No agents found. Add agent .md files to ~/.pi/agent/agents/ or .pi/agents/.", "warning");
                return;
            }

            let selectedName = raw;
            if (!selectedName) {
                const labels = candidates.map(def => `${def.name}${activeForegroundAgent?.name === def.name ? " ◀ current" : ""} — ${def.description || "no description"}`);
                const choice = await ctx.ui.select("Select Foreground Agent", labels);
                if (choice === undefined) return;
                selectedName = candidates[labels.indexOf(choice)]?.name ?? "";
            }

            const def = resolveAgent(selectedName, candidates);
            if (!def) {
                ctx.ui.notify(`Foreground agent not found: ${selectedName}\nAvailable: ${candidates.map(agent => agent.name).join(", ")}`, "error");
                return;
            }

            await activateForegroundAgent(def, ctx);
            const backgrounds = backgroundAgentsFor(def).map(agent => agent.name).join(", ") || "none";
            ctx.ui.notify(`Foreground agent: ${def.name}\nBackground agents: ${backgrounds}`, "info");
        },
    });

    pi.on("before_agent_start", async (event) => {
        if (!activeForegroundAgent) return {};

        const backgrounds = backgroundAgentsFor(activeForegroundAgent);
        const backgroundCatalog = backgrounds.length > 0
            ? backgrounds.map(def => `- ${def.name}: ${def.description || "no description"}`).join("\n")
            : "- none";

        return {
            systemPrompt: `${event.systemPrompt}

## Foreground Agent Mode

You are the foreground agent for this Pi session.

## Active Foreground Agent: ${activeForegroundAgent.name}
${activeForegroundAgent.description ? `Description: ${activeForegroundAgent.description}\n` : ""}
## Available Background Agents
${backgroundCatalog}

## Foreground / Background Rules
- You are the active foreground agent: keep ownership of user-facing reasoning, decisions, and final responses.
- Use the subagent tool only for background agents listed above.
- Delegate focused research, exploration, review, advice, or implementation tasks when that improves locality or parallelism.
- Include all necessary context when calling background agents; they do not inherit this conversation.

## Foreground Agent Instructions

${activeForegroundAgent.systemPrompt}`,
        };
    });

    pi.on("session_start", async (_event, ctx) => {
        const discoveredBaseTools = pi.getActiveTools();
        if (discoveredBaseTools.length > 0 || baseTools.length === 0) baseTools = discoveredBaseTools;

        const cwd = (ctx as any).cwd;
        allAgentDefs = scanAgentDirs(cwd);

        const prefs = loadPrefs();
        const candidates = foregroundAgents();
        const preferred = prefs.activeAgent
            ? resolveAgent(prefs.activeAgent, candidates)
            : resolveAgent("worker", candidates) ?? candidates[0];

        if (preferred) await activateForegroundAgent(preferred, ctx, false);
        else applyAgentRuntime(ctx);

        ctx.ui.notify(
            `Foreground Agents · ${activeForegroundAgent ? activeForegroundAgent.name : "off"}\n\n` +
            `/agent         pick foreground agent\n` +
            `/agent status  show foreground/background agents\n` +
            `/agent off     return to normal Pi tools`,
            "info"
        );
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.setStatus("orchestrator", undefined);
    });
}
