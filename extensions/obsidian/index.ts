import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface ObsidianConfig {
  vaultPath: string;
  vaultName: string;
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
  return input.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "Sem título";
}

function nowParts() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fileTime = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
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

function noteTitleFromPath(relPath: string) {
  return basename(relPath, ".md");
}

function baseNote(title: string, content = "") {
  const { date, time } = nowParts();
  const displayTitle = `${date} ${time} - ${title}`;
  return `---\ndate: ${date}\n---\n\n# ${displayTitle}\n\n${content}`.trimEnd() + "\n";
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
    try { text = await readFile(file, "utf8"); } catch {}
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
      results.push({ path: rel, title: noteTitleFromPath(rel), score, snippet });
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
  return `Obsidian config (${CONFIG_PATH})\n- vaultPath: ${config.vaultPath || "(não configurado)"}\n- vaultName: ${config.vaultName || "(derivado da pasta)"}\n- defaultNotesDir: ${config.defaultNotesDir || "(raiz do vault)"}\n- language: ${config.language}`;
}

function formatNoteInstruction(path: string, title: string) {
  return `${FORMAT_INSTRUCTIONS}\n\nFormate e melhore a estrutura Markdown da nota Obsidian abaixo, preservando todo o conteúdo e as palavras originais ao máximo.\n\nRegras específicas para esta tarefa:\n- Leia a nota com obsidian_read_note.\n- Reescreva a nota completa com obsidian_edit_note.\n- Não resuma, não comprima ideias, não remova conteúdo e não extraia TODOs.\n- Corrija apenas estrutura, espaçamento, headings, listas, blocos de código, LaTeX e callouts quando fizer sentido.\n- Mantenha o frontmatter YAML existente, incluindo a propriedade date.\n\nNota: ${path}\nTítulo: ${title}`;
}

export default function obsidianExtension(pi: ExtensionAPI) {
  let config = loadConfig();
  let currentNote: { path: string; title: string } | undefined;
  let editing = false;

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${FORMAT_INSTRUCTIONS}\nWhen using Obsidian tools, never delete notes unless the user explicitly asked. Use obsidian_search_notes when the user does not know the exact filename. Prefer obsidian_append_note for adding content; use obsidian_edit_note only when formatting the current note or when the user explicitly asks to replace the whole note.`,
  }));

  pi.on("input", async (event, ctx) => {
    if (!editing || !currentNote || event.source === "extension") return { action: "continue" as const };
    if (!event.text.trim() || event.text.trim().startsWith("/")) return { action: "continue" as const };
    const abs = resolveVaultPath(config, currentNote.path);
    await withFileMutationQueue(abs, async () => {
      await appendFile(abs, `\n\n${event.text}\n`, "utf8");
    });
    ctx.ui.notify(`Anexado em: ${currentNote.path}`, "success");
    return { action: "handled" as const };
  });

  pi.registerCommand("ob-config", {
    description: "Configure Obsidian: /ob-config, /ob-config test, /ob-config vault <path>, /ob-config name <vault>, /ob-config notes-dir <dir>",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) { ctx.ui.notify(renderConfig(config), "info"); return; }
      if (input === "test") {
        try {
          assertConfigured(config);
          const vaultOk = existsSync(config.vaultPath) && statSync(config.vaultPath).isDirectory();
          ctx.ui.notify(`Teste Obsidian:\n- vault: ${vaultOk ? "ok" : "não encontrado"} (${config.vaultPath})\n- nome do vault: ${config.vaultName || basename(config.vaultPath)}`, vaultOk ? "success" : "warning");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      const match = input.match(/^(vault|name|notes-dir)\s+([\s\S]+)$/i);
      if (!match) { ctx.ui.notify("Usage: /ob-config vault <path> | name <vault> | notes-dir <dir> | test", "warning"); return; }
      const key = match[1].toLowerCase();
      const value = match[2].replace(/^[\'\"]|[\'\"]$/g, "").trim();
      if (key === "vault") {
        const vaultPath = resolve(value);
        if (!existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
          ctx.ui.notify(`Vault não encontrado ou não é pasta: ${vaultPath}`, "warning");
          return;
        }
        config.vaultPath = vaultPath;
      }
      if (key === "name") config.vaultName = value;
      if (key === "notes-dir") config.defaultNotesDir = value;
      await saveConfig(config);
      ctx.ui.notify(renderConfig(config), "success");
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

  pi.registerCommand("ob-open", {
    description: "Search/select and open an Obsidian note: /ob-open [term]",
    handler: async (args, ctx) => {
      const term = args.trim() || (ctx.hasUI ? (await ctx.ui.input("Buscar nota:", "")) ?? "" : "");
      const picked = await pickSearchResult(ctx, config, term);
      if (!picked) { ctx.ui.notify("Nenhuma nota encontrada.", "warning"); return; }
      currentNote = { path: picked.path, title: picked.title };
      await openInObsidian(pi, config, picked.path);
      ctx.ui.notify(`Abrindo: ${picked.path}`, "success");
    },
  });

  pi.registerCommand("ob-remove", {
    description: "Search/select and remove an Obsidian note with confirmation: /ob-remove [term]",
    handler: async (args, ctx) => {
      const term = args.trim() || (ctx.hasUI ? (await ctx.ui.input("Buscar nota para remover:", "")) ?? "" : "");
      const picked = await pickSearchResult(ctx, config, term);
      if (!picked) { ctx.ui.notify("Nenhuma nota encontrada.", "warning"); return; }
      const ok = ctx.hasUI ? await ctx.ui.confirm("Remover nota?", `Remover ${picked.path}?`) : false;
      if (!ok) { ctx.ui.notify("Operação cancelada.", "info"); return; }
      await rm(resolveVaultPath(config, picked.path));
      if (currentNote?.path === picked.path) { currentNote = undefined; editing = false; ctx.ui.setStatus("obsidian-edit", undefined); }
      ctx.ui.notify(`Nota removida: ${picked.path}`, "success");
    },
  });

  pi.registerCommand("ob-edit-start", {
    description: "Select existing note or create a new one, then append normal messages: /ob-edit-start [term or title]",
    handler: async (args, ctx) => {
      assertConfigured(config);
      const input = args.trim() || (ctx.hasUI ? (await ctx.ui.input("Buscar nota ou criar título:", "")) ?? "" : "");
      if (!input) { ctx.ui.notify("Usage: /ob-edit-start <termo ou título>", "warning"); return; }

      const results = await searchNotes(config, input, 10);
      let picked: SearchResult | undefined;
      if (ctx.hasUI && results.length > 0) {
        const labels = ["+ criar nova nota", ...results.map(r => `${r.title} — ${r.path}${r.snippet ? ` — ${r.snippet.slice(0, 90)}` : ""}`)];
        const choice = await ctx.ui.select("Editar nota:", labels);
        if (!choice) return;
        if (choice !== labels[0]) picked = results[labels.indexOf(choice) - 1];
      } else if (!ctx.hasUI && results.length > 0) {
        picked = results[0];
      }

      if (picked) {
        currentNote = { path: picked.path, title: picked.title };
      } else {
        const path = notePathFor(config, input);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, baseNote(input), "utf8");
        currentNote = { path: vaultRelative(config, path), title: input };
      }

      editing = true;
      ctx.ui.setStatus("obsidian-edit", `EDITANDO OB: ${currentNote.title} · /ob-edit-stop · /ob-format`);
      ctx.ui.notify(`Editando: ${currentNote.path}\nMensagens sem / serão anexadas.`, "success");
    },
  });

  pi.registerCommand("ob-edit-stop", {
    description: "Stop editing the current Obsidian note",
    handler: async (_args, ctx) => {
      editing = false;
      ctx.ui.setStatus("obsidian-edit", currentNote ? `OB atual: ${currentNote.title}` : undefined);
      ctx.ui.notify(currentNote ? `Edição encerrada. Nota atual: ${currentNote.path}` : "Edição encerrada.", "info");
    },
  });

  pi.registerCommand("ob-format", {
    description: "Format the current Obsidian note with the model",
    handler: async (_args, ctx) => {
      if (!currentNote) { ctx.ui.notify("Nenhuma nota atual. Use /ob-edit-start para selecionar ou criar uma nota.", "warning"); return; }
      pi.sendUserMessage(formatNoteInstruction(currentNote.path, currentNote.title), { deliverAs: "followUp" });
      ctx.ui.notify(`Formatação enfileirada: ${currentNote.path}`, "success");
    },
  });

  const pathParam = Type.String({ description: "Vault-relative markdown note path." });

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
      currentNote = { path: params.path, title: noteTitleFromPath(params.path) };
      return { content: [{ type: "text", text: `Opened in Obsidian: ${params.path}` }], details: { path: params.path, uri } };
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
    name: "obsidian_append_note",
    label: "Obsidian Append Note",
    description: "Append markdown content to an Obsidian note. Content should already follow the Portuguese formatting rules.",
    promptSnippet: "Append formatted Portuguese markdown to an Obsidian note",
    promptGuidelines: ["Use obsidian_append_note to add cleaned Portuguese markdown to an existing note."],
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
    name: "obsidian_edit_note",
    label: "Obsidian Edit Note",
    description: "Replace the full markdown content of an Obsidian note. Prefer this for formatting the current note.",
    parameters: Type.Object({ path: pathParam, content: Type.String() }),
    async execute(_id, params) {
      const abs = resolveVaultPath(config, params.path);
      return withFileMutationQueue(abs, async () => {
        await writeFile(abs, params.content, "utf8");
        return { content: [{ type: "text", text: `Updated Obsidian note: ${params.path}` }], details: { path: params.path } };
      });
    },
  });
}
