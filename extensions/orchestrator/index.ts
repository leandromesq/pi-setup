/**
 * Agent Orchestrator — Team dispatch and chain pipeline
 *
 * Orchestration modes, switch with /mode:
 *
 *   standard (default)
 *     Normal Pi agent — all default codebase tools are available.
 *
 *   agent
 *     Foreground agent selected with /agent. Foreground agents can declare
 *     background_agents to restrict which subagents they may call.
 *
 *   team
 *     Dispatcher-only orchestrator — main agent has NO codebase write/edit tools.
 *     Agent .md files: ~/.pi/agent/agents/  or  agents/  .claude/agents/  .pi/agents/  in cwd
 *     Teams: ~/.pi/agent/agents/teams.yaml  (merged with .pi/agents/teams.yaml per project)
 *     Tool: dispatch_agent
 *     Commands: /team  /team-list  /agents-grid <1-6>
 *
 *   chain
 *     Sequential pipeline (step A → step B → step C).
 *     Chains: ~/.pi/agent/agents/agent-chain.yaml  (merged with .pi/agents/agent-chain.yaml)
 *     Tool: run_chain  (plus all default tools)
 *     Commands: /chain  /chain-list  /chain-run <task>
 *
 * Agents can declare `subagent` in their tools frontmatter to spawn sub-processes
 * via the subagents extension. Use `background_agents: explorer, critic` on
 * foreground agents or `subagent_agents: explorer, critic` on background agents
 * to restrict which agents they can spawn.
 *
 * Mode + active team/chain persists across /new via ~/.pi/agent/orchestrator-prefs.json
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, type AutocompleteItem, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "openrouter/google/gemini-2.5-flash-preview";
const GLOBAL_AGENTS_DIR = path.join(os.homedir(), ".pi", "agent", "agents");
const PREFS_FILE = path.join(os.homedir(), ".pi", "agent", "orchestrator-prefs.json");

// Built-in tools pi provides natively (no extension flag needed)
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

// Extension-provided tools: maps tool name → path to the extension's index.ts.
// Add entries here for any custom tool an agent .md file might declare.
const EXT_BASE = path.join(os.homedir(), ".pi", "agent", "extensions");
const SUBAGENTS_EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "subagents", "index.ts");
const DEFAULT_AGENTS_DIR = path.join(path.dirname(SUBAGENTS_EXT), "agents");
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
    subagent: SUBAGENTS_EXT,
    web_search: path.join(EXT_BASE, "web-search", "index.ts"),
    web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
    safe_bash: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "subagents", "tools", "safe-bash.ts"),
};

/** Resolve the actual pi executable — prefers node + entry-script to avoid
 *  shell wrapper issues on Windows. Falls back to `pi.cmd` / `pi` in PATH. */
function resolvePiBinary(): { command: string; baseArgs: string[] } {
    const entry = process.argv[1];
    if (entry) {
        try {
            const realEntry = fs.realpathSync(entry);
            if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
                return { command: process.execPath, baseArgs: [realEntry] };
            }
        } catch {}
    }
    return { command: process.platform === "win32" ? "pi.cmd" : "pi", baseArgs: [] };
}

/** Spawn options — adds shell:true on Windows only when falling back to pi.cmd */
function getSpawnOptions(childEnv?: NodeJS.ProcessEnv): any {
    const { baseArgs } = resolvePiBinary();
    const opts: any = {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv ?? { ...process.env },
    };
    // Only need shell when calling pi.cmd (no baseArgs means we're using the cmd wrapper)
    if (process.platform === "win32" && baseArgs.length === 0) opts.shell = true;
    return opts;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type OrchestratorMode = "standard" | "agent" | "team" | "chain";
type AgentRole = "foreground" | "background" | "both";

interface OrchestratorPrefs {
    mode: OrchestratorMode;
    activeAgent?: string;
    activeTeam?: string;
    activeChain?: string;
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
    /** If `subagent` is in tools, restrict which agents this agent may spawn. */
    subagentAgents?: string[];
}

interface AgentState {
    def: AgentDef;
    status: "idle" | "running" | "done" | "error";
    task: string;
    toolCount: number;
    elapsed: number;
    lastWork: string;
    contextPct: number;
    sessionFile: string | null;
    runCount: number;
    timer?: ReturnType<typeof setInterval>;
}

interface ChainStep {
    agent: string;
    prompt: string;
}

interface ChainDef {
    name: string;
    description: string;
    steps: ChainStep[];
}

interface StepState {
    agent: string;
    status: "pending" | "running" | "done" | "error";
    elapsed: number;
    lastWork: string;
}

// ── Prefs helpers ──────────────────────────────────────────────────────────────

function loadPrefs(): OrchestratorPrefs {
    try {
        const raw = fs.readFileSync(PREFS_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (["standard", "agent", "team", "chain"].includes(data.mode)) return data as OrchestratorPrefs;
    } catch {}
    return { mode: "standard" };
}

function savePrefs(prefs: OrchestratorPrefs) {
    try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {}
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function displayName(name: string): string {
    return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function splitList(value: string | undefined): string[] | undefined {
    const items = value?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
    return items.length > 0 ? items : undefined;
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
    } catch { return null; }
}

function scanAgentDirs(cwd: string): AgentDef[] {
    // Global dir first so project dirs can override
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
                const fullPath = path.resolve(dir, file);
                const def = parseAgentFile(fullPath);
                if (!def) continue;
                const key = def.name.toLowerCase();
                const existingIdx = agents.findIndex(a => a.name.toLowerCase() === key);
                if (existingIdx >= 0) agents[existingIdx] = def;
                else agents.push(def);
            }
        } catch {}
    }
    return agents;
}

function parseTeamsYaml(raw: string): Record<string, string[]> {
    const teams: Record<string, string[]> = {};
    let current: string | null = null;
    for (const line of raw.split("\n")) {
        const tm = line.match(/^(\S[^:]*):$/);
        if (tm) { current = tm[1].trim(); teams[current] = []; continue; }
        const im = line.match(/^\s+-\s+(.+)$/);
        if (im && current) teams[current].push(im[1].trim());
    }
    return teams;
}

function parseChainYaml(raw: string): ChainDef[] {
    const chains: ChainDef[] = [];
    let cur: ChainDef | null = null;
    let curStep: ChainStep | null = null;

    for (const line of raw.split("\n")) {
        const cm = line.match(/^(\S[^:]*):$/);
        if (cm) {
            if (cur && curStep) { cur.steps.push(curStep); curStep = null; }
            cur = { name: cm[1].trim(), description: "", steps: [] };
            chains.push(cur);
            continue;
        }
        const dm = line.match(/^\s+description:\s+(.+)$/);
        if (dm && cur && !curStep) {
            let d = dm[1].trim();
            if ((d.startsWith('"') && d.endsWith('"')) || (d.startsWith("'") && d.endsWith("'"))) d = d.slice(1, -1);
            cur.description = d; continue;
        }
        if (line.match(/^\s+steps:\s*$/) && cur) continue;
        const am = line.match(/^\s+-\s+agent:\s+(.+)$/);
        if (am && cur) { if (curStep) cur.steps.push(curStep); curStep = { agent: am[1].trim(), prompt: "" }; continue; }
        const pm = line.match(/^\s+prompt:\s+(.+)$/);
        if (pm && curStep) {
            let p = pm[1].trim();
            if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1);
            curStep.prompt = p.replace(/\\n/g, "\n"); continue;
        }
    }
    if (cur && curStep) cur.steps.push(curStep);
    return chains;
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

    // ── Global state ──────────────────────────────────────────────────────────
    let mode: OrchestratorMode = "standard";
    let widgetCtx: any;
    let baseTools: string[] = [];
    let activeForegroundAgent: AgentDef | undefined;
    const orchestratorToolNames = new Set(["dispatch_agent", "run_chain"]);

    // ── Team state ────────────────────────────────────────────────────────────
    const agentStates: Map<string, AgentState> = new Map();
    let allAgentDefs: AgentDef[] = [];
    let teams: Record<string, string[]> = {};
    let activeTeamName = "";
    let gridCols = 2;
    let teamSessionDir = "";
    let contextWindow = 0;

    // ── Chain state ───────────────────────────────────────────────────────────
    let allAgents: Map<string, AgentDef> = new Map();
    let chains: ChainDef[] = [];
    let activeChain: ChainDef | null = null;
    let stepStates: StepState[] = [];
    let pendingReset = false;
    let chainSessionDir = "";
    const agentSessions: Map<string, string | null> = new Map();

    // ── Prefs helpers ─────────────────────────────────────────────────────────

    function currentPrefs(): OrchestratorPrefs {
        return { mode, activeAgent: activeForegroundAgent?.name, activeTeam: activeTeamName || undefined, activeChain: activeChain?.name };
    }

    // ── Team widget ───────────────────────────────────────────────────────────

    function renderTeamCard(state: AgentState, colWidth: number, theme: any): string[] {
        const w = Math.max(1, colWidth - 2);
        const trunc = (s: string, max: number) => {
            if (max <= 0) return "";
            if (s.length <= max) return s;
            if (max <= 3) return s.slice(0, max);
            return s.slice(0, max - 3) + "...";
        };

        const sc = state.status === "idle" ? "dim" : state.status === "running" ? "accent"
            : state.status === "done" ? "success" : "error";
        const si = state.status === "idle" ? "○" : state.status === "running" ? "●"
            : state.status === "done" ? "✓" : "✗";

        const name = displayName(state.def.name);
        const nameStr = theme.fg("accent", theme.bold(trunc(name, w)));
        const nameVis = Math.min(name.length, w);

        const statusStr = `${si} ${state.status}`;
        const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
        const statusLine = theme.fg(sc, statusStr + timeStr);
        const statusVis = statusStr.length + timeStr.length;

        const contextPct = Math.max(0, Math.min(100, Number.isFinite(state.contextPct) ? state.contextPct : 0));
        const filled = Math.max(0, Math.min(5, Math.ceil(contextPct / 20)));
        const barColor = contextPct > 80 ? "error" : contextPct > 50 ? "warning" : "success";
        const barStr = theme.fg(barColor, "#".repeat(filled)) + theme.fg("dim", "-".repeat(5 - filled)) + ` ${Math.ceil(contextPct)}%`;

        const workRaw = (state.task && state.lastWork) ? state.lastWork
            : state.task ? state.task
            : state.def.description;
        const workText = trunc(workRaw, Math.min(50, w - 1));
        const workColor = state.status === "idle" ? "dim" : state.status === "running" ? "accent" : "muted";
        const workLine = theme.fg(workColor, workText);

        const borderColor = state.status === "idle" ? "dim" : sc;
        const top = theme.fg(borderColor, "┌" + "─".repeat(w) + "┐");
        const bot = theme.fg(borderColor, "└" + "─".repeat(w) + "┘");
        const bdr = (content: string, visLen: number) =>
            theme.fg(borderColor, "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg(borderColor, "│");

        return [
            top,
            bdr(" " + nameStr, 1 + nameVis),
            bdr(" " + statusLine, 1 + statusVis),
            bdr(" " + barStr, 1 + visibleWidth(barStr)),
            bdr(" " + workLine, 1 + workText.length),
            bot,
        ];
    }

    function updateTeamWidget() {
        if (!widgetCtx) return;
        widgetCtx.ui.setWidget("agent-team", (_tui: any, theme: any) => {
            const text = new Text("", 0, 1);
            return {
                render(width: number): string[] {
                    if (agentStates.size === 0) {
                        text.setText(theme.fg("dim", "No agents loaded. Add .md files to ~/.pi/agent/agents/ or .pi/agents/"));
                        return text.render(width);
                    }
                    const cols = Math.max(1, Math.min(gridCols, agentStates.size));
                    const colWidth = Math.max(3, Math.floor((Math.max(1, width) - (cols - 1)) / cols));
                    const arr = Array.from(agentStates.values());
                    const rows: string[][] = [];

                    for (let i = 0; i < arr.length; i += cols) {
                        const rowAgents = arr.slice(i, i + cols);
                        const cards = rowAgents.map(a => renderTeamCard(a, colWidth, theme));
                        while (cards.length < cols) cards.push(Array(6).fill(" ".repeat(colWidth)));
                        for (let line = 0; line < cards[0].length; line++) rows.push(cards.map(c => c[line] || ""));
                    }

                    text.setText(rows.map(r => r.join(" ")).join("\n"));
                    return text.render(width);
                },
                invalidate() { text.invalidate(); },
            };
        });
    }

    // ── Chain widget ──────────────────────────────────────────────────────────

    function renderChainCard(state: StepState, colWidth: number, theme: any): string[] {
        const w = Math.max(1, colWidth - 2);
        const trunc = (s: string, max: number) => {
            if (max <= 0) return "";
            if (s.length <= max) return s;
            if (max <= 3) return s.slice(0, max);
            return s.slice(0, max - 3) + "...";
        };

        const sc = state.status === "pending" ? "dim" : state.status === "running" ? "accent"
            : state.status === "done" ? "success" : "error";
        const si = state.status === "pending" ? "○" : state.status === "running" ? "●"
            : state.status === "done" ? "✓" : "✗";

        const name = displayName(state.agent);
        const nameStr = theme.fg("accent", theme.bold(trunc(name, w)));
        const nameVis = Math.min(name.length, w);

        const statusStr = `${si} ${state.status}`;
        const timeStr = state.status !== "pending" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
        const statusLine = theme.fg(sc, statusStr + timeStr);
        const statusVis = statusStr.length + timeStr.length;

        const agentDef = allAgents.get(state.agent.toLowerCase());
        const workRaw = state.lastWork || (state.status === "pending" && agentDef ? agentDef.description : "");
        const workText = workRaw ? trunc(workRaw, Math.min(50, w - 1)) : "";
        const workLine = workText ? theme.fg("muted", workText) : theme.fg("dim", "—");
        const workVis = workText ? workText.length : 1;

        const top = "┌" + "─".repeat(w) + "┐";
        const bot = "└" + "─".repeat(w) + "┘";
        const bdr = (content: string, visLen: number) =>
            theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

        return [
            theme.fg("dim", top),
            bdr(" " + nameStr, 1 + nameVis),
            bdr(" " + statusLine, 1 + statusVis),
            bdr(" " + workLine, 1 + workVis),
            theme.fg("dim", bot),
        ];
    }

    function updateChainWidget() {
        if (!widgetCtx) return;
        widgetCtx.ui.setWidget("agent-chain", (_tui: any, theme: any) => {
            const text = new Text("", 0, 1);
            return {
                render(width: number): string[] {
                    if (!activeChain || stepStates.length === 0) {
                        text.setText(theme.fg("dim", "No chain active. Use /chain to select one."));
                        return text.render(width);
                    }
                    const arrowWidth = 5;
                    const cols = stepStates.length;
                    const colWidth = Math.max(12, Math.floor((width - arrowWidth * (cols - 1)) / cols));
                    const cards = stepStates.map(s => renderChainCard(s, colWidth, theme));
                    const cardHeight = cards[0].length;
                    const out: string[] = [];

                    for (let line = 0; line < cardHeight; line++) {
                        let row = cards[0][line];
                        for (let c = 1; c < cols; c++) {
                            row += line === 2 ? theme.fg("dim", " ──▶ ") : " ".repeat(arrowWidth);
                            row += cards[c][line];
                        }
                        out.push(row);
                    }

                    text.setText(out.join("\n"));
                    return text.render(width);
                },
                invalidate() { text.invalidate(); },
            };
        });
    }

    // ── Footer metadata ───────────────────────────────────────────────────────

    function updateFooter(ctx: any) {
        if (!ctx) return;
        let modeLabel: string;
        if (mode === "agent") modeLabel = `agent:${activeForegroundAgent?.name || "none"}`;
        else if (mode === "chain") modeLabel = `chain:${activeChain?.name || "no-chain"}`;
        else if (mode === "team") modeLabel = `team:${activeTeamName || "no-team"}`;
        else modeLabel = "standard";

        (globalThis as any).__piOrchestratorModeTitle = modeLabel;
        ctx.ui.requestRender?.();
    }

    // ── Data loaders ──────────────────────────────────────────────────────────

    function loadTeamData(cwd: string) {
        teamSessionDir = path.join(cwd, ".pi", "agent-sessions", "team");
        if (!fs.existsSync(teamSessionDir)) fs.mkdirSync(teamSessionDir, { recursive: true });

        allAgentDefs = scanAgentDirs(cwd);

        teams = {};
        for (const tp of [
            path.join(DEFAULT_AGENTS_DIR, "teams.yaml"),
            path.join(GLOBAL_AGENTS_DIR, "teams.yaml"),
            path.join(cwd, ".pi", "agents", "teams.yaml"),
        ]) {
            if (fs.existsSync(tp)) {
                try { Object.assign(teams, parseTeamsYaml(fs.readFileSync(tp, "utf-8"))); } catch {}
            }
        }

        if (Object.keys(teams).length === 0) {
            teams = { all: allAgentDefs.map(d => d.name) };
        }
    }

    function loadChainData(cwd: string) {
        chainSessionDir = path.join(cwd, ".pi", "agent-sessions", "chain");
        if (!fs.existsSync(chainSessionDir)) fs.mkdirSync(chainSessionDir, { recursive: true });

        allAgents = new Map(scanAgentDirs(cwd).map(d => [d.name.toLowerCase(), d]));
        agentSessions.clear();
        for (const [key] of allAgents) {
            const sf = path.join(chainSessionDir, `chain-${key}.json`);
            agentSessions.set(key, fs.existsSync(sf) ? sf : null);
        }

        chains = [];
        for (const cp of [
            path.join(DEFAULT_AGENTS_DIR, "agent-chain.yaml"),
            path.join(GLOBAL_AGENTS_DIR, "agent-chain.yaml"),
            path.join(cwd, ".pi", "agents", "agent-chain.yaml"),
        ]) {
            if (fs.existsSync(cp)) {
                try {
                    for (const nc of parseChainYaml(fs.readFileSync(cp, "utf-8"))) {
                        const idx = chains.findIndex(c => c.name === nc.name);
                        if (idx >= 0) chains[idx] = nc; else chains.push(nc);
                    }
                } catch {}
            }
        }
    }

    function activateTeam(teamName: string) {
        activeTeamName = teamName;
        const defsByName = new Map(allAgentDefs.map(d => [d.name.toLowerCase(), d]));
        agentStates.clear();

        for (const member of (teams[teamName] || [])) {
            const def = defsByName.get(member.toLowerCase());
            if (!def) continue;
            const key = def.name.toLowerCase().replace(/\s+/g, "-");
            const sf = path.join(teamSessionDir, `${key}.json`);
            agentStates.set(def.name.toLowerCase(), {
                def, status: "idle", task: "", toolCount: 0, elapsed: 0,
                lastWork: "", contextPct: 0,
                sessionFile: fs.existsSync(sf) ? sf : null,
                runCount: 0,
            });
        }

        const size = agentStates.size;
        gridCols = size <= 3 ? size || 1 : size === 4 ? 2 : 3;
    }

    function activateChain(chain: ChainDef) {
        activeChain = chain;
        stepStates = chain.steps.map(s => ({ agent: s.agent, status: "pending" as const, elapsed: 0, lastWork: "" }));
        if (!pendingReset) updateChainWidget();
    }

    function foregroundAgents(): AgentDef[] {
        const marked = allAgentDefs.filter(def => def.role === "foreground" || def.role === "both");
        return marked.length > 0 ? marked : allAgentDefs;
    }

    function backgroundAgentsFor(def: AgentDef | undefined): AgentDef[] {
        const allowed = def?.backgroundAgents ?? def?.subagentAgents;
        const backgroundDefs = allAgentDefs.filter(candidate => candidate.role !== "foreground" && candidate.name.toLowerCase() !== def?.name.toLowerCase());
        if (!allowed || allowed.length === 0) return backgroundDefs;
        const allowedSet = new Set(allowed.map(name => name.toLowerCase()));
        return backgroundDefs.filter(candidate => allowedSet.has(candidate.name.toLowerCase()));
    }

    function setSubagentAllowlist(def: AgentDef | undefined) {
        const allowed = def ? backgroundAgentsFor(def).map(agent => agent.name) : undefined;
        (globalThis as any).__pi_subagents?.setAllowedAgents?.(allowed);
    }

    function resolveAgent(name: string, candidates = allAgentDefs): AgentDef | undefined {
        const normalized = name.toLowerCase();
        return candidates.find(def => def.name.toLowerCase() === normalized)
            ?? candidates.find(def => def.name.toLowerCase().replace(/\s+/g, "-") === normalized);
    }

    async function applyForegroundAgent(def: AgentDef, ctx: any) {
        activeForegroundAgent = def;
        mode = "agent";
        setSubagentAllowlist(def);

        const slash = def.model?.indexOf("/") ?? -1;
        if (def.model && slash > 0) {
            const model = ctx.modelRegistry.find(def.model.slice(0, slash), def.model.slice(slash + 1));
            if (model) {
                const ok = await pi.setModel(model);
                if (!ok) ctx.ui.notify(`Could not switch to ${def.model}; auth may be missing`, "warning");
            } else {
                ctx.ui.notify(`Foreground agent model not found: ${def.model}`, "warning");
            }
        }
        if (def.thinking) pi.setThinkingLevel(def.thinking as any);

        savePrefs(currentPrefs());
        applyMode(ctx);
    }

    // ── Model helpers ─────────────────────────────────────────────────────────

    function modelFor(ctx: any, agentDef?: AgentDef): string {
        return agentDef?.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : DEFAULT_MODEL);
    }

    function thinkingFor(agentDef?: AgentDef): string {
        return agentDef?.thinking || "off";
    }

    // ── Spawn helpers for team/chain agents ───────────────────────────────────

    /**
     * Build the args array and childEnv for spawning a team or chain agent.
     * Writes the system prompt to a file in sessionDir to avoid shell-escaping issues.
     */
    function buildAgentSpawnArgs(params: {
        agentKey: string;
        def: AgentDef;
        model: string;
        thinking: string;
        sessionFile: string;
        hasExistingSession: boolean;
        task: string;
        sessionDir: string;
    }): { command: string; args: string[]; childEnv: NodeJS.ProcessEnv | undefined } {
        const { agentKey, def, model, thinking, sessionFile, hasExistingSession, task, sessionDir } = params;
        const { command, baseArgs } = resolvePiBinary();

        // Write system prompt to file (avoids shell-escaping issues with multiline prompts)
        const promptPath = path.join(sessionDir, `${agentKey}-prompt.md`);
        try { fs.writeFileSync(promptPath, def.systemPrompt, { encoding: "utf-8" }); } catch {}

        // Separate builtin tools from extension-provided tools
        const toolList = def.tools.split(",").map(t => t.trim()).filter(Boolean);
        const allowlist: string[] = [];
        const extPaths = new Set<string>();
        for (const tool of toolList) {
            if (BUILTIN_TOOLS.has(tool)) {
                allowlist.push(tool);
            } else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
                allowlist.push(tool);
                extPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
            }
        }

        const args = [
            ...baseArgs,
            "--mode", "json", "-p", "--no-extensions",
            "--model", model,
            "--thinking", thinking,
            "--append-system-prompt", promptPath,
            "--session", sessionFile,
        ];

        if (allowlist.length > 0) {
            args.push("--tools", allowlist.join(","));
        } else {
            args.push("--no-tools");
        }
        for (const p of extPaths) args.push("--extension", p);

        if (hasExistingSession) args.push("-c");
        args.push(task);

        // PI_SUBAGENT_ALLOWED env for recursion depth control
        let childEnv: NodeJS.ProcessEnv | undefined;
        if (toolList.includes("subagent") && def.subagentAgents && def.subagentAgents.length > 0) {
            childEnv = { ...process.env, PI_SUBAGENT_ALLOWED: def.subagentAgents.join(",") };
        }

        return { command, args, childEnv };
    }

    // ── Team agent dispatcher ─────────────────────────────────────────────────

    function dispatchTeamAgent(agentName: string, task: string, ctx: any): Promise<{ output: string; exitCode: number; elapsed: number }> {
        const key = agentName.toLowerCase();
        const state = agentStates.get(key);

        if (!state) {
            const avail = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");
            return Promise.resolve({ output: `Agent "${agentName}" not found. Available: ${avail}`, exitCode: 1, elapsed: 0 });
        }
        if (state.status === "running") {
            return Promise.resolve({ output: `Agent "${displayName(state.def.name)}" is already running.`, exitCode: 1, elapsed: 0 });
        }

        state.status = "running"; state.task = task; state.toolCount = 0;
        state.elapsed = 0; state.lastWork = ""; state.runCount++;
        updateTeamWidget();

        const startTime = Date.now();
        state.timer = setInterval(() => { state.elapsed = Date.now() - startTime; updateTeamWidget(); }, 1000);

        const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
        const sessionFile = path.join(teamSessionDir, `${agentKey}.json`);
        const { command, args, childEnv } = buildAgentSpawnArgs({
            agentKey,
            def: state.def,
            model: modelFor(ctx, state.def),
            thinking: thinkingFor(state.def),
            sessionFile,
            hasExistingSession: !!state.sessionFile,
            task,
            sessionDir: teamSessionDir,
        });

        const textChunks: string[] = [];
        return new Promise((resolve) => {
            const proc = spawn(command, args, getSpawnOptions(childEnv));

            proc.on("error", (err: any) => {
                clearInterval(state.timer);
                state.status = "error"; state.lastWork = `Error: ${err.message}`; updateTeamWidget();
                resolve({ output: `Error spawning agent: ${err.message}`, exitCode: 1, elapsed: Date.now() - startTime });
            });

            let buffer = "";

            proc.stdout!.setEncoding("utf-8");
            proc.stdout!.on("data", (chunk: string) => {
                buffer += chunk;
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const ev = JSON.parse(line);
                        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
                            textChunks.push(ev.assistantMessageEvent.delta || "");
                            state.lastWork = textChunks.join("").split("\n").filter((l: string) => l.trim()).pop() || "";
                            updateTeamWidget();
                        } else if (ev.type === "tool_execution_start") {
                            state.toolCount++; updateTeamWidget();
                        } else if (ev.type === "message_end" && ev.message?.usage && contextWindow > 0) {
                            state.contextPct = ((ev.message.usage.input || 0) / contextWindow) * 100;
                            updateTeamWidget();
                        } else if (ev.type === "agent_end") {
                            const last = [...(ev.messages || [])].reverse().find((m: any) => m.role === "assistant");
                            if (last?.usage && contextWindow > 0) {
                                state.contextPct = ((last.usage.input || 0) / contextWindow) * 100;
                                updateTeamWidget();
                            }
                        }
                    } catch {}
                }
            });

            proc.stderr!.setEncoding("utf-8");
            proc.stderr!.on("data", () => {});

            proc.on("close", (code: number | null) => {
                if (buffer.trim()) {
                    try {
                        const ev = JSON.parse(buffer);
                        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta")
                            textChunks.push(ev.assistantMessageEvent.delta || "");
                    } catch {}
                }
                clearInterval(state.timer);
                state.elapsed = Date.now() - startTime;
                state.status = code === 0 ? "done" : "error";
                if (code === 0) state.sessionFile = sessionFile;
                const full = textChunks.join("");
                state.lastWork = full.split("\n").filter((l: string) => l.trim()).pop() || "";
                updateTeamWidget();
                ctx.ui.notify(`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`, state.status === "done" ? "info" : "error");
                resolve({ output: full, exitCode: code ?? 1, elapsed: state.elapsed });
            });
        });
    }

    // ── Chain step runner ─────────────────────────────────────────────────────

    function runChainAgent(agentDef: AgentDef, task: string, stepIndex: number, ctx: any): Promise<{ output: string; exitCode: number; elapsed: number }> {
        const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
        const sessionFile = path.join(chainSessionDir, `chain-${agentKey}.json`);
        const hasSession = !!agentSessions.get(agentKey);

        const { command, args, childEnv } = buildAgentSpawnArgs({
            agentKey,
            def: agentDef,
            model: modelFor(ctx, agentDef),
            thinking: thinkingFor(agentDef),
            sessionFile,
            hasExistingSession: hasSession,
            task,
            sessionDir: chainSessionDir,
        });

        const textChunks: string[] = [];
        const startTime = Date.now();
        const state = stepStates[stepIndex];

        return new Promise((resolve) => {
            const proc = spawn(command, args, getSpawnOptions(childEnv));

            let timer: ReturnType<typeof setInterval> | null = null;
            proc.on("error", (err: any) => {
                if (timer) clearInterval(timer);
                resolve({ output: `Error: ${err.message}`, exitCode: 1, elapsed: Date.now() - startTime });
            });

            timer = setInterval(() => { state.elapsed = Date.now() - startTime; updateChainWidget(); }, 1000);
            let buffer = "";

            proc.stdout!.setEncoding("utf-8");
            proc.stdout!.on("data", (chunk: string) => {
                buffer += chunk;
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const ev = JSON.parse(line);
                        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
                            textChunks.push(ev.assistantMessageEvent.delta || "");
                            state.lastWork = textChunks.join("").split("\n").filter((l: string) => l.trim()).pop() || "";
                            updateChainWidget();
                        }
                    } catch {}
                }
            });

            proc.stderr!.setEncoding("utf-8");
            proc.stderr!.on("data", () => {});

            proc.on("close", (code: number | null) => {
                if (buffer.trim()) {
                    try {
                        const ev = JSON.parse(buffer);
                        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta")
                            textChunks.push(ev.assistantMessageEvent.delta || "");
                    } catch {}
                }
                clearInterval(timer);
                state.elapsed = Date.now() - startTime;
                const output = textChunks.join("");
                state.lastWork = output.split("\n").filter((l: string) => l.trim()).pop() || "";
                if (code === 0) agentSessions.set(agentKey, sessionFile);
                resolve({ output, exitCode: code ?? 1, elapsed: state.elapsed });
            });
        });
    }

    async function runChainPipeline(task: string, ctx: any): Promise<{ output: string; success: boolean; elapsed: number }> {
        if (!activeChain) return { output: "No chain active", success: false, elapsed: 0 };

        const chainStart = Date.now();
        stepStates = activeChain.steps.map(s => ({ agent: s.agent, status: "pending" as const, elapsed: 0, lastWork: "" }));
        updateChainWidget();

        let input = task;
        for (let i = 0; i < activeChain.steps.length; i++) {
            const step = activeChain.steps[i];
            stepStates[i].status = "running";
            updateChainWidget();

            const resolvedPrompt = step.prompt.replace(/\$INPUT/g, input).replace(/\$ORIGINAL/g, task);
            const agentDef = allAgents.get(step.agent.toLowerCase());

            if (!agentDef) {
                stepStates[i].status = "error";
                stepStates[i].lastWork = `Agent "${step.agent}" not found`;
                updateChainWidget();
                return {
                    output: `Error at step ${i + 1}: Agent "${step.agent}" not found. Available: ${Array.from(allAgents.keys()).join(", ")}`,
                    success: false, elapsed: Date.now() - chainStart,
                };
            }

            const result = await runChainAgent(agentDef, resolvedPrompt, i, ctx);
            if (result.exitCode !== 0) {
                stepStates[i].status = "error"; updateChainWidget();
                return { output: `Error at step ${i + 1} (${step.agent}): ${result.output}`, success: false, elapsed: Date.now() - chainStart };
            }

            stepStates[i].status = "done"; updateChainWidget();
            input = result.output;
        }

        return { output: input, success: true, elapsed: Date.now() - chainStart };
    }

    // ── Mode management ───────────────────────────────────────────────────────

    function readSearchTools(): string[] {
        const allowed = new Set(["read", "grep", "find", "ls", "rg"]);
        return baseTools.filter(name => allowed.has(name));
    }

    function activeToolsForMode(): string[] {
        if (mode === "standard") return Array.from(new Set(baseTools));
        if (mode === "agent" && activeForegroundAgent) {
            const available = new Set(pi.getAllTools().map(tool => tool.name));
            const requested = activeForegroundAgent.tools.split(",").map(tool => tool.trim()).filter(Boolean);
            const selected = requested.filter(tool => available.has(tool));
            return Array.from(new Set(selected.length > 0 ? selected : baseTools));
        }
        if (mode === "team") return Array.from(new Set([...readSearchTools(), "dispatch_agent"]));
        return Array.from(new Set([...baseTools, "run_chain"]));
    }

    function applyMode(ctx: any) {
        pi.setActiveTools(activeToolsForMode());

        ctx.ui.setWidget("agent-team", undefined);
        ctx.ui.setWidget("agent-chain", undefined);

        if (mode === "standard") {
            setSubagentAllowlist(undefined);
            ctx.ui.setStatus("orchestrator", "Mode: standard");
        } else if (mode === "agent") {
            setSubagentAllowlist(activeForegroundAgent);
            ctx.ui.setStatus("orchestrator", `Agent: ${activeForegroundAgent?.name || "none"}`);
        } else if (mode === "team") {
            setSubagentAllowlist(undefined);
            updateTeamWidget();
            ctx.ui.setStatus("orchestrator", `Mode: team · ${activeTeamName} (${agentStates.size})`);
        } else {
            setSubagentAllowlist(undefined);
            updateChainWidget();
            ctx.ui.setStatus("orchestrator", `Mode: chain · ${activeChain?.name || "no chain"}`);
        }
        updateFooter(ctx);
    }

    function switchMode(newMode: OrchestratorMode, ctx: any) {
        mode = newMode;
        savePrefs(currentPrefs());
        applyMode(ctx);
    }

    // ── Tool registrations ────────────────────────────────────────────────────

    pi.registerTool({
        name: "dispatch_agent",
        label: "Dispatch Agent",
        description: "Dispatch a task to a specialist agent from the active team. The agent executes and returns results.",
        promptSnippet: "Dispatch focused tasks to specialist agents from the active team",
        promptGuidelines: [
            "Use dispatch_agent in team mode for implementation, review, and substantial investigation instead of doing that work directly.",
            "Use dispatch_agent with one clear objective per task and only agents listed in the active team prompt.",
        ],
        parameters: Type.Object({
            agent: Type.String({ description: "Agent name (case-insensitive, as listed in the system prompt)" }),
            task: Type.String({ description: "Task description for the agent to execute" }),
        }),
        async execute(_id, params, _signal, onUpdate, ctx) {
            const { agent, task } = params as { agent: string; task: string };
            try {
                if (onUpdate) onUpdate({ content: [{ type: "text", text: `Dispatching to ${agent}...` }], details: { agent, task, status: "dispatching" } });
                const result = await dispatchTeamAgent(agent, task, ctx);
                const truncated = result.output.length > 8000 ? result.output.slice(0, 8000) + "\n\n... [truncated]" : result.output;
                const status = result.exitCode === 0 ? "done" : "error";
                return {
                    content: [{ type: "text", text: `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s\n\n${truncated}` }],
                    details: { agent, task, status, elapsed: result.elapsed, exitCode: result.exitCode, fullOutput: result.output },
                };
            } catch (err: any) {
                return { content: [{ type: "text", text: `Error: ${err?.message || err}` }], details: { agent, task, status: "error", elapsed: 0, exitCode: 1, fullOutput: "" } };
            }
        },
        renderCall(args, theme) {
            const a = (args as any).agent || "?", t = (args as any).task || "";
            return new Text(theme.fg("toolTitle", theme.bold("dispatch_agent ")) + theme.fg("accent", a) + theme.fg("dim", " — ") + theme.fg("muted", t.length > 60 ? t.slice(0, 57) + "..." : t), 0, 0);
        },
        renderResult(result, options, theme) {
            const d = result.details as any;
            if (!d) { const t = result.content[0]; return new Text(t?.type === "text" ? t.text : "", 0, 0); }
            if (options.isPartial || d.status === "dispatching") return new Text(theme.fg("accent", `● ${d.agent || "?"}`) + theme.fg("dim", " working..."), 0, 0);
            const icon = d.status === "done" ? "✓" : "✗";
            const color = d.status === "done" ? "success" : "error";
            const header = theme.fg(color, `${icon} ${d.agent}`) + theme.fg("dim", ` ${Math.round((d.elapsed || 0) / 1000)}s`);
            if (options.expanded && d.fullOutput) return new Text(header + "\n" + theme.fg("muted", d.fullOutput.length > 4000 ? d.fullOutput.slice(0, 4000) + "\n... [truncated]" : d.fullOutput), 0, 0);
            return new Text(header, 0, 0);
        },
    });

    pi.registerTool({
        name: "run_chain",
        label: "Run Chain",
        description: "Execute the active agent chain pipeline sequentially. Each step's output feeds into the next as $INPUT.",
        promptSnippet: "Run the active sequential agent chain pipeline",
        promptGuidelines: [
            "Use run_chain in chain mode for significant work that benefits from the full active pipeline.",
            "Use run_chain with the original user task; each chain step receives the previous step output as $INPUT.",
        ],
        parameters: Type.Object({ task: Type.String({ description: "The task/prompt for the chain to process" }) }),
        async execute(_id, params, _signal, onUpdate, ctx) {
            const { task } = params as { task: string };
            if (onUpdate) onUpdate({ content: [{ type: "text", text: `Starting chain: ${activeChain?.name}...` }], details: { chain: activeChain?.name, task, status: "running" } });
            const result = await runChainPipeline(task, ctx);
            const truncated = result.output.length > 8000 ? result.output.slice(0, 8000) + "\n\n... [truncated]" : result.output;
            const status = result.success ? "done" : "error";
            return {
                content: [{ type: "text", text: `[chain:${activeChain?.name}] ${status} in ${Math.round(result.elapsed / 1000)}s\n\n${truncated}` }],
                details: { chain: activeChain?.name, task, status, elapsed: result.elapsed, fullOutput: result.output },
            };
        },
        renderCall(args, theme) {
            const t = (args as any).task || "";
            return new Text(theme.fg("toolTitle", theme.bold("run_chain ")) + theme.fg("accent", activeChain?.name || "?") + theme.fg("dim", " — ") + theme.fg("muted", t.length > 60 ? t.slice(0, 57) + "..." : t), 0, 0);
        },
        renderResult(result, options, theme) {
            const d = result.details as any;
            if (!d) { const t = result.content[0]; return new Text(t?.type === "text" ? t.text : "", 0, 0); }
            if (options.isPartial || d.status === "running") return new Text(theme.fg("accent", `● ${d.chain || "chain"}`) + theme.fg("dim", " running..."), 0, 0);
            const icon = d.status === "done" ? "✓" : "✗";
            const color = d.status === "done" ? "success" : "error";
            const header = theme.fg(color, `${icon} ${d.chain}`) + theme.fg("dim", ` ${Math.round((d.elapsed || 0) / 1000)}s`);
            if (options.expanded && d.fullOutput) return new Text(header + "\n" + theme.fg("muted", d.fullOutput.length > 4000 ? d.fullOutput.slice(0, 4000) + "\n... [truncated]" : d.fullOutput), 0, 0);
            return new Text(header, 0, 0);
        },
    });

    // ── Commands ──────────────────────────────────────────────────────────────

    pi.registerCommand("agent", {
        description: "Select a foreground agent: /agent or /agent <name>",
        getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
            const query = prefix.trim().toLowerCase();
            const items = foregroundAgents()
                .filter(def => !query || def.name.toLowerCase().includes(query))
                .map(def => ({ value: def.name, label: def.name, description: def.description }));
            return items.length > 0 ? items : null;
        },
        handler: async (args, ctx) => {
            widgetCtx = ctx;
            const candidates = foregroundAgents();
            if (candidates.length === 0) {
                ctx.ui.notify("No agents found. Add agent .md files to ~/.pi/agent/agents/ or .pi/agents/.", "warning");
                return;
            }

            let selectedName = args?.trim();
            if (!selectedName) {
                const labels = candidates.map(def => `${def.name}${activeForegroundAgent?.name === def.name ? " ◀ current" : ""} — ${def.description || "no description"}`);
                const choice = await ctx.ui.select("Select Foreground Agent", labels);
                if (choice === undefined) return;
                selectedName = candidates[labels.indexOf(choice)]?.name;
            }

            const def = selectedName ? resolveAgent(selectedName, candidates) : undefined;
            if (!def) {
                ctx.ui.notify(`Foreground agent not found: ${selectedName}\nAvailable: ${candidates.map(agent => agent.name).join(", ")}`, "error");
                return;
            }

            await applyForegroundAgent(def, ctx);
            const backgrounds = backgroundAgentsFor(def).map(agent => agent.name).join(", ") || "none";
            ctx.ui.notify(`Foreground agent: ${def.name}\nBackground agents: ${backgrounds}`, "info");
        },
    });

    pi.registerCommand("mode", {
        description: "Select orchestration mode",
        handler: async (args, ctx) => {
            widgetCtx = ctx;
            let newMode = args?.trim();

            if (newMode === "status") {
                const foregroundInfo = activeForegroundAgent ? `${activeForegroundAgent.name} (${backgroundAgentsFor(activeForegroundAgent).length} background agents)` : `${foregroundAgents().length} foreground agent(s) loaded`;
                const teamInfo = activeTeamName ? `${activeTeamName} (${agentStates.size} agents)` : `${Object.keys(teams).length} team(s) loaded`;
                const chainInfo = activeChain ? `${activeChain.name} (${activeChain.steps.length} steps)` : `${chains.length} chain(s) loaded`;
                ctx.ui.notify(`Mode: ${mode}\nAgent: ${foregroundInfo}\nTeam: ${teamInfo}\nChain: ${chainInfo}\nTools: ${activeToolsForMode().join(", ")}`, "info");
                return;
            }

            if (!newMode) {
                const modeValues: OrchestratorMode[] = ["standard", "agent", "team", "chain"];
                const optionLabels = modeValues.map(value => {
                    if (value === "standard") return `standard${mode === value ? " ◀ current" : ""} — normal Pi agent with default tools`;
                    if (value === "agent") return `agent${mode === value ? " ◀ current" : ""} — foreground agent (${activeForegroundAgent?.name || foregroundAgents().length + " agents"})`;
                    if (value === "team") return `team${mode === value ? " ◀ current" : ""} — dispatcher with specialist agent grid (${activeTeamName || Object.keys(teams).length + " teams"})`;
                    return `chain${mode === value ? " ◀ current" : ""} — sequential pipeline (${activeChain?.name || chains.length + " chains"})`;
                });
                const choice = await ctx.ui.select("Select Orchestration Mode", optionLabels);
                if (choice === undefined) return;
                newMode = modeValues[optionLabels.indexOf(choice)];
            }

            if (!["standard", "agent", "team", "chain"].includes(newMode)) {
                ctx.ui.notify("Invalid mode. Use: standard, agent, team, or chain", "error"); return;
            }
            if (newMode === mode) { ctx.ui.notify(`Already in ${mode} mode`, "info"); return; }
            if (newMode === "agent" && !activeForegroundAgent) {
                const def = foregroundAgents()[0];
                if (!def) { ctx.ui.notify("No foreground agents available. Use /agent after adding agent .md files.", "warning"); return; }
                await applyForegroundAgent(def, ctx);
                ctx.ui.notify(`Foreground agent: ${def.name}`, "info");
                return;
            }

            switchMode(newMode as OrchestratorMode, ctx);
            ctx.ui.notify(`Switched to ${mode} mode`, "info");
        },
    });

    // — Team commands —

    pi.registerCommand("team", {
        description: "Select a team and switch to team mode",
        handler: async (_args, ctx) => {
            widgetCtx = ctx;
            const teamNames = Object.keys(teams);
            if (teamNames.length === 0) { ctx.ui.notify("No teams defined. Add teams.yaml to ~/.pi/agent/agents/ or .pi/agents/", "warning"); return; }

            const options = teamNames.map(name => `${name} — ${(teams[name] || []).map(m => displayName(m)).join(", ")}`);
            const choice = await ctx.ui.select("Select Team", options);
            if (choice === undefined) return;

            const name = teamNames[options.indexOf(choice)];
            activateTeam(name);
            switchMode("team", ctx);
            ctx.ui.notify(`Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
        },
    });

    pi.registerCommand("team-list", {
        description: "List all loaded agents and their status",
        handler: async (_args, ctx) => {
            widgetCtx = ctx;
            const names = Array.from(agentStates.values())
                .map(s => `${displayName(s.def.name)} (${s.status}, runs: ${s.runCount}): ${s.def.description}`)
                .join("\n");
            ctx.ui.notify(names || "No agents loaded", "info");
        },
    });

    pi.registerCommand("agents-grid", {
        description: "Set grid columns: /agents-grid <1-6>",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
            const items = ["1", "2", "3", "4", "5", "6"].map(n => ({ value: n, label: `${n} columns` }));
            const filtered = items.filter(i => i.value.startsWith(prefix));
            return filtered.length > 0 ? filtered : items;
        },
        handler: async (args, ctx) => {
            widgetCtx = ctx;
            const n = parseInt(args?.trim() || "", 10);
            if (n >= 1 && n <= 6) { gridCols = n; ctx.ui.notify(`Grid: ${gridCols} columns`, "info"); updateTeamWidget(); }
            else ctx.ui.notify("Usage: /agents-grid <1-6>", "error");
        },
    });

    // — Chain commands —

    pi.registerCommand("chain", {
        description: "Select a chain and switch to chain mode",
        handler: async (_args, ctx) => {
            widgetCtx = ctx;
            if (chains.length === 0) { ctx.ui.notify("No chains defined. Add agent-chain.yaml to ~/.pi/agent/agents/ or .pi/agents/", "warning"); return; }

            const options = chains.map(c => {
                const flow = c.steps.map(s => displayName(s.agent)).join(" → ");
                return `${c.name}${c.description ? ` — ${c.description}` : ""} (${flow})`;
            });
            const choice = await ctx.ui.select("Select Chain", options);
            if (choice === undefined) return;

            const chain = chains[options.indexOf(choice)];
            activateChain(chain);
            switchMode("chain", ctx);
            ctx.ui.notify(`Chain: ${chain.name}\n${chain.description}\n${chain.steps.map(s => displayName(s.agent)).join(" → ")}`, "info");
        },
    });

    pi.registerCommand("chain-list", {
        description: "List all available chains",
        handler: async (_args, ctx) => {
            widgetCtx = ctx;
            if (chains.length === 0) { ctx.ui.notify("No chains defined. Add agent-chain.yaml to ~/.pi/agent/agents/ or .pi/agents/", "warning"); return; }
            const list = chains.map(c => {
                const steps = c.steps.map((s, i) => `  ${i + 1}. ${displayName(s.agent)}`).join("\n");
                return `${c.name}:${c.description ? "\n  " + c.description : ""}\n${steps}`;
            }).join("\n\n");
            ctx.ui.notify(list, "info");
        },
    });

    pi.registerCommand("chain-run", {
        description: "Run the active chain directly: /chain-run <task>",
        handler: async (args, ctx) => {
            widgetCtx = ctx;
            const task = args?.trim();
            if (!task) { ctx.ui.notify("Usage: /chain-run <task>", "warning"); return; }
            if (!activeChain) { ctx.ui.notify("No chain active. Use /chain first.", "warning"); return; }
            switchMode("chain", ctx);
            const result = await runChainPipeline(task, ctx);
            const truncated = result.output.length > 8000 ? result.output.slice(0, 8000) + "\n\n... [truncated]" : result.output;
            ctx.ui.notify(`[chain:${activeChain.name}] ${result.success ? "done" : "error"} in ${Math.round(result.elapsed / 1000)}s\n\n${truncated}`, result.success ? "success" : "error");
        },
    });

    // ── before_agent_start ────────────────────────────────────────────────────

    pi.on("before_agent_start", async (event, ctx) => {
        // Chain mode: reset step states on first turn of a new session
        if (pendingReset && activeChain && mode === "chain") {
            pendingReset = false;
            widgetCtx = ctx;
            stepStates = activeChain.steps.map(s => ({ agent: s.agent, status: "pending" as const, elapsed: 0, lastWork: "" }));
            updateChainWidget();
        }

        if (mode === "agent" && activeForegroundAgent) {
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
- Delegate focused research, exploration, review, or implementation tasks when that improves locality or parallelism.
- Include all necessary context when calling background agents; they do not inherit this conversation.

## Foreground Agent Instructions

${activeForegroundAgent.systemPrompt}`,
            };
        }

        if (mode === "team") {
            const catalog = Array.from(agentStates.values())
                .map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}\n**Model:** ${s.def.model || "current session model"}\n**Thinking:** ${s.def.thinking || "off"}`)
                .join("\n\n");
            const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");

            return {
                systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You have read/search access to inspect context, but implementation work must be delegated through agents using the dispatch_agent tool.

## Active Team: ${activeTeamName}
Members: ${members}
You can ONLY dispatch to agents listed below.

## How to Work
- Analyze the user's request and break it into clear sub-tasks
- Choose the right agent(s) for each sub-task
- Dispatch tasks using dispatch_agent
- Review results and dispatch follow-up agents if needed
- Summarize the outcome for the user

## Rules
- You may use read/search tools for quick context checks
- Do not write, edit, or execute code directly in team mode
- Use dispatch_agent for implementation, review, and substantial investigation
- You can chain agents: explorer/advisor first, then coder/critic
- Keep tasks focused — one clear objective per dispatch

## Agents

${catalog}`,
            };
        }

        if (mode === "chain" && activeChain) {
            const flow = activeChain.steps.map(s => displayName(s.agent)).join(" → ");
            const steps = activeChain.steps.map((s, i) => {
                const def = allAgents.get(s.agent.toLowerCase());
                return `${i + 1}. **${displayName(s.agent)}** — ${def?.description || ""}`;
            }).join("\n");

            const seen = new Set<string>();
            const catalog = activeChain.steps
                .filter(s => { const k = s.agent.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
                .map(s => {
                    const def = allAgents.get(s.agent.toLowerCase());
                    if (!def) return `### ${displayName(s.agent)}\nAgent not found.`;
                    return `### ${displayName(def.name)}\n${def.description}\n**Tools:** ${def.tools}\n**Model:** ${def.model || "current session model"}\n**Thinking:** ${def.thinking || "off"}\n\n${def.systemPrompt}`;
                })
                .join("\n\n---\n\n");

            return {
                systemPrompt: `You are an orchestrating agent with a sequential pipeline called "${activeChain.name}" at your disposal.
${activeChain.description ? activeChain.description + "\n" : ""}
You have full access to your own tools AND the run_chain tool to delegate to your pipeline.

## Active Chain: ${activeChain.name}
Flow: ${flow}

${steps}

## Agent Details

${catalog}

## When to Use run_chain
- Significant work: new features, refactors, multi-file changes
- Tasks that benefit from the full pipeline
- When you want structured multi-agent collaboration

## When to Work Directly
- Quick reads, status checks, single-file questions
- Anything you can handle in one step

## How run_chain Works
- Each step's output feeds into the next as $INPUT; $ORIGINAL is always the original task
- Agents maintain session context within a Pi session
- After the chain completes, summarize the result for the user`,
            };
        }

        return {};
    });

    // ── session_start ─────────────────────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        widgetCtx = ctx;
        contextWindow = (ctx as any).model?.contextWindow || 0;
        const discoveredBaseTools = pi.getActiveTools().filter(name => !orchestratorToolNames.has(name));
        if (discoveredBaseTools.length > 0 || baseTools.length === 0) baseTools = discoveredBaseTools;

        ctx.ui.setWidget("agent-team", undefined);
        ctx.ui.setWidget("agent-chain", undefined);

        const cwd = (ctx as any).cwd;

        // Wipe session files
        for (const subdir of ["team", "chain"]) {
            const dir = path.join(cwd, ".pi", "agent-sessions", subdir);
            if (fs.existsSync(dir)) {
                for (const f of fs.readdirSync(dir)) {
                    if (f.endsWith(".json")) try { fs.unlinkSync(path.join(dir, f)); } catch {}
                }
            }
        }

        loadTeamData(cwd);
        loadChainData(cwd);

        const prefs = loadPrefs();
        mode = prefs.mode;
        activeForegroundAgent = prefs.activeAgent ? resolveAgent(prefs.activeAgent, foregroundAgents()) : foregroundAgents()[0];
        if (mode === "agent" && !activeForegroundAgent) mode = "standard";

        const teamToActivate = (prefs.activeTeam && teams[prefs.activeTeam]) ? prefs.activeTeam : Object.keys(teams)[0];
        if (teamToActivate) activateTeam(teamToActivate);

        pendingReset = true;
        const chainToActivate = prefs.activeChain
            ? chains.find(c => c.name === prefs.activeChain)
            : chains[0];
        if (chainToActivate) activateChain(chainToActivate);

        const teamSummary = Object.keys(teams).length > 0
            ? `${Object.keys(teams).length} teams · ${activeTeamName || Object.keys(teams)[0] || "none"} active`
            : "no teams";
        const chainSummary = chains.length > 0
            ? `${chains.length} chains · ${activeChain?.name || "none"} active`
            : "no chains";

        const agentSummary = activeForegroundAgent
            ? `${foregroundAgents().length} foreground agents · ${activeForegroundAgent.name} active`
            : `${foregroundAgents().length} foreground agents`;

        ctx.ui.notify(
            `Agent Orchestrator · mode: ${mode}\n\n` +
            `/agent [name]  /mode [standard|agent|team|chain|status]\n\n` +
            `standard: normal Pi agent with default read/write/edit/bash tools\n` +
            `agent (${agentSummary}): foreground agent with allowed background subagents\n` +
            `team (${teamSummary}): /team  /team-list  /agents-grid\n` +
            `chain (${chainSummary}): /chain  /chain-list  /chain-run`,
            "info"
        );

        applyMode(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        if (widgetCtx === ctx) widgetCtx = undefined;
        if (ctx.hasUI) {
            ctx.ui.setWidget("agent-team", undefined);
            ctx.ui.setWidget("agent-chain", undefined);
            ctx.ui.setStatus("orchestrator", undefined);
        }
    });
}
