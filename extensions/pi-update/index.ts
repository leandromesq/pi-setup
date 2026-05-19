import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const LEGACY_PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const require = createRequire(import.meta.url);
const TRANSIENT_PATTERNS = [
  /eai_again/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /network/i,
  /timeout/i,
  /temporar/i,
  /too many requests/i,
  /\b429\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
];

type InstallMethod = "vp" | "bun" | "npm" | "brew" | "native";

type CommandSpec = {
  command: string;
  args: string[];
  label: string;
};

type PackageSnapshot = {
  source: string;
  version: string;
};

function shellCommand(label: string): CommandSpec {
  if (process.platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", label], label };
  return { command: "/bin/sh", args: ["-lc", label], label };
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(command: string, pi: ExtensionAPI) {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = await pi.exec(locator, [command], { timeout: 10_000 }).catch(() => undefined);
  return result?.stdout.trim().split(/\r?\n/)[0] || undefined;
}

async function installedPackage() {
  for (const packageName of [PACKAGE_NAME, LEGACY_PACKAGE_NAME]) {
    try {
      const path = require.resolve(`${packageName}/package.json`);
      const json = JSON.parse(await readFile(path, "utf8")) as { version?: string; name?: string };
      if (json.version) return { version: json.version, path, packageName: json.name ?? packageName };
    } catch {
      // Try the next package name.
    }
  }
}

async function currentVersion(pi: ExtensionAPI) {
  const installed = await installedPackage();
  if (installed?.version) return installed.version;
  const spec = shellCommand("pi --version");
  const result = await pi.exec(spec.command, spec.args, { timeout: 10_000 });
  return result.stdout.trim() || result.stderr.trim() || "unknown";
}

async function detectInstallMethod(pi: ExtensionAPI): Promise<InstallMethod> {
  const installed = await installedPackage();
  const piPath = await resolveCommand("pi", pi);
  const realPiPath = piPath ? await realpath(piPath).catch(() => piPath) : undefined;
  const joinedPaths = [piPath, realPiPath, installed?.path].filter(Boolean).map((path) => normalize(path!).toLowerCase()).join("\n");

  if (joinedPaths.includes(normalize(".vite-plus"))) return "vp";
  if (joinedPaths.includes(normalize(".bun"))) return "bun";
  if (joinedPaths.includes("homebrew")) return "brew";
  if (joinedPaths.includes(normalize("node_modules"))) return "npm";

  if (piPath) {
    let dir = dirname(piPath);
    for (let i = 0; i < 5; i++) {
      if (await pathExists(resolve(dir, "node_modules", PACKAGE_NAME)) || await pathExists(resolve(dir, "node_modules", LEGACY_PACKAGE_NAME))) return "npm";
      dir = dirname(dir);
    }
  }

  if (await resolveCommand("vp", pi)) return "vp";
  if (await resolveCommand("bun", pi)) return "bun";
  if (await resolveCommand("npm", pi)) return "npm";
  if (await resolveCommand("brew", pi)) return "brew";
  return "native";
}

function isTransient(output: string) {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(output));
}

async function runWithRetry(pi: ExtensionAPI, spec: CommandSpec) {
  let lastOutput = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await pi.exec(spec.command, spec.args, { timeout: 300_000 });
    lastOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.code === 0) return { ok: true, output: lastOutput, attempts: attempt };
    if (attempt === 3 || !isTransient(lastOutput)) return { ok: false, output: lastOutput, attempts: attempt, code: result.code };
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  return { ok: false, output: lastOutput, attempts: 3 };
}

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function nearestPackageVersion(path: string): Promise<string> {
  let dir = stripAnsi(path);
  for (let i = 0; i < 8; i++) {
    const packageJson = join(dir, "package.json");
    if (await pathExists(packageJson)) {
      try {
        const json = JSON.parse(await readFile(packageJson, "utf8")) as { version?: string };
        return json.version || "unknown";
      } catch {
        return "unknown";
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

async function packageSnapshot(pi: ExtensionAPI): Promise<PackageSnapshot[]> {
  const spec = shellCommand("pi list");
  const result = await pi.exec(spec.command, spec.args, { timeout: 30_000 });
  const lines = result.stdout.split(/\r?\n/);
  const packages: PackageSnapshot[] = [];

  for (let i = 0; i < lines.length; i++) {
    const source = stripAnsi(lines[i]).trim();
    const installedPath = stripAnsi(lines[i + 1] ?? "").trim();
    if (!source || source.endsWith("packages:") || !installedPath) continue;
    if (!installedPath.match(/[/\\]/)) continue;
    packages.push({ source, version: await nearestPackageVersion(installedPath) });
    i++;
  }

  return packages;
}

function formatVersionChange(before: string | undefined, after: string | undefined) {
  if (!before && after) return after;
  if (before && !after) return `${before} → removed`;
  if (before === after) return after ?? "unknown";
  return `${before ?? "unknown"} → ${after ?? "unknown"}`;
}

function summarizePackages(before: PackageSnapshot[], after: PackageSnapshot[], output: string) {
  const beforeBySource = new Map(before.map((pkg) => [pkg.source, pkg.version]));
  const afterBySource = new Map(after.map((pkg) => [pkg.source, pkg.version]));
  const updatedSources = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    const match = line.match(/^Updated\s+(.+)$/i);
    if (match && match[1] !== "packages") updatedSources.add(match[1].trim());
  }

  for (const pkg of after) {
    if (beforeBySource.get(pkg.source) !== pkg.version) updatedSources.add(pkg.source);
  }

  return [...updatedSources].sort().map((source) => `- ${source}: ${formatVersionChange(beforeBySource.get(source), afterBySource.get(source))}`);
}

async function updatePi(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();

  const before = await currentVersion(pi).catch(() => "unknown");
  const packagesBefore = await packageSnapshot(pi).catch(() => []);
  const method = await detectInstallMethod(pi);
  const spec = shellCommand("pi update");

  ctx.ui.notify(`Verified Pi install method: ${method}. Running: ${spec.label}`, "info");
  const result = await runWithRetry(pi, spec);
  const after = await currentVersion(pi).catch(() => "unknown");
  const packagesAfter = await packageSnapshot(pi).catch(() => []);

  if (!result.ok) {
    ctx.ui.notify(`Pi update failed after ${result.attempts} attempt(s)${"code" in result ? ` with exit code ${result.code}` : ""}.\n\nInstall method: ${method}\nCommand: ${spec.label}\n\n${result.output || "No stdout/stderr was captured. Try running pi update in a normal terminal."}`, "error");
    return;
  }

  const piSummary = before !== after && before !== "unknown" && after !== "unknown"
    ? `Pi updated: ${before} → ${after}`
    : `Pi is up to date (${after}).`;
  const packageLines = summarizePackages(packagesBefore, packagesAfter, result.output);
  const extensionSummary = packageLines.length ? `Extensions updated:\n${packageLines.join("\n")}` : "Extensions are up to date.";
  const retrySummary = result.attempts > 1 ? `\nRetried ${result.attempts - 1} transient failure(s).` : "";
  const rawOutput = result.output ? `\n\npi update output:\n${result.output}` : "";

  ctx.ui.notify(`${piSummary}\n${extensionSummary}${retrySummary}${rawOutput}`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("update", {
    description: "Run pi update, then report Pi and extension version changes",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("update", {
    description: "Verify Pi install method, run pi update, and show Pi/extension update results",
    handler: async (_args, ctx) => {
      await updatePi(pi, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("update")) return;
    pi.sendUserMessage("/update", { deliverAs: "followUp" });
    ctx.ui.notify("Queued /update from --update", "info");
  });
}
