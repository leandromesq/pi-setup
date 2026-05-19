import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface ObsidianConfig {
  vaultPath: string;
  vaultName: string;
  templatesDir: string;
  defaultNotesDir: string;
  language: "pt-BR";
}

interface SearchResult {
  path: string;
  title: string;
  score: number;
  snippet?: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "obsidian.json");
const DEFAULT_CONFIG: ObsidianConfig = {
  vaultPath: "",
  vaultName: "",
  templatesDir: "Templates",
  defaultNotesDir: "",
  language: "pt-BR",
};

const FORMAT_INSTRUCTIONS = `Regras para notas do Obsidian:
- Escreva e formate as notas em português brasileiro.
- Preserve ao máximo as palavras originais do usuário.
- Limpe a estrutura em Markdown: espaçamento, títulos, listas e blocos.
- Não resuma, não comprima ideias e não adicione explicações não fornecidas, a menos que o usuário peça explicitamente.
- Não extraia TODOs, a menos que o usuário peça explicitamente.
- Crie headings quando houver mudança clara de tópico.
- Use listas quando o texto naturalmente tiver itens.
- Para código, comandos e saídas de terminal, use blocos cercados com linguagem quando possível.
- Para matemática, use LaTeX inline ($...$) ou em bloco ($$...$$).
- Para definições, exemplos e observações importantes, prefira callouts do Obsidian quando apropriado.`;

function loadConfig(): ObsidianConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      vaultPath: typeof parsed.vaultPath === "string" ? parsed.vaultPath : "",
      vaultName: typeof parsed.vaultName === "string" ? parsed.vaultName : "",
      templatesDir: typeof parsed.templatesDir === "string" ? parsed.templatesDir : "Templates",
      defaultNotesDir: typeof parsed.defaultNotesDir === "string" ? parsed.defaultNotesDir : "",
      language: "pt-BR",
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config: ObsidianConfig) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function assertConfigured(config: ObsidianConfig) {
  if (!config.vaultPath) throw new Error(`Obsidian vault not configured. Use /ob-config vault <path>. Config: ${CONFIG_PATH}`);
}

function slugFilename(input: string) {
  return input
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Sem título";
}

function nowParts() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fileTime = time.replace(":", "-");
  return { date, time, fileTime };
}

function vaultRelative(config: ObsidianConfig, path: string) {
  return relative(config.vaultPath, path).split(sep).join("/");
}

function resolveVaultPath(config: ObsidianConfig, relPath: string) {
  assertConfigured(config);
  const normalized = relPath.replace(/^@/, "");
  const abs = resolve(config.vaultPath, normalized);
  const vault = resolve(config.vaultPath);
  if (abs !== vault && !abs.startsWith(vault + sep)) throw new Error("Path escapes Obsidian vault");
  return abs;
}

function notePathFor(config: ObsidianConfig, title: string) {
  const { date, fileTime } = nowParts();
  const filename = `${date} ${fileTime} - ${slugFilename(title)}.md`;
  return resolveVaultPath(config, join(config.defaultNotesDir, filename));
}

function baseNote(title: string, content = "") {
  const { date, time } = nowParts();
  return `# ${title}\n\nData: ${date}  \nHora: ${time}  \n\n---\n\n## Anotações\n\n${content}`.trimEnd() + "\n";
}

function lessonNote(title: string, subject: string, professor: string, content = "") {
  const { date, time } = nowParts();
  return `# ${title}\n\nData: ${date}  \nHora: ${time}  \nMatéria: ${subject}  \nProfessor(a): ${professor}  \n\n---\n\n## Anotações\n\n${content}`.trimEnd() + "\n";
}

function applyTemplate(template: string, values: Record<string, string>) {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_all, key: string) => values[key] ?? "");
}

async function listTemplates(config: ObsidianConfig) {
  if (!config.templatesDir) return [];
  const dir = resolveVaultPath(config, config.templatesDir);
  if (!existsSync(dir)) return [];
  const files = await listMarkdownFiles(dir);
  return files.map(file => vaultRelative(config, file));
}

async function renderTemplateNote(config: ObsidianConfig, templatePath: string, values: Record<string, string>) {
  const template = await readFile(resolveVaultPath(config, templatePath), "utf8");
  return applyTemplate(template, values).trimEnd() + "\n";
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function searchNotes(config: ObsidianConfig, term: string, limit = 20): Promise<SearchResult[]> {
  assertConfigured(config);
  const terms = term.toLowerCase().split(/\s+/).filter(Boolean);
  const files = await listMarkdownFiles(config.vaultPath);
  const results: SearchResult[] = [];
  for (const file of files) {
    const rel = vaultRelative(config, file);
    const lowerRel = rel.toLowerCase();
    let text = "";
    try { text = await readFile(file, "utf8"); } catch { /* ignore */ }
    const lowerText = text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (basename(lowerRel, ".md") === t) score += 100;
      if (lowerRel.includes(t)) score += 15;
      if (lowerText.includes(t)) score += 3;
    }
    if (terms.length === 0 || score > 0) {
      const firstHit = terms.map(t => lowerText.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0];
      const snippet = firstHit === undefined ? undefined : text.slice(Math.max(0, firstHit - 60), firstHit + 160).replace(/\s+/g, " ").trim();
      results.push({ path: rel, title: basename(rel, ".md"), score, snippet });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

async function openInObsidian(pi: ExtensionAPI, config: ObsidianConfig, relPath: string) {
  const vaultName = config.vaultName || basename(config.vaultPath);
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relPath.replace(/\.md$/i, ""))}`;
  if (process.platform === "win32") await pi.exec("cmd", ["/c", "start", "", uri]);
  else if (process.platform === "darwin") await pi.exec("open", [uri]);
  else await pi.exec("xdg-open", [uri]);
  return uri;
}

async function pickSearchResult(ctx: ExtensionContext, config: ObsidianConfig, term: string) {
  const results = await searchNotes(config, term);
  if (results.length === 0) return undefined;
  if (!ctx.hasUI) return results[0];
  const labels = results.map(r => `${r.title} — ${r.path}${r.snippet ? ` — ${r.snippet.slice(0, 90)}` : ""}`);
  const picked = await ctx.ui.select("Escolha uma nota:", labels);
  if (!picked) return undefined;
  return results[labels.indexOf(picked)];
}

function renderConfig(config: ObsidianConfig) {
  return `Obsidian config (${CONFIG_PATH})\n- vaultPath: ${config.vaultPath || "(não configurado)"}\n- vaultName: ${config.vaultName || "(derivado da pasta)"}\n- templatesDir: ${config.templatesDir}\n- defaultNotesDir: ${config.defaultNotesDir || "(raiz do vault)"}\n- language: ${config.language}`;
}

function formatNoteInstruction(path: string, title: string) {
  return `${FORMAT_INSTRUCTIONS}\n\nFormate e melhore a estrutura Markdown da nota Obsidian abaixo, preservando todo o conteúdo e as palavras originais ao máximo.\n\nRegras específicas para esta tarefa:\n- Leia a nota com obsidian_read_note.\n- Reescreva a nota completa com obsidian_edit_note.\n- Não resuma, não comprima ideias, não remova conteúdo e não extraia TODOs.\n- Corrija apenas estrutura, espaçamento, headings, listas, blocos de código, LaTeX e callouts quando fizer sentido.\n- Mantenha metadados existentes como Data, Hora, Matéria e Professor(a).\n\nNota: ${path}\nTítulo: ${title}`;
}

export default function obsidianExtension(pi: ExtensionAPI) {
  let config = loadConfig();
  let capture: { path: string; title: string; mode: "raw" | "ai" } | undefined;
  let lastCapture: { path: string; title: string } | undefined;

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${FORMAT_INSTRUCTIONS}\nWhen using Obsidian tools, never delete notes unless the user explicitly asked. Use obsidian_search_notes when the user does not know the exact filename. Prefer obsidian_append_note for adding content; use obsidian_edit_note only when the user explicitly asks to replace the whole note.`,
  }));

  pi.on("input", async (event, ctx) => {
    if (!capture || event.source === "extension") return { action: "continue" as const };
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return { action: "continue" as const };
    if (capture.mode === "raw") {
      const abs = resolveVaultPath(config, capture.path);
      await withFileMutationQueue(abs, async () => {
        await appendFile(abs, `\n\n${event.text.trim()}\n`, "utf8");
      });
      ctx.ui.notify(`Capturado em: ${capture.path}`, "success");
      return { action: "handled" as const };
    }
    return {
      action: "transform" as const,
      text: `${FORMAT_INSTRUCTIONS}\n\nFormate o conteúdo bruto abaixo e acrescente na nota ativa do Obsidian usando obsidian_append_note.\nNota ativa: ${capture.path}\nTítulo: ${capture.title}\n\nConteúdo bruto:\n${event.text}`,
    };
  });

  pi.registerCommand("ob-config", {
    description: "Configure Obsidian: /ob-config, /ob-config test, /ob-config vault <path>, /ob-config name <vault>, /ob-config templates <dir>, /ob-config notes-dir <dir>",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) { ctx.ui.notify(renderConfig(config), "info"); return; }
      if (input === "test") {
        try {
          assertConfigured(config);
          const vaultOk = existsSync(config.vaultPath) && statSync(config.vaultPath).isDirectory();
          const templatesPath = config.templatesDir ? resolveVaultPath(config, config.templatesDir) : "";
          const templatesOk = !templatesPath || existsSync(templatesPath);
          ctx.ui.notify(`Teste Obsidian:\n- vault: ${vaultOk ? "ok" : "não encontrado"} (${config.vaultPath})\n- templates: ${templatesOk ? "ok" : "não encontrado"} (${config.templatesDir || "desativado"})\n- nome do vault: ${config.vaultName || basename(config.vaultPath)}`, vaultOk ? "success" : "warning");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      const match = input.match(/^(vault|name|templates|notes-dir)\s+([\s\S]+)$/i);
      if (!match) { ctx.ui.notify("Usage: /ob-config vault <path> | name <vault> | templates <dir> | notes-dir <dir> | test", "warning"); return; }
      const key = match[1].toLowerCase();
      const value = match[2].replace(/^['\"]|['\"]$/g, "").trim();
      if (key === "vault") {
        const vaultPath = resolve(value);
        if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
          ctx.ui.notify(`Vault não encontrado ou não é pasta: ${vaultPath}`, "warning");
          return;
        }
        config.vaultPath = vaultPath;
      }
      if (key === "name") config.vaultName = value;
      if (key === "templates") config.templatesDir = value;
      if (key === "notes-dir") config.defaultNotesDir = value;
      await saveConfig(config);
      ctx.ui.notify(renderConfig(config), "success");
    },
  });

  pi.registerCommand("ob-new", {
    description: "Create a general Obsidian note: /ob-new <title>",
    handler: async (args, ctx) => {
      const title = args.trim();
      if (!title) { ctx.ui.notify("Usage: /ob-new <title>", "warning"); return; }
      const path = notePathFor(config, title);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, baseNote(title), "utf8");
      const rel = vaultRelative(config, path);
      ctx.ui.notify(`Nota criada: ${rel}\nUse /ob-open ${title} para abrir ou /ob-capture-start ${title} para capturar.`, "success");
    },
  });

  pi.registerCommand("ob-lesson", {
    description: "Create a lesson note with subject and professor: /ob-lesson <title>",
    handler: async (args, ctx) => {
      const title = args.trim();
      if (!title) { ctx.ui.notify("Usage: /ob-lesson <title>", "warning"); return; }
      const subject = ctx.hasUI ? (await ctx.ui.input("Matéria:", "")) ?? "" : "";
      const professor = ctx.hasUI ? (await ctx.ui.input("Professor(a):", "")) ?? "" : "";
      const templates = ctx.hasUI ? await listTemplates(config) : [];
      const templateChoice = templates.length > 0 ? await ctx.ui.select("Template opcional:", ["(sem template)", ...templates]) : undefined;
      const path = notePathFor(config, title);
      const { date, time } = nowParts();
      const body = templateChoice && templateChoice !== "(sem template)"
        ? await renderTemplateNote(config, templateChoice, { title, date, time, subject, professor, content: "" })
        : lessonNote(title, subject, professor);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body, "utf8");
      ctx.ui.notify(`Aula criada: ${vaultRelative(config, path)}`, "success");
    },
  });

  pi.registerCommand("ob-open", {
    description: "Search/select and open an Obsidian note: /ob-open [term]",
    handler: async (args, ctx) => {
      const term = args.trim() || (ctx.hasUI ? (await ctx.ui.input("Buscar nota:", "")) ?? "" : "");
      const picked = await pickSearchResult(ctx, config, term);
      if (!picked) { ctx.ui.notify("Nenhuma nota encontrada.", "warning"); return; }
      await openInObsidian(pi, config, picked.path);
      ctx.ui.notify(`Abrindo: ${picked.path}`, "success");
    },
  });

  pi.registerCommand("ob-search", {
    description: "Search Obsidian notes by filename/content: /ob-search <term>",
    handler: async (args, ctx) => {
      const term = args.trim();
      if (!term) { ctx.ui.notify("Usage: /ob-search <term>", "warning"); return; }
      const results = await searchNotes(config, term);
      ctx.ui.notify(results.length ? results.map(r => `- ${r.path}${r.snippet ? `\n  ${r.snippet}` : ""}`).join("\n") : "Nenhuma nota encontrada.", results.length ? "info" : "warning");
    },
  });

  pi.registerCommand("ob-delete", {
    description: "Search/select and delete an Obsidian note with confirmation: /ob-delete [term]",
    handler: async (args, ctx) => {
      const term = args.trim() || (ctx.hasUI ? (await ctx.ui.input("Buscar nota para apagar:", "")) ?? "" : "");
      const picked = await pickSearchResult(ctx, config, term);
      if (!picked) { ctx.ui.notify("Nenhuma nota encontrada.", "warning"); return; }
      const ok = ctx.hasUI ? await ctx.ui.confirm("Apagar nota?", `Apagar ${picked.path}?`) : false;
      if (!ok) { ctx.ui.notify("Operação cancelada.", "info"); return; }
      await rm(resolveVaultPath(config, picked.path));
      ctx.ui.notify(`Nota apagada: ${picked.path}`, "success");
    },
  });

  pi.registerCommand("ob-capture-start", {
    description: "Start Obsidian capture mode: /ob-capture-start <title>",
    handler: async (args, ctx) => {
      const title = args.trim();
      if (!title) { ctx.ui.notify("Usage: /ob-capture-start <title>", "warning"); return; }
      const path = notePathFor(config, title);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, baseNote(title), "utf8");
      capture = { path: vaultRelative(config, path), title, mode: "raw" };
      lastCapture = { path: capture.path, title };
      ctx.ui.setStatus("obsidian-capture", `CAPTURANDO OB: ${title} · /ob-capture-stop`);
      ctx.ui.notify(`Capture mode ativo (raw): ${capture.path}\nMensagens sem / serão anexadas diretamente.`, "success");
    },
  });

  pi.registerCommand("ob-capture-ai-start", {
    description: "Start AI-formatted Obsidian capture mode into a new note: /ob-capture-ai-start <title>",
    handler: async (args, ctx) => {
      const title = args.trim();
      if (!title) { ctx.ui.notify("Usage: /ob-capture-ai-start <title>", "warning"); return; }
      const path = notePathFor(config, title);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, baseNote(title), "utf8");
      capture = { path: vaultRelative(config, path), title, mode: "ai" };
      lastCapture = { path: capture.path, title };
      ctx.ui.setStatus("obsidian-capture", `CAPTURANDO OB+AI: ${title} · /ob-capture-stop`);
      ctx.ui.notify(`Capture mode ativo (AI): ${capture.path}\nMensagens sem / serão formatadas pelo modelo e anexadas.`, "success");
    },
  });

  pi.registerCommand("ob-capture-file", {
    description: "Start raw Obsidian capture mode into an existing note: /ob-capture-file [term]",
    handler: async (args, ctx) => {
      const term = args.trim() || (ctx.hasUI ? (await ctx.ui.input("Buscar nota para capturar:", "")) ?? "" : "");
      const picked = await pickSearchResult(ctx, config, term);
      if (!picked) { ctx.ui.notify("Nenhuma nota encontrada.", "warning"); return; }
      capture = { path: picked.path, title: picked.title, mode: "raw" };
      lastCapture = { path: picked.path, title: picked.title };
      ctx.ui.setStatus("obsidian-capture", `CAPTURANDO OB: ${picked.title} · /ob-capture-stop`);
      ctx.ui.notify(`Capture mode ativo (raw): ${picked.path}\nMensagens sem / serão anexadas diretamente.`, "success");
    },
  });

  pi.registerCommand("ob-capture-ai-file", {
    description: "Start AI-formatted Obsidian capture mode into an existing note: /ob-capture-ai-file [term]",
    handler: async (args, ctx) => {
      const term = args.trim() || (ctx.hasUI ? (await ctx.ui.input("Buscar nota para capturar com AI:", "")) ?? "" : "");
      const picked = await pickSearchResult(ctx, config, term);
      if (!picked) { ctx.ui.notify("Nenhuma nota encontrada.", "warning"); return; }
      capture = { path: picked.path, title: picked.title, mode: "ai" };
      lastCapture = { path: picked.path, title: picked.title };
      ctx.ui.setStatus("obsidian-capture", `CAPTURANDO OB+AI: ${picked.title} · /ob-capture-stop`);
      ctx.ui.notify(`Capture mode ativo (AI): ${picked.path}\nMensagens sem / serão formatadas pelo modelo e anexadas.`, "success");
    },
  });

  pi.registerCommand("ob-format", {
    description: "Format/improve an existing Obsidian note while preserving content: /ob-format [term]",
    handler: async (args, ctx) => {
      const term = args.trim() || (ctx.hasUI ? (await ctx.ui.input("Buscar nota para formatar:", "")) ?? "" : "");
      const picked = await pickSearchResult(ctx, config, term);
      if (!picked) { ctx.ui.notify("Nenhuma nota encontrada.", "warning"); return; }
      pi.sendUserMessage(formatNoteInstruction(picked.path, picked.title), { deliverAs: "followUp" });
      ctx.ui.notify(`Formatação enfileirada: ${picked.path}`, "success");
    },
  });

  pi.registerCommand("ob-format-current", {
    description: "Format/improve the active or last captured Obsidian note while preserving content",
    handler: async (_args, ctx) => {
      const target = capture ?? lastCapture;
      if (!target) { ctx.ui.notify("Nenhuma nota de captura ativa ou recente. Use /ob-format [term].", "warning"); return; }
      pi.sendUserMessage(formatNoteInstruction(target.path, target.title), { deliverAs: "followUp" });
      ctx.ui.notify(`Formatação enfileirada: ${target.path}`, "success");
    },
  });

  pi.registerCommand("ob-capture-stop", {
    description: "Stop Obsidian capture mode",
    handler: async (_args, ctx) => {
      capture = undefined;
      ctx.ui.setStatus("obsidian-capture", undefined);
      ctx.ui.notify("Capture mode encerrado.", "info");
    },
  });

  const pathParam = Type.String({ description: "Vault-relative markdown note path." });

  pi.registerTool({
    name: "obsidian_create_note",
    label: "Obsidian Create Note",
    description: "Create a markdown note in the configured Obsidian vault.",
    promptSnippet: "Create Portuguese Obsidian markdown notes in the configured vault",
    promptGuidelines: ["Use obsidian_create_note when the user asks to create an Obsidian note."],
    parameters: Type.Object({ title: Type.String(), content: Type.Optional(Type.String()), kind: Type.Optional(StringEnum(["general", "lesson"] as const)), subject: Type.Optional(Type.String()), professor: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const path = notePathFor(config, params.title);
      const body = params.kind === "lesson" ? lessonNote(params.title, params.subject ?? "", params.professor ?? "", params.content ?? "") : baseNote(params.title, params.content ?? "");
      return withFileMutationQueue(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body, "utf8");
        const rel = vaultRelative(config, path);
        return { content: [{ type: "text", text: `Created Obsidian note: ${rel}` }], details: { path: rel } };
      });
    },
  });

  pi.registerTool({
    name: "obsidian_append_note",
    label: "Obsidian Append Note",
    description: "Append markdown content to an Obsidian note. Content should already follow the Portuguese formatting rules.",
    promptSnippet: "Append formatted Portuguese markdown to an Obsidian note",
    promptGuidelines: ["Use obsidian_append_note to add cleaned Portuguese markdown to an existing Obsidian note."],
    parameters: Type.Object({ path: pathParam, content: Type.String() }),
    async execute(_id, params) {
      const abs = resolveVaultPath(config, params.path);
      return withFileMutationQueue(abs, async () => {
        const current = existsSync(abs) ? await readFile(abs, "utf8") : "";
        const next = `${current.trimEnd()}\n\n${params.content.trim()}\n`;
        await writeFile(abs, next, "utf8");
        return { content: [{ type: "text", text: `Appended to Obsidian note: ${params.path}` }], details: { path: params.path } };
      });
    },
  });

  pi.registerTool({
    name: "obsidian_read_note",
    label: "Obsidian Read Note",
    description: "Read a markdown note from the configured Obsidian vault.",
    parameters: Type.Object({ path: pathParam }),
    async execute(_id, params) {
      const text = await readFile(resolveVaultPath(config, params.path), "utf8");
      return { content: [{ type: "text", text }], details: { path: params.path } };
    },
  });

  pi.registerTool({
    name: "obsidian_edit_note",
    label: "Obsidian Edit Note",
    description: "Replace the full markdown content of an Obsidian note.",
    parameters: Type.Object({ path: pathParam, content: Type.String() }),
    async execute(_id, params) {
      const abs = resolveVaultPath(config, params.path);
      return withFileMutationQueue(abs, async () => {
        await writeFile(abs, params.content, "utf8");
        return { content: [{ type: "text", text: `Updated Obsidian note: ${params.path}` }], details: { path: params.path } };
      });
    },
  });

  pi.registerTool({
    name: "obsidian_search_notes",
    label: "Obsidian Search Notes",
    description: "Search Obsidian markdown notes by filename and contents.",
    promptSnippet: "Search Obsidian notes by filename/content before opening or editing",
    promptGuidelines: ["Use obsidian_search_notes when the user does not know the exact Obsidian filename."],
    parameters: Type.Object({ term: Type.String(), limit: Type.Optional(Type.Number()) }),
    async execute(_id, params) {
      const results = await searchNotes(config, params.term, params.limit ?? 20);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }], details: { results } };
    },
  });

  pi.registerTool({
    name: "obsidian_open_note",
    label: "Obsidian Open Note",
    description: "Open a vault-relative note path in the Obsidian desktop app.",
    parameters: Type.Object({ path: pathParam }),
    async execute(_id, params) {
      const uri = await openInObsidian(pi, config, params.path);
      return { content: [{ type: "text", text: `Opened in Obsidian: ${params.path}` }], details: { path: params.path, uri } };
    },
  });

  pi.registerTool({
    name: "obsidian_apply_template",
    label: "Obsidian Apply Template",
    description: "Render a vault-relative Markdown template using {{title}}, {{date}}, {{time}}, {{subject}}, {{professor}}, and {{content}} placeholders.",
    parameters: Type.Object({ templatePath: Type.String(), title: Type.String(), content: Type.Optional(Type.String()), subject: Type.Optional(Type.String()), professor: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const { date, time } = nowParts();
      const text = await renderTemplateNote(config, params.templatePath, {
        title: params.title,
        date,
        time,
        subject: params.subject ?? "",
        professor: params.professor ?? "",
        content: params.content ?? "",
      });
      return { content: [{ type: "text", text }], details: { templatePath: params.templatePath } };
    },
  });

  pi.registerTool({
    name: "obsidian_create_from_template",
    label: "Obsidian Create From Template",
    description: "Create a markdown note from a vault-relative template file.",
    promptGuidelines: ["Use this when the user asks to create a note using an Obsidian template."],
    parameters: Type.Object({ templatePath: Type.String(), title: Type.String(), content: Type.Optional(Type.String()), subject: Type.Optional(Type.String()), professor: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const { date, time } = nowParts();
      const text = await renderTemplateNote(config, params.templatePath, {
        title: params.title,
        date,
        time,
        subject: params.subject ?? "",
        professor: params.professor ?? "",
        content: params.content ?? "",
      });
      const path = notePathFor(config, params.title);
      return withFileMutationQueue(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, "utf8");
        const rel = vaultRelative(config, path);
        return { content: [{ type: "text", text: `Created Obsidian note from template: ${rel}` }], details: { path: rel, templatePath: params.templatePath } };
      });
    },
  });

  pi.registerTool({
    name: "obsidian_delete_note",
    label: "Obsidian Delete Note",
    description: "Delete an Obsidian note. Use only after explicit user confirmation.",
    parameters: Type.Object({ path: pathParam, confirmed: Type.Boolean({ description: "Must be true only after the user explicitly confirmed deletion." }) }),
    async execute(_id, params) {
      if (!params.confirmed) throw new Error("Deletion requires explicit confirmation.");
      const abs = resolveVaultPath(config, params.path);
      await rm(abs);
      return { content: [{ type: "text", text: `Deleted Obsidian note: ${params.path}` }], details: { path: params.path } };
    },
  });
}
