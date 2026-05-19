/**
 * Agent Orchestrator — Unified subagent spawning, team dispatch, and chain pipeline
 *
 * Three orchestration modes, switch with /mode:
 *
 *   subagent (default)
 *     Free-form background subagents with live stacking widgets.
 *     Tools: subagent_create, subagent_continue, subagent_remove, subagent_list
 *     Commands: /sub <task>  /subcont <id> <prompt>  /subrm <id>  /subclear  /sublist
 *
 *   team
 *     Dispatcher-only orchestrator — main agent has NO codebase tools.
 *     Agent .md files: ~/.pi/agent/agents/  or  agents/  .claude/agents/  .pi/agents/  in cwd
 *     Teams: ~/.pi/agent/agents/teams.yaml  (merged with .pi/agents/teams.yaml per project)
 *     Tool: dispatch_agent
 *     Commands: /agents-team  /agents-list  /agents-grid <1-6>
 *
 *   chain
 *     Sequential pipeline (step A → step B → step C).
 *     Chains: ~/.pi/agent/agents/agent-chain.yaml  (merged with .pi/agents/agent-chain.yaml)
 *     Tool: run_chain  (plus all default tools)
 *     Commands: /chain  /chain-list
 *
 * Mode + active team/chain persists across /new via ~/.pi/agent/orchestrator-prefs.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, type AutocompleteItem, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "openrouter/google/gemini-2.5-flash-preview";
const GLOBAL_AGENTS_DIR = path.join(os.homedir(), ".pi", "agent", "agents");
const PREFS_FILE = path.join(os.homedir(), ".pi", "agent", "orchestrator-prefs.json");

/** Resolve the pi executable name ("pi.cmd" on Windows, "pi" elsewhere) */
function getPiCommand(): string {
    return process.platform === "win32" ? "pi.cmd" : "pi";
}

// ── Types ──────────────────────────────────────────────────────────────────────

type OrchestratorMode = "subagent" | "team" | "chain";

interface OrchestratorPrefs {
    mode: OrchestratorMode;
    activeTeam?: string;
    activeChain?: string;
}

interface SubState {
    id: number;
    status: "running" | "done" | "error";
    task: string;
    textChunks: string[];
    toolCount: number;
    elapsed: number;
    sessionFile: string;
    turnCount: number;
    proc?: any;
}

interface AgentDef {
    name: string;
    description: string;
    tools: string;
    systemPrompt: string;
    file?: string;
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
        if (["subagent", "team", "chain"].includes(data.mode)) return data as OrchestratorPrefs;
    } catch {}
    return { mode: "subagent" };
}

function savePrefs(prefs: OrchestratorPrefs) {
    try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {}
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function displayName(name: string): string {
    return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function parseAgentFile(filePath: string): AgentDef | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!match) return null;

        const fm: Record<string, string> = {};
        for (const line of match[1].split("\n")) {
            const idx = line.indexOf(":");
            if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        if (!fm.name) return null;

        return {
            name: fm.name,
            description: fm.description || "",
            tools: fm.tools || "read,grep,find,ls",
            systemPrompt: match[2].trim(),
            file: filePath,
        };
    } catch { return null; }
}

function scanAgentDirs(cwd: string): AgentDef[] {
    // Global dir first so project dirs can override
    const dirs = [
        GLOBAL_AGENTS_DIR,
        path.join(cwd, "agents"),
        path.join(cwd, ".claude", "agents"),
        path.join(cwd, ".pi", "agents"),
    ];
    const agents: AgentDef[] = [];
    const seen = new Set<string>();

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        try {
            for (const file of fs.readdirSync(dir)) {
                if (!file.endsWith(".md")) continue;
                const fullPath = path.resolve(dir, file);
                const def = parseAgentFile(fullPath);
                if (!def) continue;
                const key = def.name.toLowerCase();
                // Later dirs override earlier ones (project overrides global)
                const existingIdx = agents.findIndex(a => a.name.toLowerCase() === key);
                if (existingIdx >= 0) agents[existingIdx] = def;
                else { seen.add(key); agents.push(def); }
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
    let mode: OrchestratorMode = "subagent";
    let widgetCtx: any;
    let savedTools: string[] = [];  // snapshot before team mode locks tools

    // ── Subagent state ────────────────────────────────────────────────────────
    const agents: Map<number, SubState> = new Map();
    let nextId = 1;

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
        return { mode, activeTeam: activeTeamName || undefined, activeChain: activeChain?.name };
    }

    // ── Subagent helpers ──────────────────────────────────────────────────────

    function makeSubagentSessionFile(id: number): string {
        const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
        fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, `subagent-${id}-${Date.now()}.jsonl`);
    }

    // ── Subagent widget ───────────────────────────────────────────────────────

    function updateSubWidgets() {
        if (!widgetCtx) return;
        for (const [id, state] of Array.from(agents.entries())) {
            widgetCtx.ui.setWidget(`sub-${id}`, (_tui: any, theme: any) => {
                const container = new Container();
                const borderFn = (s: string) => theme.fg("dim", s);
                container.addChild(new Text("", 0, 0));
                container.addChild(new DynamicBorder(borderFn));
                const content = new Text("", 1, 0);
                container.addChild(content);
                container.addChild(new DynamicBorder(borderFn));

                return {
                    render(width: number): string[] {
                        const lines: string[] = [];
                        const sc = state.status === "running" ? "accent" : state.status === "done" ? "success" : "error";
                        const si = state.status === "running" ? "●" : state.status === "done" ? "✓" : "✗";
                        const taskPreview = state.task.length > 40 ? state.task.slice(0, 37) + "..." : state.task;
                        const turnLabel = state.turnCount > 1 ? theme.fg("dim", ` · Turn ${state.turnCount}`) : "";

                        lines.push(
                            theme.fg(sc, `${si} Subagent #${state.id}`) + turnLabel +
                            theme.fg("dim", `  ${taskPreview}`) +
                            theme.fg("dim", `  (${Math.round(state.elapsed / 1000)}s)`) +
                            theme.fg("dim", ` | Tools: ${state.toolCount}`)
                        );

                        const lastLine = state.textChunks.join("").split("\n").filter((l: string) => l.trim()).pop() || "";
                        if (lastLine) {
                            const trimmed = lastLine.length > width - 10 ? lastLine.slice(0, width - 13) + "..." : lastLine;
                            lines.push(theme.fg("muted", `  ${trimmed}`));
                        }

                        content.setText(lines.join("\n"));
                        return container.render(width);
                    },
                    invalidate() { container.invalidate(); },
                };
            });
        }
    }

    // ── Team widget ───────────────────────────────────────────────────────────

    function renderTeamCard(state: AgentState, colWidth: number, theme: any): string[] {
        const w = colWidth - 2;
        const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

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

        const filled = Math.ceil(state.contextPct / 20);
        const barStr = `[${("#").repeat(filled)}${("-").repeat(5 - filled)}] ${Math.ceil(state.contextPct)}%`;
        const ctxLine = theme.fg("dim", barStr);

        // Idle: show description. Running/done: show last work output
        const workRaw = (state.task && state.lastWork) ? state.lastWork
            : state.task ? state.task
            : state.def.description;
        const workText = trunc(workRaw, Math.min(50, w - 1));
        const workLine = theme.fg("muted", workText);

        const top = "┌" + "─".repeat(w) + "┐";
        const bot = "└" + "─".repeat(w) + "┘";
        const bdr = (content: string, visLen: number) =>
            theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

        return [
            theme.fg("dim", top),
            bdr(" " + nameStr, 1 + nameVis),
            bdr(" " + statusLine, 1 + statusVis),
            bdr(" " + ctxLine, 1 + barStr.length),
            bdr(" " + workLine, 1 + workText.length),
            theme.fg("dim", bot),
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
                    const cols = Math.min(gridCols, agentStates.size);
                    const colWidth = Math.floor((width - (cols - 1)) / cols);
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
        const w = colWidth - 2;
        const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

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

        // Pending: show agent description. Running/done: show last work output
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

    // ── Footer ────────────────────────────────────────────────────────────────

    function updateFooter(ctx: any) {
        if (!ctx) return;
        ctx.ui.setFooter((_tui: any, theme: any) => ({
            dispose: () => {},
            invalidate() {},
            render(width: number): string[] {
                const model = ctx.model?.id || "no-model";
                const usage = ctx.getContextUsage?.();
                const pct = usage?.percent ?? 0;
                const filled = Math.round(pct / 10);
                const bar = "#".repeat(filled) + "-".repeat(10 - filled);

                let modeLabel: string;
                if (mode === "team")        modeLabel = theme.fg("accent", `team:${activeTeamName || "no-team"}`);
                else if (mode === "chain")  modeLabel = theme.fg("accent", `chain:${activeChain?.name || "no-chain"}`);
                else                        modeLabel = theme.fg("accent", "subagent");

                const left = theme.fg("dim", ` ${model}`) + theme.fg("muted", " · ") + modeLabel;
                const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
                const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
                return [truncateToWidth(left + pad + right, width)];
            },
        }));
    }

    // ── Data loaders ──────────────────────────────────────────────────────────

    function loadTeamData(cwd: string) {
        teamSessionDir = path.join(cwd, ".pi", "agent-sessions", "team");
        if (!fs.existsSync(teamSessionDir)) fs.mkdirSync(teamSessionDir, { recursive: true });

        allAgentDefs = scanAgentDirs(cwd);

        // Global teams merged with project teams (project overrides global)
        teams = {};
        for (const tp of [
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

        // Global chains merged with project chains (project overrides global by name)
        chains = [];
        for (const cp of [
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

    // ── Subagent spawner ──────────────────────────────────────────────────────

    function spawnSubagent(state: SubState, prompt: string, ctx: any, notifyMain = true): Promise<void> {
        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : DEFAULT_MODEL;

        return new Promise<void>((resolve) => {
            const proc = spawn(getPiCommand(), [
                "--mode", "json", "-p",
                "--session", state.sessionFile,
                "--no-extensions",
                "--model", model,
                "--tools", "read,bash,grep,find,ls",
                "--thinking", "off",
                prompt,
            ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });

            state.proc = proc;
            const startTime = Date.now();
            const timer = setInterval(() => { state.elapsed = Date.now() - startTime; updateSubWidgets(); }, 1000);
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
                            state.textChunks.push(ev.assistantMessageEvent.delta || "");
                            updateSubWidgets();
                        } else if (ev.type === "tool_execution_start") {
                            state.toolCount++;
                            updateSubWidgets();
                        }
                    } catch {}
                }
            });

            proc.stderr!.setEncoding("utf-8");
            proc.stderr!.on("data", (chunk: string) => {
                if (chunk.trim()) { state.textChunks.push(chunk); updateSubWidgets(); }
            });

            proc.on("close", (code) => {
                if (buffer.trim()) {
                    try {
                        const ev = JSON.parse(buffer);
                        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta")
                            state.textChunks.push(ev.assistantMessageEvent.delta || "");
                    } catch {}
                }

                clearInterval(timer);
                state.elapsed = Date.now() - startTime;
                state.status = code === 0 ? "done" : "error";
                state.proc = undefined;
                updateSubWidgets();

                ctx.ui.notify(
                    `Subagent #${state.id} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
                    state.status === "done" ? "success" : "error"
                );

                if (notifyMain) {
                    const result = state.textChunks.join("");
                    pi.sendMessage({
                        customType: "subagent-result",
                        content: `Subagent #${state.id}${state.turnCount > 1 ? ` (Turn ${state.turnCount})` : ""} finished "${prompt}" in ${Math.round(state.elapsed / 1000)}s.\n\nResult:\n${result.slice(0, 8000)}${result.length > 8000 ? "\n\n... [truncated]" : ""}`,
                        display: true,
                    }, { deliverAs: "followUp", triggerTurn: true });
                }

                resolve();
            });

            proc.on("error", (err) => {
                clearInterval(timer);
                state.status = "error";
                state.proc = undefined;
                state.textChunks.push(`Error: ${err.message}`);
                updateSubWidgets();
                resolve();
            });
        });
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

        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : DEFAULT_MODEL;
        const agentKey = state.def.name.toLowerCase().replace(/\s+/g, "-");
        const sessionFile = path.join(teamSessionDir, `${agentKey}.json`);

        const args = [
            "--mode", "json", "-p", "--no-extensions",
            "--model", model,
            "--tools", state.def.tools,
            "--thinking", "off",
            "--append-system-prompt", state.def.systemPrompt,
            "--session", sessionFile,
        ];
        if (state.sessionFile) args.push("-c");
        args.push(task);

        const textChunks: string[] = [];
        return new Promise((resolve) => {
            const proc = spawn(getPiCommand(), args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
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

            proc.on("close", (code) => {
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
                ctx.ui.notify(`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`, state.status === "done" ? "success" : "error");
                resolve({ output: full, exitCode: code ?? 1, elapsed: state.elapsed });
            });

            proc.on("error", (err) => {
                clearInterval(state.timer);
                state.status = "error"; state.lastWork = `Error: ${err.message}`; updateTeamWidget();
                resolve({ output: `Error spawning agent: ${err.message}`, exitCode: 1, elapsed: Date.now() - startTime });
            });
        });
    }

    // ── Chain step runner ─────────────────────────────────────────────────────

    function runChainAgent(agentDef: AgentDef, task: string, stepIndex: number, ctx: any): Promise<{ output: string; exitCode: number; elapsed: number }> {
        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : DEFAULT_MODEL;
        const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
        const sessionFile = path.join(chainSessionDir, `chain-${agentKey}.json`);
        const hasSession = agentSessions.get(agentKey);

        const args = [
            "--mode", "json", "-p", "--no-extensions",
            "--model", model,
            "--tools", agentDef.tools,
            "--thinking", "off",
            "--append-system-prompt", agentDef.systemPrompt,
            "--session", sessionFile,
        ];
        if (hasSession) args.push("-c");
        args.push(task);

        const textChunks: string[] = [];
        const startTime = Date.now();
        const state = stepStates[stepIndex];

        return new Promise((resolve) => {
            const proc = spawn(getPiCommand(), args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
            const timer = setInterval(() => { state.elapsed = Date.now() - startTime; updateChainWidget(); }, 1000);
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

            proc.on("close", (code) => {
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

            proc.on("error", (err) => {
                clearInterval(timer);
                resolve({ output: `Error: ${err.message}`, exitCode: 1, elapsed: Date.now() - startTime });
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

    function applyMode(ctx: any) {
        if (mode === "team") {
            updateTeamWidget();
            ctx.ui.setStatus("orchestrator", `Mode: team · ${activeTeamName} (${agentStates.size})`);
        } else if (mode === "chain") {
            updateChainWidget();
            ctx.ui.setStatus("orchestrator", `Mode: chain · ${activeChain?.name || "no chain"}`);
        } else {
            updateSubWidgets();
            ctx.ui.setStatus("orchestrator", `Mode: subagent (${agents.size} active)`);
        }
        updateFooter(ctx);
    }

    function switchMode(newMode: OrchestratorMode, ctx: any) {
        // Restore tools when leaving team mode
        if (mode === "team" && newMode !== "team") {
            pi.setActiveTools(savedTools.length ? savedTools : pi.getActiveTools());
        }

        mode = newMode;

        // Lock tools when entering team mode
        if (mode === "team") {
            savedTools = pi.getActiveTools();
            pi.setActiveTools(["dispatch_agent"]);
        }

        savePrefs(currentPrefs());
        applyMode(ctx);
    }

    // ── Tool registrations ────────────────────────────────────────────────────

    pi.registerTool({
        name: "subagent_create",
        description: "Spawn a background subagent to perform a task. Returns the subagent ID immediately. Results are delivered as a follow-up message when finished (unless notifyMain is false).",
        parameters: Type.Object({
            task: Type.String({ description: "The complete task description for the subagent to perform" }),
            notifyMain: Type.Optional(Type.Boolean({ description: "Deliver result as follow-up and trigger a new LLM turn. Default: true. Set false when running multiple parallel subagents to avoid N turn triggers." })),
        }),
        execute: async (_callId, args, _signal, _onUpdate, ctx) => {
            widgetCtx = ctx;
            const id = nextId++;
            const state: SubState = {
                id, status: "running", task: args.task, textChunks: [], toolCount: 0,
                elapsed: 0, sessionFile: makeSubagentSessionFile(id), turnCount: 1,
            };
            agents.set(id, state);
            updateSubWidgets();
            spawnSubagent(state, args.task, ctx, args.notifyMain !== false);
            return { content: [{ type: "text", text: `Subagent #${id} spawned.${args.notifyMain === false ? " Results will be shown in widget only." : ""}` }] };
        },
    });

    pi.registerTool({
        name: "subagent_continue",
        description: "Continue an existing subagent's conversation with follow-up instructions. The subagent must be finished.",
        parameters: Type.Object({
            id: Type.Number({ description: "The ID of the subagent to continue" }),
            prompt: Type.String({ description: "The follow-up prompt or new instructions" }),
            notifyMain: Type.Optional(Type.Boolean({ description: "Deliver result as follow-up and trigger a new LLM turn. Default: true." })),
        }),
        execute: async (_callId, args, _signal, _onUpdate, ctx) => {
            widgetCtx = ctx;
            const state = agents.get(args.id);
            if (!state) return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
            if (state.status === "running") return { content: [{ type: "text", text: `Error: Subagent #${args.id} is still running.` }] };

            state.status = "running"; state.task = args.prompt;
            state.textChunks = []; state.elapsed = 0; state.turnCount++;
            updateSubWidgets();
            ctx.ui.notify(`Continuing Subagent #${args.id} (Turn ${state.turnCount})…`, "info");
            spawnSubagent(state, args.prompt, ctx, args.notifyMain !== false);
            return { content: [{ type: "text", text: `Subagent #${args.id} continuing (Turn ${state.turnCount}).` }] };
        },
    });

    pi.registerTool({
        name: "subagent_remove",
        description: "Remove a specific subagent and its widget. Kills it if currently running.",
        parameters: Type.Object({ id: Type.Number({ description: "The ID of the subagent to remove" }) }),
        execute: async (_callId, args, _signal, _onUpdate, ctx) => {
            widgetCtx = ctx;
            const state = agents.get(args.id);
            if (!state) return { content: [{ type: "text", text: `Error: No subagent #${args.id} found.` }] };
            if (state.proc && state.status === "running") state.proc.kill("SIGTERM");
            ctx.ui.setWidget(`sub-${args.id}`, undefined);
            agents.delete(args.id);
            return { content: [{ type: "text", text: `Subagent #${args.id} removed.` }] };
        },
    });

    pi.registerTool({
        name: "subagent_list",
        description: "List all active and finished subagents with their IDs, tasks, and status.",
        parameters: Type.Object({}),
        execute: async () => {
            if (agents.size === 0) return { content: [{ type: "text", text: "No active subagents." }] };
            const list = Array.from(agents.values())
                .map(s => `#${s.id} [${s.status.toUpperCase()}] (Turn ${s.turnCount}) - ${s.task}`).join("\n");
            return { content: [{ type: "text", text: `Subagents:\n${list}` }] };
        },
    });

    pi.registerTool({
        name: "dispatch_agent",
        label: "Dispatch Agent",
        description: "Dispatch a task to a specialist agent from the active team. The agent executes and returns results.",
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

    pi.registerCommand("mode", {
        description: "View or switch orchestration mode: /mode [subagent|team|chain]",
        getArgumentCompletions: (): AutocompleteItem[] | null => [
            { value: "subagent", label: "subagent — free-form background subagents" },
            { value: "team",     label: "team     — dispatcher with specialist agent grid" },
            { value: "chain",    label: "chain    — sequential pipeline (A → B → C)" },
        ],
        handler: async (args, ctx) => {
            widgetCtx = ctx;
            const newMode = args?.trim();

            if (!newMode) {
                const subInfo = `  ${agents.size} active subagent(s)`;
                const teamInfo = `  ${activeTeamName ? `Active: ${activeTeamName} (${agentStates.size} agents)` : `${Object.keys(teams).length} teams loaded`}`;
                const chainInfo = `  ${activeChain ? `Active: ${activeChain.name} (${activeChain.steps.length} steps)` : `${chains.length} chains loaded`}`;
                ctx.ui.notify(
                    `Current mode: ${mode}\n\n` +
                    `subagent${mode === "subagent" ? " ◀" : ""}\n${subInfo}\n\n` +
                    `team${mode === "team" ? " ◀" : ""}\n${teamInfo}\n\n` +
                    `chain${mode === "chain" ? " ◀" : ""}\n${chainInfo}`,
                    "info"
                );
                return;
            }

            if (!["subagent", "team", "chain"].includes(newMode)) {
                ctx.ui.notify("Invalid mode. Use: subagent, team, or chain", "error"); return;
            }
            if (newMode === mode) { ctx.ui.notify(`Already in ${mode} mode`, "info"); return; }

            switchMode(newMode as OrchestratorMode, ctx);
            ctx.ui.notify(`Switched to ${mode} mode`, "success");
        },
    });

    // — Subagent commands —

    pi.registerCommand("sub", {
        description: "Spawn a background subagent: /sub <task>",
        handler: async (args, ctx) => {
            widgetCtx = ctx;
            const task = args?.trim();
            if (!task) { ctx.ui.notify("Usage: /sub <task>", "error"); return; }

            const id = nextId++;
            const state: SubState = {
                id, status: "running", task, textChunks: [], toolCount: 0,
                elapsed: 0, sessionFile: makeSubagentSessionFile(id), turnCount: 1,
            };
            agents.set(id, state);
            updateSubWidgets();
            spawnSubagent(state, task, ctx);
        },
    });

    pi.registerCommand("subcont", {
        description: "Continue a subagent's conversation: /subcont <id> <prompt>",
        handler: async (args, ctx) => {
            widgetCtx = ctx;
            const trimmed = args?.trim() ?? "";
            const spaceIdx = trimmed.indexOf(" ");
            if (spaceIdx === -1) { ctx.ui.notify("Usage: /subcont <id> <prompt>", "error"); return; }

            const num = parseInt(trimmed.slice(0, spaceIdx), 10);
            const prompt = trimmed.slice(spaceIdx + 1).trim();
            if (isNaN(num) || !prompt) { ctx.ui.notify("Usage: /subcont <id> <prompt>", "error"); return; }

            const state = agents.get(num);
            if (!state) { ctx.ui.notify(`No subagent #${num} found.`, "error"); return; }
            if (state.status === "running") { ctx.ui.notify(`Subagent #${num} is still running.`, "warning"); return; }

            state.status = "running"; state.task = prompt;
            state.textChunks = []; state.elapsed = 0; state.turnCount++;
            updateSubWidgets();
            ctx.ui.notify(`Continuing Subagent #${num} (Turn ${state.turnCount})…`, "info");
            spawnSubagent(state, prompt, ctx);
        },
    });

    pi.registerCommand("subrm", {
        description: "Remove a subagent widget: /subrm <id>",
        handler: async (args, ctx) => {
            widgetCtx = ctx;
            const num = parseInt(args?.trim() ?? "", 10);
            if (isNaN(num)) { ctx.ui.notify("Usage: /subrm <id>", "error"); return; }

            const state = agents.get(num);
            if (!state) { ctx.ui.notify(`No subagent #${num} found.`, "error"); return; }
            if (state.proc && state.status === "running") {
                state.proc.kill("SIGTERM");
                ctx.ui.notify(`Subagent #${num} killed and removed.`, "warning");
            } else {
                ctx.ui.notify(`Subagent #${num} removed.`, "info");
            }
            ctx.ui.setWidget(`sub-${num}`, undefined);
            agents.delete(num);
        },
    });

    pi.registerCommand("subclear", {
        description: "Clear all subagent widgets",
        handler: async (_args, ctx) => {
            widgetCtx = ctx;
            let killed = 0;
            for (const [id, state] of Array.from(agents.entries())) {
                if (state.proc && state.status === "running") { state.proc.kill("SIGTERM"); killed++; }
                ctx.ui.setWidget(`sub-${id}`, undefined);
            }
            const total = agents.size;
            agents.clear(); nextId = 1;
            ctx.ui.notify(
                total === 0 ? "No subagents to clear."
                    : `Cleared ${total} subagent${total !== 1 ? "s" : ""}${killed > 0 ? ` (${killed} killed)` : ""}.`,
                total === 0 ? "info" : "success"
            );
        },
    });

    pi.registerCommand("sublist", {
        description: "List all subagents and their status",
        handler: async (_args, ctx) => {
            widgetCtx = ctx;
            if (agents.size === 0) { ctx.ui.notify("No active subagents.", "info"); return; }
            const list = Array.from(agents.values())
                .map(s => `#${s.id} [${s.status.toUpperCase()}]${s.turnCount > 1 ? ` Turn ${s.turnCount}` : ""} — ${s.task}`)
                .join("\n");
            ctx.ui.notify(`Subagents:\n${list}`, "info");
        },
    });

    // — Team commands —

    pi.registerCommand("agents-team", {
        description: "Select a team to work with",
        handler: async (_args, ctx) => {
            widgetCtx = ctx;
            const teamNames = Object.keys(teams);
            if (teamNames.length === 0) { ctx.ui.notify("No teams defined. Add teams.yaml to ~/.pi/agent/agents/ or .pi/agents/", "warning"); return; }

            const options = teamNames.map(name => `${name} — ${(teams[name] || []).map(m => displayName(m)).join(", ")}`);
            const choice = await ctx.ui.select("Select Team", options);
            if (choice === undefined) return;

            const name = teamNames[options.indexOf(choice)];
            activateTeam(name);
            updateTeamWidget();
            savePrefs(currentPrefs());
            ctx.ui.setStatus("orchestrator", `Mode: team · ${name} (${agentStates.size})`);
            ctx.ui.notify(`Team: ${name} — ${Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ")}`, "info");
            updateFooter(ctx);
        },
    });

    pi.registerCommand("agents-list", {
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
        description: "Switch active chain",
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
            savePrefs(currentPrefs());
            ctx.ui.setStatus("orchestrator", `Mode: chain · ${chain.name} (${chain.steps.length} steps)`);
            ctx.ui.notify(`Chain: ${chain.name}\n${chain.description}\n${chain.steps.map(s => displayName(s.agent)).join(" → ")}`, "info");
            updateFooter(ctx);
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

    // ── before_agent_start ────────────────────────────────────────────────────

    pi.on("before_agent_start", async (_event, ctx) => {
        // Chain mode: reset step states on first turn of a new session
        if (pendingReset && activeChain && mode === "chain") {
            pendingReset = false;
            widgetCtx = ctx;
            stepStates = activeChain.steps.map(s => ({ agent: s.agent, status: "pending" as const, elapsed: 0, lastWork: "" }));
            updateChainWidget();
        }

        if (mode === "team") {
            const catalog = Array.from(agentStates.values())
                .map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}`)
                .join("\n\n");
            const members = Array.from(agentStates.values()).map(s => displayName(s.def.name)).join(", ");

            return {
                systemPrompt: `You are a dispatcher agent. You coordinate specialist agents to accomplish tasks.
You do NOT have direct access to the codebase. You MUST delegate all work through agents using the dispatch_agent tool.

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
- NEVER read, write, or execute code directly — you have no such tools
- ALWAYS use dispatch_agent to get work done
- You can chain agents: scout/planner first, then builder/coder
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
                    return `### ${displayName(def.name)}\n${def.description}\n**Tools:** ${def.tools}\n\n${def.systemPrompt}`;
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

        // Kill running subagents, clear all widgets
        for (const [id, state] of Array.from(agents.entries())) {
            if (state.proc && state.status === "running") state.proc.kill("SIGTERM");
            ctx.ui.setWidget(`sub-${id}`, undefined);
        }
        agents.clear(); nextId = 1;
        ctx.ui.setWidget("agent-team", undefined);
        ctx.ui.setWidget("agent-chain", undefined);

        const cwd = (ctx as any).cwd;

        // Wipe session files (each in their own subdir now)
        for (const subdir of ["team", "chain"]) {
            const dir = path.join(cwd, ".pi", "agent-sessions", subdir);
            if (fs.existsSync(dir)) {
                for (const f of fs.readdirSync(dir)) {
                    if (f.endsWith(".json")) try { fs.unlinkSync(path.join(dir, f)); } catch {}
                }
            }
        }

        // Load all data
        loadTeamData(cwd);
        loadChainData(cwd);

        // Restore saved preferences
        const prefs = loadPrefs();
        mode = prefs.mode;

        // Activate team (saved or first available)
        const teamToActivate = (prefs.activeTeam && teams[prefs.activeTeam]) ? prefs.activeTeam : Object.keys(teams)[0];
        if (teamToActivate) activateTeam(teamToActivate);

        // Activate chain (saved or first available)
        pendingReset = true;
        const chainToActivate = prefs.activeChain
            ? chains.find(c => c.name === prefs.activeChain)
            : chains[0];
        if (chainToActivate) activateChain(chainToActivate);

        // Apply tool lock if restoring team mode
        if (mode === "team") {
            savedTools = pi.getActiveTools();
            pi.setActiveTools(["dispatch_agent"]);
        }

        const teamSummary = Object.keys(teams).length > 0
            ? `${Object.keys(teams).length} teams · ${activeTeamName || Object.keys(teams)[0] || "none"} active`
            : "no teams";
        const chainSummary = chains.length > 0
            ? `${chains.length} chains · ${activeChain?.name || "none"} active`
            : "no chains";

        ctx.ui.notify(
            `Agent Orchestrator · mode: ${mode}\n\n` +
            `/mode [subagent|team|chain]\n\n` +
            `subagent: /sub  /subcont  /subrm  /subclear  /sublist\n` +
            `team (${teamSummary}): /agents-team  /agents-list  /agents-grid\n` +
            `chain (${chainSummary}): /chain  /chain-list`,
            "info"
        );

        applyMode(ctx);
    });
}
