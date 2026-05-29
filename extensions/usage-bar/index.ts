import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface RateWindow {
  label: string;
  usedPercent: number;
  resetDescription?: string;
}

interface ProviderStatus {
  indicator: "none" | "minor" | "major" | "critical" | "maintenance" | "unknown";
  description?: string;
}

interface UsageSnapshot {
  provider: string;
  displayName: string;
  windows: RateWindow[];
  plan?: string;
  error?: string;
  status?: ProviderStatus;
}

type AuthJson = Record<string, any>;

const STATUS_URLS: Record<string, string> = {
  anthropic: "https://status.anthropic.com/api/v2/status.json",
  codex: "https://status.openai.com/api/v2/status.json",
  copilot: "https://www.githubstatus.com/api/v2/status.json",
};

function readJson(file: string): any | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function readPiAuth(): AuthJson {
  return readJson(path.join(os.homedir(), ".pi", "agent", "auth.json")) ?? {};
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))]);
}

function formatReset(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ${hours % 24}h`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function statusEmoji(status?: ProviderStatus) {
  switch (status?.indicator) {
    case "none": return "✅";
    case "minor": return "⚠️";
    case "major": return "🟠";
    case "critical": return "🔴";
    case "maintenance": return "🔧";
    default: return "";
  }
}

async function fetchProviderStatus(provider: string): Promise<ProviderStatus> {
  const url = STATUS_URLS[provider];
  if (!url) return { indicator: "none" };
  try {
    const res = await fetchWithTimeout(url, {}, 3000);
    if (!res.ok) return { indicator: "unknown" };
    const data = await res.json() as any;
    return {
      indicator: (data.status?.indicator ?? "none") as ProviderStatus["indicator"],
      description: data.status?.description,
    };
  } catch {
    return { indicator: "unknown" };
  }
}

async function fetchGeminiStatus(): Promise<ProviderStatus> {
  try {
    const res = await fetchWithTimeout("https://www.google.com/appsstatus/dashboard/incidents.json", {}, 3000);
    if (!res.ok) return { indicator: "unknown" };
    const incidents = await res.json() as any[];
    const productId = "npdyhgECDJ6tB66MxXyo";
    const active = incidents.filter((incident) => {
      if (incident.end) return false;
      const affected = incident.currently_affected_products ?? incident.affected_products ?? [];
      return affected.some((product: any) => product.id === productId);
    });
    if (active.length === 0) return { indicator: "none" };
    const critical = active.find((incident) => (incident.most_recent_update?.status ?? incident.status_impact) === "SERVICE_OUTAGE");
    return {
      indicator: critical ? "critical" : "major",
      description: (critical ?? active[0])?.external_desc,
    };
  } catch {
    return { indicator: "unknown" };
  }
}

async function fetchClaudeUsage(): Promise<UsageSnapshot> {
  const token = readPiAuth().anthropic?.access;
  if (!token) return { provider: "anthropic", displayName: "Claude", windows: [], error: "No credentials" };
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!res.ok) return { provider: "anthropic", displayName: "Claude", windows: [], error: `HTTP ${res.status}` };
    const data = await res.json() as any;
    const windows: RateWindow[] = [];
    for (const [key, label] of [["five_hour", "5h"], ["seven_day", "Week"], ["seven_day_sonnet", "Sonnet"], ["seven_day_opus", "Opus"]]) {
      const bucket = data[key];
      if (bucket?.utilization !== undefined) {
        windows.push({ label, usedPercent: bucket.utilization, resetDescription: bucket.resets_at ? formatReset(new Date(bucket.resets_at)) : undefined });
      }
    }
    return { provider: "anthropic", displayName: "Claude", windows };
  } catch (error) {
    return { provider: "anthropic", displayName: "Claude", windows: [], error: String(error) };
  }
}

async function fetchCopilotUsage(): Promise<UsageSnapshot> {
  const token = readPiAuth()["github-copilot"]?.refresh;
  if (!token) return { provider: "copilot", displayName: "Copilot", windows: [], error: "No token" };
  try {
    const res = await fetchWithTimeout("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    });
    if (!res.ok) return { provider: "copilot", displayName: "Copilot", windows: [], error: `HTTP ${res.status}` };
    const data = await res.json() as any;
    const windows: RateWindow[] = [];
    const reset = data.quota_reset_date_utc ? formatReset(new Date(data.quota_reset_date_utc)) : undefined;
    const premium = data.quota_snapshots?.premium_interactions;
    if (premium) {
      const remaining = premium.remaining ?? 0;
      const entitlement = premium.entitlement ?? 0;
      windows.push({
        label: "Premium",
        usedPercent: Math.max(0, 100 - (premium.percent_remaining ?? 0)),
        resetDescription: `${reset ? `${reset} ` : ""}(${remaining}/${entitlement})`,
      });
    }
    const chat = data.quota_snapshots?.chat;
    if (chat && !chat.unlimited) windows.push({ label: "Chat", usedPercent: Math.max(0, 100 - (chat.percent_remaining ?? 0)), resetDescription: reset });
    return { provider: "copilot", displayName: "Copilot", windows, plan: data.copilot_plan };
  } catch (error) {
    return { provider: "copilot", displayName: "Copilot", windows: [], error: String(error) };
  }
}

async function fetchGeminiUsage(): Promise<UsageSnapshot> {
  let token = readPiAuth()["google-gemini-cli"]?.access;
  if (!token) token = readJson(path.join(os.homedir(), ".gemini", "oauth_creds.json"))?.access_token;
  if (!token) return { provider: "gemini", displayName: "Gemini", windows: [], error: "No credentials" };
  try {
    const res = await fetchWithTimeout("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return { provider: "gemini", displayName: "Gemini", windows: [], error: `HTTP ${res.status}` };
    const data = await res.json() as any;
    const minRemaining: Record<string, number> = {};
    for (const bucket of data.buckets ?? []) {
      const model = String(bucket.modelId ?? "unknown").toLowerCase();
      const key = model.includes("pro") ? "Pro" : model.includes("flash") ? "Flash" : undefined;
      if (!key) continue;
      minRemaining[key] = Math.min(minRemaining[key] ?? 1, bucket.remainingFraction ?? 1);
    }
    const windows = Object.entries(minRemaining).map(([label, remaining]) => ({ label, usedPercent: (1 - remaining) * 100 }));
    return { provider: "gemini", displayName: "Gemini", windows };
  } catch (error) {
    return { provider: "gemini", displayName: "Gemini", windows: [], error: String(error) };
  }
}

async function fetchCodexUsage(modelRegistry: any): Promise<UsageSnapshot> {
  let accessToken: string | undefined;
  let accountId: string | undefined;
  try {
    accessToken = await Promise.resolve(modelRegistry?.authStorage?.getApiKey?.("openai-codex"));
    const cred = await Promise.resolve(modelRegistry?.authStorage?.get?.("openai-codex"));
    accountId = cred?.accountId;
  } catch {}
  if (!accessToken) {
    const auth = readJson(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "auth.json"));
    accessToken = auth?.OPENAI_API_KEY ?? auth?.tokens?.access_token;
    accountId = auth?.tokens?.account_id;
  }
  if (!accessToken) return { provider: "codex", displayName: "Codex", windows: [], error: "No credentials" };
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, "User-Agent": "PiUsageBar", Accept: "application/json" };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const res = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", { headers });
    if (res.status === 401 || res.status === 403) return { provider: "codex", displayName: "Codex", windows: [], error: "Token expired" };
    if (!res.ok) return { provider: "codex", displayName: "Codex", windows: [], error: `HTTP ${res.status}` };
    const data = await res.json() as any;
    const windows: RateWindow[] = [];
    for (const [key, fallback, name] of [["primary_window", 10800, ""], ["secondary_window", 86400, "Day"]] as const) {
      const bucket = data.rate_limit?.[key];
      if (!bucket) continue;
      const hours = Math.round((bucket.limit_window_seconds ?? fallback) / 3600);
      windows.push({
        label: name || `${hours}h`,
        usedPercent: bucket.used_percent ?? 0,
        resetDescription: bucket.reset_at ? formatReset(new Date(bucket.reset_at * 1000)) : undefined,
      });
    }
    const balance = data.credits?.balance == null ? undefined : Number(data.credits.balance);
    const plan = balance === undefined || Number.isNaN(balance) ? data.plan_type : `${data.plan_type ?? "credits"} ($${balance.toFixed(2)})`;
    return { provider: "codex", displayName: "Codex", windows, plan };
  } catch (error) {
    return { provider: "codex", displayName: "Codex", windows: [], error: String(error) };
  }
}

function padVisible(text: string, width: number) {
  const length = visibleWidth(text);
  if (length >= width) return text;
  return `${text}${" ".repeat(width - length)}`;
}

class UsageBarComponent {
  private usages: UsageSnapshot[] = [];
  private loading = true;

  constructor(
    private readonly tui: { requestRender: () => void },
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly modelRegistry: any,
  ) {
    void this.load();
  }

  private async load() {
    const [claude, copilot, gemini, codex, claudeStatus, copilotStatus, geminiStatus, codexStatus] = await Promise.all([
      withTimeout(fetchClaudeUsage(), 6000, { provider: "anthropic", displayName: "Claude", windows: [], error: "Timeout" }),
      withTimeout(fetchCopilotUsage(), 6000, { provider: "copilot", displayName: "Copilot", windows: [], error: "Timeout" }),
      withTimeout(fetchGeminiUsage(), 6000, { provider: "gemini", displayName: "Gemini", windows: [], error: "Timeout" }),
      withTimeout(fetchCodexUsage(this.modelRegistry), 6000, { provider: "codex", displayName: "Codex", windows: [], error: "Timeout" }),
      fetchProviderStatus("anthropic"),
      fetchProviderStatus("copilot"),
      fetchGeminiStatus(),
      fetchProviderStatus("codex"),
    ]);

    claude.status = claudeStatus;
    copilot.status = copilotStatus;
    gemini.status = geminiStatus;
    codex.status = codexStatus;

    this.usages = [claude, copilot, gemini, codex].filter((usage) => usage.windows.length > 0 || !["No credentials", "No token"].includes(usage.error ?? ""));
    this.loading = false;
    this.tui.requestRender();
  }

  handleInput(): void {
    this.done();
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const totalW = Math.max(32, Math.min(62, width - 4));
    const innerW = totalW - 4;
    const border = this.theme.fg("border", `─`.repeat(totalW - 2));
    const lines: string[] = [];
    const row = (content: string) => `${this.theme.fg("border", "│ ")}${padVisible(content, innerW)}${this.theme.fg("border", " │")}`;

    lines.push(this.theme.fg("border", `╭${"─".repeat(totalW - 2)}╮`));
    lines.push(row(this.theme.bold(this.theme.fg("accent", "AI Usage"))));
    lines.push(`${this.theme.fg("border", "├")}${border}${this.theme.fg("border", "┤")}`);

    if (this.loading) {
      lines.push(row("Loading usage and provider status..."));
    } else if (this.usages.length === 0) {
      lines.push(row(this.theme.fg("dim", "No configured provider usage found.")));
    } else {
      for (const usage of this.usages) {
        const plan = usage.plan ? this.theme.fg("dim", ` (${usage.plan})`) : "";
        const emoji = statusEmoji(usage.status);
        lines.push(row(`${this.theme.bold(usage.displayName)}${plan}${emoji ? ` ${emoji}` : ""}`));
        if (usage.status?.indicator && !["none", "unknown"].includes(usage.status.indicator) && usage.status.description) {
          lines.push(row(` ${this.theme.fg("warning", usage.status.description.slice(0, 48))}`));
        }
        if (usage.error) {
          lines.push(row(` ${this.theme.fg("dim", usage.error)}`));
        } else {
          for (const window of usage.windows) {
            const used = Math.max(0, Math.min(100, window.usedPercent));
            const remaining = 100 - used;
            const barW = 14;
            const filled = Math.round((used / 100) * barW);
            const color = remaining <= 10 ? "error" : remaining <= 30 ? "warning" : "success";
            const bar = `${this.theme.fg(color as any, "█".repeat(filled))}${this.theme.fg("dim", "░".repeat(barW - filled))}`;
            const reset = window.resetDescription ? this.theme.fg("dim", ` ⏱ ${window.resetDescription}`) : "";
            lines.push(row(` ${window.label.padEnd(8)} ${bar} ${remaining.toFixed(0).padStart(3)}%${reset}`));
          }
        }
        lines.push(row(""));
      }
    }

    lines.push(`${this.theme.fg("border", "├")}${border}${this.theme.fg("border", "┤")}`);
    lines.push(row(this.theme.fg("dim", "Press any key to close")));
    lines.push(this.theme.fg("border", `╰${"─".repeat(totalW - 2)}╯`));
    return lines;
  }

  dispose(): void {}
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show AI provider usage and quota bars",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/usage requires interactive mode", "error");
        return;
      }

      await ctx.ui.custom((tui, theme, _keybindings, done) => new UsageBarComponent(tui, theme, done, ctx.modelRegistry), { overlay: true });
    },
  });
}
