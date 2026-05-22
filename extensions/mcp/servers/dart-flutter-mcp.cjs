#!/usr/bin/env node
/**
 * Dart/Flutter MCP Server
 *
 * Provides Dart and Flutter development tools via the Model Context Protocol over stdio.
 * Zero external dependencies — uses only Node.js built-ins.
 *
 * Tools provided:
 *   - dart_analyze       Run dart analyze on a file or directory
 *   - dart_format_check  Check if Dart files are correctly formatted
 *   - dart_format_fix    Fix Dart formatting
 *   - dart_fix_list      List available Dart fixes
 *   - dart_fix_apply     Apply Dart fixes
 *   - dart_test          Run Dart tests
 *   - dart_run           Run a Dart file
 *   - dart_pub_search    Search pub.dev for packages
 *   - dart_pub_outdated  Check for outdated dependencies
 *   - dart_deps          List package dependencies from pubspec.lock
 *   - flutter_analyze    Run flutter analyze
 *   - flutter_doctor     Check Flutter environment
 *   - flutter_devices    List connected Flutter devices
 *   - flutter_run        Start Flutter app in background (keeps running)
 *   - flutter_hot_reload  Hot reload running Flutter app (r key, fast)
 *   - flutter_hot_restart Hot restart running Flutter app (R key, full rebuild)
 *   - flutter_stop       Stop running Flutter app (q key)
 *   - flutter_run_status Check running Flutter app status and recent output
 *   - dart_info          Show Dart/Flutter version and environment info
 */

"use strict";

// ── JSON-RPC protocol ──────────────────────────────────────────────────────────

const STDIN = process.stdin;
const STDOUT = process.stdout;
const STDERR = process.stderr;

let buffer = "";

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  STDOUT.write(msg);
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: err }) + "\n";
  STDOUT.write(msg);
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  STDOUT.write(msg);
}

// ── Spawn helpers ──────────────────────────────────────────────────────────────

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

function runCommand(command, args, cwd, options = {}) {
  return new Promise((resolve) => {
    const timeout = options.timeout || 60000;
    const proc = spawn(command, args, {
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ code: -1, stdout, stderr: "Command timed out", error: "timeout" });
      } else {
        resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message, error: err.message });
    });
  });
}

// ── Detect working directory ───────────────────────────────────────────────────

let projectCwd = process.cwd();

function findPubspec(dir) {
  let current = dir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(current, "pubspec.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dir;
}

projectCwd = findPubspec(projectCwd);

// ── Tool: dart_analyze ────────────────────────────────────────────────────────

async function dartAnalyze(args) {
  const target = args.path || args.target || ".";
  const result = await runCommand("dart", ["analyze", target], projectCwd, { timeout: 120000 });

  if (result.error) {
    return { content: [{ type: "text", text: `Error running dart analyze: ${result.stderr}` }], isError: true };
  }

  return {
    content: [
      {
        type: "text",
        text: result.stdout || "No issues found!",
      },
    ],
    isError: result.code !== 0,
  };
}

// ── Tool: dart_format_check ────────────────────────────────────────────────────

async function dartFormatCheck(args) {
  const target = args.path || ".";
  const result = await runCommand("dart", ["format", "--set-exit-if-changed", target], projectCwd, { timeout: 60000 });

  if (result.error) {
    return { content: [{ type: "text", text: `Error running dart format: ${result.stderr}` }], isError: true };
  }

  if (result.code !== 0) {
    // Show which files need formatting
    const detail = await runCommand("dart", ["format", "--output=none", target], projectCwd, { timeout: 60000 });
    const needsFormatting = detail.stdout
      ? detail.stdout
      : "Some files need formatting.";
    return {
      content: [{ type: "text", text: `Files needing formatting:\n${needsFormatting}` }],
      isError: false,
    };
  }

  return {
    content: [{ type: "text", text: "All files are properly formatted." }],
  };
}

// ── Tool: dart_format_fix ──────────────────────────────────────────────────────

async function dartFormatFix(args) {
  const target = args.path || ".";
  const result = await runCommand("dart", ["format", target], projectCwd, { timeout: 120000 });

  if (result.error) {
    return { content: [{ type: "text", text: `Error running dart format: ${result.stderr}` }], isError: true };
  }

  return {
    content: [
      {
        type: "text",
        text: `Formatted files in ${target}:\n${result.stdout || result.stderr || "Done."}`,
      },
    ],
  };
}

// ── Tool: dart_fix_list ────────────────────────────────────────────────────────

async function dartFixList(args) {
  const target = args.path || ".";
  const result = await runCommand("dart", ["fix", "--dry-run", target], projectCwd, { timeout: 120000 });

  if (result.error) {
    return { content: [{ type: "text", text: `Error running dart fix: ${result.stderr}` }], isError: true };
  }

  return {
    content: [
      {
        type: "text",
        text: `Available fixes:\n${result.stdout || result.stderr || "No fixes available."}`,
      },
    ],
  };
}

// ── Tool: dart_fix_apply ───────────────────────────────────────────────────────

async function dartFixApply(args) {
  const target = args.path || ".";
  const result = await runCommand("dart", ["fix", "--apply", target], projectCwd, { timeout: 120000 });

  if (result.error) {
    return { content: [{ type: "text", text: `Error applying fixes: ${result.stderr}` }], isError: true };
  }

  return {
    content: [
      {
        type: "text",
        text: `Fixes applied:\n${result.stdout || result.stderr || "Done."}`,
      },
    ],
  };
}

// ── Tool: dart_test ────────────────────────────────────────────────────────────

async function dartTest(args) {
  const target = args.path || args.test_path || "test/";
  const name = args.name || "";
  const extraArgs = [];

  if (name) extraArgs.push("--name", name);
  if (args.plain_name) extraArgs.push("--plain-name", args.plain_name);
  if (args.update_goldens) extraArgs.push("--update-goldens");
  if (args.concurrency) extraArgs.push("--concurrency", String(args.concurrency));

  extraArgs.push(target);

  const result = await runCommand("dart", ["test", ...extraArgs], projectCwd, { timeout: 300000 });

  const output = result.stdout || result.stderr || "";
  const summary = output.length > 8000 ? output.slice(0, 8000) + "\n... [truncated]" : output;

  return {
    content: [{ type: "text", text: summary || "No test output." }],
    isError: result.code !== 0,
  };
}

// ── Tool: dart_run ─────────────────────────────────────────────────────────────

async function dartRun(args) {
  const file = args.file || args.script;
  if (!file) {
    return { content: [{ type: "text", text: "Error: file/script parameter is required." }], isError: true };
  }

  const extraArgs = args.args ? (Array.isArray(args.args) ? args.args : [args.args]) : [];
  const result = await runCommand("dart", ["run", file, ...extraArgs], projectCwd, { timeout: 120000 });

  return {
    content: [{ type: "text", text: result.stdout || result.stderr || "Done." }],
    isError: result.code !== 0,
  };
}

// ── Tool: dart_pub_search ──────────────────────────────────────────────────────

async function dartPubSearch(args) {
  const query = args.query || "";
  if (!query.trim()) {
    return { content: [{ type: "text", text: "Error: query parameter is required." }], isError: true };
  }

  // Use pub.dev API directly
  const https = require("https");
  const searchUrl = `https://pub.dev/api/search?q=${encodeURIComponent(query)}`;

  return new Promise((resolve) => {
    https
      .get(searchUrl, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const packages = parsed.packages || [];
            if (packages.length === 0) {
              resolve({
                content: [{ type: "text", text: `No packages found for "${query}".` }],
              });
              return;
            }
            const lines = packages.slice(0, 10).map((pkg) => {
              const desc = pkg.description || "(no description)";
              const shortDesc = desc.length > 100 ? desc.slice(0, 97) + "..." : desc;
              const url = `https://pub.dev/packages/${pkg.package}`;
              return `- **${pkg.package}** v${pkg.version || "?"}\n  ${shortDesc}\n  ${url}`;
            });
            resolve({
              content: [
                {
                  type: "text",
                  text: `Search results for "${query}" (top ${Math.min(10, packages.length)}):\n\n${lines.join("\n\n")}`,
                },
              ],
            });
          } catch {
            resolve({
              content: [{ type: "text", text: `Failed to parse pub.dev response.` }],
              isError: true,
            });
          }
        });
      })
      .on("error", (err) => {
        resolve({
          content: [{ type: "text", text: `Error searching pub.dev: ${err.message}` }],
          isError: true,
        });
      });
  });
}

// ── Tool: dart_pub_outdated ────────────────────────────────────────────────────

async function dartPubOutdated(args) {
  const result = await runCommand("dart", ["pub", "outdated"], projectCwd, { timeout: 60000 });

  if (result.error) {
    return { content: [{ type: "text", text: `Error checking outdated packages: ${result.stderr}` }], isError: true };
  }

  return {
    content: [{ type: "text", text: result.stdout || "All packages are up to date." }],
  };
}

// ── Tool: dart_deps ────────────────────────────────────────────────────────────

async function dartDeps(args) {
  const lockPath = path.join(projectCwd, "pubspec.lock");
  if (!fs.existsSync(lockPath)) {
    return {
      content: [{ type: "text", text: "No pubspec.lock found. Run `dart pub get` first." }],
      isError: true,
    };
  }

  try {
    const lockContent = fs.readFileSync(lockPath, "utf-8");
    const yaml = require("./yaml-simple") || simpleYamlParse;
    const parsed = simpleYamlParse(lockContent);

    const packages = parsed.packages || {};
    const entries = Object.entries(packages);
    const max = args.max || 50;

    const lines = entries.slice(0, max).map(([name, info]) => {
      const pkg = info || {};
      const desc = pkg.description || "";
      const shortDesc = desc ? (desc.length > 60 ? desc.slice(0, 57) + "..." : desc) : "";
      return `- **${name}** v${pkg.version || "?"} ${shortDesc ? `— ${shortDesc}` : ""} (${pkg.source || "unknown"})`;
    });

    const header = `Dependencies (${entries.length} total, showing ${Math.min(max, entries.length)}):\n\n`;
    return {
      content: [{ type: "text", text: header + lines.join("\n") }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error reading pubspec.lock: ${err.message}` }],
      isError: true,
    };
  }
}

// ── Simple YAML parser (for pubspec.lock) ──────────────────────────────────────

function simpleYamlParse(content) {
  const result = {};
  const lines = content.split("\n");
  const stack = [result];
  let currentKey = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Key: value
    const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();

      // Adjust stack based on indent
      while (stack.length > 1 && indent <= (lines[i - 1]?.search(/\S/) ?? 0)) {
        stack.pop();
      }

      const current = stack[stack.length - 1];

      if (value === "") {
        // Nested object
        current[key] = {};
        currentKey = key;
      } else if (value === "|" || value === ">") {
        // Multi-line string (skip for simplicity)
        current[key] = "";
      } else {
        current[key] = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      }
    }
  }

  return result;
}

// ── Tool: flutter_analyze ──────────────────────────────────────────────────────

async function flutterAnalyze(args) {
  const target = args.path || ".";
  const result = await runCommand("flutter", ["analyze", target], projectCwd, { timeout: 180000 });

  if (result.error) {
    return {
      content: [{ type: "text", text: `Error running flutter analyze: ${result.stderr}` }],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: result.stdout || "No issues found!",
      },
    ],
    isError: result.code !== 0,
  };
}

// ── Tool: flutter_doctor ───────────────────────────────────────────────────────

async function flutterDoctor(args) {
  const result = await runCommand("flutter", ["doctor", "-v"], projectCwd, { timeout: 120000 });

  if (result.error) {
    return { content: [{ type: "text", text: `Error running flutter doctor: ${result.stderr}` }], isError: true };
  }

  const output = result.stdout || result.stderr || "";

  return {
    content: [{ type: "text", text: output.slice(0, 8000) || "Flutter doctor completed." }],
  };
}

// ── Tool: flutter_devices ──────────────────────────────────────────────────────

async function flutterDevices(args) {
  const result = await runCommand("flutter", ["devices"], projectCwd, { timeout: 30000 });

  if (result.error) {
    return { content: [{ type: "text", text: `Error listing devices: ${result.stderr}` }], isError: true };
  }

  return {
    content: [{ type: "text", text: result.stdout || "No devices found." }],
  };
}

// ── Tool: dart_info ────────────────────────────────────────────────────────────

async function dartInfo(args) {
  const dartVersion = await runCommand("dart", ["--version"], projectCwd, { timeout: 10000 });
  const flutterVersion = await runCommand("flutter", ["--version"], projectCwd, { timeout: 10000 });

  const dartInfo = dartVersion.stdout || dartVersion.stderr || "Dart not found";
  const flutterInfo = flutterVersion.stdout || flutterVersion.stderr || "Flutter not found";

  const pubspecPath = path.join(projectCwd, "pubspec.yaml");
  let pubspecInfo = "No pubspec.yaml found";
  if (fs.existsSync(pubspecPath)) {
    try {
      const content = fs.readFileSync(pubspecPath, "utf-8");
      const parsed = simpleYamlParse(content);
      pubspecInfo = `Project: ${parsed.name || "unknown"} v${parsed.version || "0.0.0"}\nDescription: ${parsed.description || "none"}\nSDK: ${parsed.environment?.sdk || "not specified"}`;
    } catch {
      pubspecInfo = "Error reading pubspec.yaml";
    }
  }

  return {
    content: [
      {
        type: "text",
        text: `## Dart\n\`\`\`\n${dartInfo.split("\n").slice(0, 3).join("\n")}\n\`\`\`\n\n## Flutter\n\`\`\`\n${flutterInfo.split("\n").slice(0, 5).join("\n")}\n\`\`\`\n\n## Project\n${pubspecInfo}`,
      },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Flutter Run State (long-running process for hot reload/restart) ──────────
// ═══════════════════════════════════════════════════════════════════════════════

let flutterProc = null;
let flutterOutput = "";
let flutterReady = false;
const MAX_FLUTTER_OUTPUT = 20000;

function appendFlutterOutput(chunk) {
  flutterOutput += chunk.toString();
  if (flutterOutput.length > MAX_FLUTTER_OUTPUT) {
    flutterOutput = "... [output truncated]\n" + flutterOutput.slice(-MAX_FLUTTER_OUTPUT);
  }
}

function isFlutterRunning() {
  return flutterProc !== null && flutterProc.exitCode === null;
}

function sendKeyToFlutter(key) {
  if (!isFlutterRunning() || !flutterProc.stdin.writable) return false;
  flutterProc.stdin.write(key);
  return true;
}

function killFlutter() {
  if (flutterProc) {
    try { flutterProc.stdin.write("q"); } catch (_) {}
    setTimeout(() => {
      try { if (flutterProc && flutterProc.exitCode === null) flutterProc.kill(); } catch (_) {}
    }, 2000);
  }
}

// ── Tool: flutter_run ─────────────────────────────────────────────────────────

async function flutterRun(args) {
  if (isFlutterRunning()) {
    return {
      content: [{
        type: "text",
        text: "Flutter is already running. Use flutter_hot_reload, flutter_hot_restart, or flutter_stop first.\n\nRecent output:\n" + flutterOutput.slice(-3000),
      }],
    };
  }

  const device = args.device || "";
  const target = args.target || args.lib || "lib/main.dart";
  const flavor = args.flavor || "";
  const dartDefine = args.dart_define || "";

  // When CHROME_EXECUTABLE points to Helium (privacy browser), default to
  // web-server mode since Helium blocks the Chrome DevTools debugging protocol.
  const chromeExe = (process.env.CHROME_EXECUTABLE || "").toLowerCase();
  const isHelium = chromeExe.includes("helium") || chromeExe.includes("imput");
  const defaultWebMode = isHelium ? "web-server" : "";

  const webMode = args.web_mode || defaultWebMode;
  const webPort = args.web_port || "";
  const webHostname = args.web_hostname || "";
  const webBrowserFlag = args.web_browser_flag || "";
  const envVars = args.env || {};

  // Auto-select web-server device when in web-server mode
  const effectiveDevice = device || (webMode === "web-server" ? "web-server" : "");

  const cmdArgs = ["run"];
  if (effectiveDevice) cmdArgs.push("-d", effectiveDevice);
  if (target) cmdArgs.push("-t", target);
  if (flavor) cmdArgs.push("--flavor", flavor);
  if (webMode) cmdArgs.push(`--web-mode=${webMode}`);
  if (webPort) cmdArgs.push(`--web-port=${webPort}`);
  if (webHostname) cmdArgs.push(`--web-hostname=${webHostname}`);
  if (webBrowserFlag) cmdArgs.push(`--web-browser-flag=${webBrowserFlag}`);
  if (dartDefine) {
    const defines = Array.isArray(dartDefine) ? dartDefine : [dartDefine];
    for (const d of defines) cmdArgs.push("--dart-define", String(d));
  }

  const spawnEnv = { ...process.env, ...envVars };

  flutterOutput = "";
  flutterReady = false;

  const proc = spawn("flutter", cmdArgs, {
    cwd: projectCwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: spawnEnv,
  });

  flutterProc = proc;

  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (chunk) => {
    appendFlutterOutput(chunk);
    if (!flutterReady && (
      chunk.includes("Flutter run key commands") ||
      chunk.includes("To hot reload") ||
      chunk.includes("Syncing files to device") ||
      chunk.includes("flutter: ")
    )) {
      flutterReady = true;
    }
  });

  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (chunk) => appendFlutterOutput(chunk));

  return new Promise((resolve) => {
    proc.on("error", (err) => {
      flutterProc = null;
      flutterReady = false;
      resolve({
        content: [{ type: "text", text: `Failed to start Flutter: ${err.message}` }],
        isError: true,
      });
    });

    proc.on("exit", () => {
      flutterProc = null;
      flutterReady = false;
    });

    let resolved = false;
    const checkReady = () => {
      if (resolved) return;
      if (flutterReady || flutterOutput.length > 500) {
        resolved = true;
        resolve({
          content: [{
            type: "text",
            text: `Flutter app is starting...\n\nWhen ready, use:\n- flutter_hot_reload (r)\n- flutter_hot_restart (R)\n- flutter_stop (q)\n- flutter_run_status\n\nOutput so far:\n${flutterOutput.slice(-4000)}`,
          }],
        });
      }
    };

    const start = Date.now();
    const interval = setInterval(() => {
      if (resolved) { clearInterval(interval); return; }
      if (Date.now() - start > 15000) {
        resolved = true;
        clearInterval(interval);
        resolve({
          content: [{
            type: "text",
            text: `Flutter is building (15s+)... Use flutter_run_status to check progress, and flutter_hot_reload / flutter_hot_restart once built.\n\nOutput so far:\n${flutterOutput.slice(-4000)}`,
          }],
        });
      } else {
        checkReady();
      }
    }, 500);
  });
}

// ── Tool: flutter_hot_reload ───────────────────────────────────────────────────

function flutterHotReload(args) {
  if (!isFlutterRunning()) {
    return {
      content: [{ type: "text", text: "No Flutter app is running. Start one with flutter_run first." }],
      isError: true,
    };
  }

  const beforeLen = flutterOutput.length;
  if (!sendKeyToFlutter("r")) {
    return { content: [{ type: "text", text: "Failed to send hot reload command." }], isError: true };
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      const newOut = flutterOutput.slice(beforeLen).trim() || "Hot reload triggered.";
      resolve({ content: [{ type: "text", text: `Hot reload sent. Response:\n${newOut.slice(-3000)}` }] });
    }, 1500);
  });
}

// ── Tool: flutter_hot_restart ──────────────────────────────────────────────────

function flutterHotRestart(args) {
  if (!isFlutterRunning()) {
    return {
      content: [{ type: "text", text: "No Flutter app is running. Start one with flutter_run first." }],
      isError: true,
    };
  }

  const beforeLen = flutterOutput.length;
  if (!sendKeyToFlutter("R")) {
    return { content: [{ type: "text", text: "Failed to send hot restart command." }], isError: true };
  }

  return new Promise((resolve) => {
    setTimeout(() => {
      const newOut = flutterOutput.slice(beforeLen).trim() || "Hot restart triggered.";
      resolve({ content: [{ type: "text", text: `Hot restart sent (full rebuild). Response:\n${newOut.slice(-3000)}` }] });
    }, 1500);
  });
}

// ── Tool: flutter_stop ────────────────────────────────────────────────────────

function flutterStop(args) {
  if (!isFlutterRunning()) {
    return { content: [{ type: "text", text: "No Flutter app is running." }] };
  }
  killFlutter();
  return { content: [{ type: "text", text: `Flutter app stopped.\n\nFinal output:\n${flutterOutput.slice(-3000)}` }] };
}

// ── Tool: flutter_run_status ──────────────────────────────────────────────────

function flutterRunStatus(args) {
  if (!isFlutterRunning()) {
    return {
      content: [{
        type: "text",
        text: "No Flutter app is running. Start one with flutter_run." +
          (flutterOutput ? `\n\nLast session output:\n${flutterOutput.slice(-3000)}` : ""),
      }],
    };
  }

  return {
    content: [{
      type: "text",
      text: `Flutter running: ${flutterReady ? "Ready" : "Building..."}\n\nRecent output:\n${flutterOutput.slice(-5000)}`,
    }],
  };
}

// ── Cleanup on exit ───────────────────────────────────────────────────────────

process.on("exit", () => killFlutter());
process.on("SIGTERM", () => { killFlutter(); process.exit(0); });
process.on("SIGINT", () => { killFlutter(); process.exit(0); });

// ── Tool definitions ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "dart_analyze",
    description: "Run the Dart static analyzer on a file or directory to find type errors, lint violations, and potential bugs.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path to analyze (default: current directory)" },
      },
    },
  },
  {
    name: "dart_format_check",
    description: "Check if Dart files are correctly formatted according to dartfmt rules. Reports files that need formatting without making changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path to check (default: current directory)" },
      },
    },
  },
  {
    name: "dart_format_fix",
    description: "Auto-format Dart files using dartfmt. Modifies files in place.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path to format (default: current directory)" },
      },
    },
  },
  {
    name: "dart_fix_list",
    description: "List available automated fixes for Dart code in the project (like deprecated API migrations, lint fixes, etc.). Dry-run only, no changes applied.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path to check (default: current directory)" },
      },
    },
  },
  {
    name: "dart_fix_apply",
    description: "Apply automated fixes to Dart code (deprecated API migrations, lint fixes, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path to fix (default: current directory)" },
      },
    },
  },
  {
    name: "dart_test",
    description: "Run Dart tests using `dart test`. By default runs all tests in the test/ directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Test file or directory (default: test/)" },
        name: { type: "string", description: "Run tests matching a specific name pattern" },
        plain_name: { type: "string", description: "Run tests with a specific plain-text name" },
        update_goldens: { type: "boolean", description: "Update golden/expectation files" },
        concurrency: { type: "integer", description: "Number of concurrent test suites" },
      },
    },
  },
  {
    name: "dart_run",
    description: "Run a Dart file using `dart run`.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Dart file to run" },
        args: { type: "array", items: { type: "string" }, description: "Arguments to pass to the Dart program" },
      },
      required: ["file"],
    },
  },
  {
    name: "dart_pub_search",
    description: "Search pub.dev for Dart/Flutter packages. Returns top results with descriptions and URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for pub.dev" },
      },
      required: ["query"],
    },
  },
  {
    name: "dart_pub_outdated",
    description: "Check for outdated package dependencies in the current project using `dart pub outdated`.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "dart_deps",
    description: "List all package dependencies from pubspec.lock with versions and descriptions.",
    inputSchema: {
      type: "object",
      properties: {
        max: { type: "integer", description: "Maximum number of packages to list (default: 50)" },
      },
    },
  },
  {
    name: "flutter_analyze",
    description: "Run the Flutter analyzer on a file or directory to find issues.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path to analyze (default: current directory)" },
      },
    },
  },
  {
    name: "flutter_doctor",
    description: "Run `flutter doctor -v` to check the Flutter development environment and show detailed diagnostics.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "flutter_devices",
    description: "List all connected Flutter devices (emulators, simulators, physical devices).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "dart_info",
    description: "Show Dart SDK version, Flutter SDK version, and project information from pubspec.yaml.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "flutter_run",
    description: "Start the Flutter app with `flutter run`. Launches the app on a device/emulator and keeps it running in the background. Once running, use flutter_hot_reload (r) and flutter_hot_restart (R) for instant updates. Use flutter_stop to quit. For web: set device=chrome, or use web_mode=web-server to serve without a specific browser (open manually in any browser including Helium).",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Target device ID (from flutter_devices). Uses default if omitted." },
        target: { type: "string", description: "Main entry point file (default: lib/main.dart)" },
        flavor: { type: "string", description: "Build flavor to use" },
        dart_define: { type: "array", items: { type: "string" }, description: "Dart define values (e.g., environment=staging)" },
        web_mode: { type: "string", description: "Web rendering mode: \"web-server\" to serve without launching a browser (open manually in Helium or any browser)" },
        web_port: { type: "string", description: "Port for web-server mode (default: random)" },
        web_hostname: { type: "string", description: "Hostname for web-server mode (default: localhost)" },
        web_browser_flag: { type: "string", description: "Additional Chrome/Chromium flag to pass to the browser (e.g., --remote-debugging-port=9222)" },
        env: { type: "object", description: "Extra environment variables to pass to Flutter (e.g., { CHROME_EXECUTABLE: '/path/to/helium' }). Merged with current env." },
      },
    },
  },
  {
    name: "flutter_hot_reload",
    description: "Trigger a hot reload on the running Flutter app. Injects updated source code into the running Dart VM without losing app state. Much faster than hot restart. Requires flutter_run to be active.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "flutter_hot_restart",
    description: "Trigger a hot restart on the running Flutter app. Rebuilds the entire widget tree and resets app state. Slower than hot reload but more thorough. Requires flutter_run to be active.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "flutter_stop",
    description: "Stop the running Flutter app. Sends 'q' to the flutter run process to gracefully quit.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "flutter_run_status",
    description: "Check the status of the running Flutter app and view recent console output. Shows whether the app is ready for hot reload/restart and recent log lines.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── Tool handler mapping ───────────────────────────────────────────────────────

const HANDLERS = {
  dart_analyze: dartAnalyze,
  dart_format_check: dartFormatCheck,
  dart_format_fix: dartFormatFix,
  dart_fix_list: dartFixList,
  dart_fix_apply: dartFixApply,
  dart_test: dartTest,
  dart_run: dartRun,
  dart_pub_search: dartPubSearch,
  dart_pub_outdated: dartPubOutdated,
  dart_deps: dartDeps,
  flutter_analyze: flutterAnalyze,
  flutter_doctor: flutterDoctor,
  flutter_devices: flutterDevices,
  flutter_run: flutterRun,
  flutter_hot_reload: flutterHotReload,
  flutter_hot_restart: flutterHotRestart,
  flutter_stop: flutterStop,
  flutter_run_status: flutterRunStatus,
  dart_info: dartInfo,
};

// ── Server state ───────────────────────────────────────────────────────────────

let initialized = false;
let serverName = "dart-flutter-mcp";
let serverVersion = "1.0.0";

// ── Message handler ────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  const { id, method, params } = msg;

  // Handle requests
  if (id !== undefined && method) {
    try {
      let result;

      switch (method) {
        case "initialize":
          initialized = true;
          result = {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: serverName,
              version: serverVersion,
            },
          };
          break;

        case "tools/list":
          result = { tools: TOOLS };
          break;

        case "tools/call":
          if (!params || !params.name) {
            sendError(id, -32602, "Missing tool name");
            return;
          }
          const handler = HANDLERS[params.name];
          if (!handler) {
            sendError(id, -32602, `Unknown tool: ${params.name}`);
            return;
          }
          try {
            result = await handler(params.arguments || {});
          } catch (toolErr) {
            result = {
              content: [{ type: "text", text: `Tool execution error: ${toolErr.message}` }],
              isError: true,
            };
          }
          break;

        case "ping":
          result = {};
          break;

        default:
          sendError(id, -32601, `Method not found: ${method}`);
          return;
      }

      sendResponse(id, result);
    } catch (err) {
      sendError(id, -32603, `Internal error: ${err.message}`);
    }
  }
  // Handle notifications
  else if (method && id === undefined) {
    switch (method) {
      case "notifications/initialized":
        // Client confirmed initialization
        break;
      case "notifications/cancelled":
        // Request cancellation — ignored for now
        break;
      default:
        // Unknown notification — silently ignore
        break;
    }
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────────

STDIN.setEncoding("utf-8");

STDIN.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (err) {
      // Send parse error
      const errorMsg = JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }) + "\n";
      STDOUT.write(errorMsg);
    }
  }
});

STDIN.on("end", () => {
  process.exit(0);
});

// Write server info to stderr on startup (some clients use this for debugging)
STDERR.write(`Dart/Flutter MCP Server v${serverVersion} started. CWD: ${projectCwd}\n`);
