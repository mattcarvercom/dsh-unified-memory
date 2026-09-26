/**
 * dsh-unified-memory: long-term memory for DeepSeek Harness in Claude Code's format.
 *
 * Registers a `memory` tool (add / update / delete / search / list / read)
 * and a `memory:notes` system-prompt section. Runs in one of three modes
 * (see `layout.js`): a private dsh store, a private store that also reads
 * Claude Code's memories, or one store shared with Claude Code. Mode changes
 * happen only through `mem mode`, which migrates files by provenance.
 *
 * @module dsh-unified-memory
 */

import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { homedir } from "node:os";
import { join } from "node:path";
import { foldersFor, storeFolders } from "./layout.js";
import * as prompts from "./prompts.js";
import * as search from "./search.js";
import { MODES, resolveMode } from "./state.js";
import * as store from "./store.js";

export const name = "dsh-unified-memory";

export const inject = ["tools", "systemPrompt"];

/** Plugin configuration (Schemastery). */
export const Config = Schema.object({
  mode: Schema.union(MODES).description("dsh, overlay, or shared. Omit to use whatever mode `mem mode` last set."),
  dshRoot: Schema.string().description("The dsh store; defaults to $DSH_HOME/memory, or ~/.dsh/memory."),
  claudeRoot: Schema.string().description("Claude Code's home; defaults to $CLAUDE_CONFIG_DIR or ~/.claude."),
  projectAliases: Schema.dict(Schema.string()).default({}),
  includeInPrompt: Schema.boolean().default(true),
  promptMode: Schema.union(["feedback", "full"]).default("feedback"),
  maxIndexLines: Schema.number().min(10).max(1000).default(store.INDEX_LINE_LIMIT),
  maxIndexBytes: Schema.number().min(1000).max(100000).default(store.INDEX_BYTE_LIMIT),
  maxList: Schema.number().min(1).max(500).default(store.DEFAULT_MAX_LIST),
  searchLimit: Schema.number().min(1).max(20).default(5),
  indexDir: Schema.string().description("Search index cache; defaults to $XDG_CACHE_HOME/dsh-unified-memory."),
  minResyncIntervalMs: Schema.number().min(0).max(3_600_000).default(search.DEFAULT_MIN_RESYNC_INTERVAL_MS),
  // Accepted so older profile overrides still load; ignored.
  memoryRoot: Schema.string().hidden(),
  scope: Schema.string().hidden(),
  importClaudeMemory: Schema.boolean().hidden(),
  indexPath: Schema.string().hidden(),
});

const ACTIONS = ["add", "update", "delete", "search", "list", "read"];

/** Resolve configured roots. */
export function rootsFrom(config) {
  const claudeDefault = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const dshDefault = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "memory");
  return {
    dshRoot: store.expandHome(config.dshRoot ?? dshDefault),
    claudeRoot: store.expandHome(config.claudeRoot ?? claudeDefault),
    aliases: config.projectAliases ?? {},
    indexDir: config.indexDir ? store.expandHome(config.indexDir) : undefined,
  };
}

/**
 * Create the plugin.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {Record<string, any>} config
 */
export function apply(ctx, config) {
  const roots = rootsFrom(config);
  const warn = (message) => ctx.logger?.warn?.(`[memory] ${message}`);
  for (const key of ["memoryRoot", "scope", "importClaudeMemory", "indexPath"]) {
    if (config[key] !== undefined) warn(`config key "${key}" is no longer used; see the README for mode, dshRoot and claudeRoot`);
  }

  /** The current mode state (re-read each time, so `mem mode` takes effect without a restart). */
  const modeState = () => resolveMode(roots.dshRoot, config.mode);

  /** Session directory and id for an agent. */
  const cwdOf = (agent) => agent?.session?.header?.cwd ?? "";
  const sessionIdOf = (agent) => agent?.session?.id ?? agent?.id;

  /** Label a folder for the prompt and tool output. */
  const labelOf = (folder) => (folder.source === "claude" && !folder.writable ? " (Claude Code)" : folder.source === "legacy" ? " (legacy)" : "");

  /** Per-directory prompt snapshots, rebuilt in the background. */
  const snapshots = new Map();
  const refreshing = new Set();

  function refreshSnapshot(cwd) {
    if (refreshing.has(cwd)) return;
    refreshing.add(cwd);
    (async () => {
      try {
        const state = await modeState();
        const { read } = await foldersFor(cwd, state.mode, roots);
        const feedbackMode = config.promptMode === "feedback";
        const cap = feedbackMode ? 100_000 : config.maxList;
        const scans = await Promise.all(read.map(async (folder) => ({ folder, entries: await store.scanMemoryFiles(folder.dir, cap) })));
        if (feedbackMode) {
          const all = scans.flatMap(({ folder, entries }) => entries.map((e) => ({ ...e, readOnly: !folder.writable })));
          const feedback = all.filter((e) => e.type === "feedback").sort((a, b) => a.filename.localeCompare(b.filename));
          snapshots.set(cwd, { text: prompts.renderFeedbackSection(state, feedback, all.length - feedback.length) });
          return;
        }
        const indexes = [];
        for (const folder of read) {
          const { content } = await store.readMemoryIndex(folder.dir, config.maxIndexLines, config.maxIndexBytes);
          indexes.push({ label: `Memory index${labelOf(folder)}`, index: content });
        }
        const files = scans.flatMap(({ entries }) => entries).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, config.maxList);
        snapshots.set(cwd, { text: prompts.renderPromptSection(state, indexes, store.formatIndexList(files)) });
      } catch (error) {
        warn(`snapshot refresh failed for ${cwd || "(no workspace)"}: ${error?.message ?? error}`);
      } finally {
        refreshing.delete(cwd);
      }
    })();
  }

  /** Synchronous render for the prompt section; a missing snapshot is built in the background. */
  function renderSection(context) {
    const cwd = cwdOf(context?.scope);
    const snapshot = snapshots.get(cwd);
    if (snapshot === undefined) {
      refreshSnapshot(cwd);
      return "";
    }
    return snapshot.text;
  }

  if (config.includeInPrompt !== false) {
    ctx.systemPrompt.section({ name: "memory:notes", order: -85, text: renderSection });
    // Cordis passes the payload object as the listener's only argument.
    ctx.on("agent/created", (payload) => {
      if (payload?.agent) refreshSnapshot(cwdOf(payload.agent));
    });
  }

  /** Find a memory by name: the session's folders first, then every store folder. */
  async function findMemory(file, agent, state) {
    const { read } = await foldersFor(cwdOf(agent), state.mode, roots);
    for (const folder of read) {
      const found = await store.readMemoryFile(folder.dir, file);
      if (found.exists) return { ...found, folder };
    }
    for (const { dir, side } of await storeFolders(state.mode, roots)) {
      if (read.some((f) => f.dir === dir)) continue;
      const found = await store.readMemoryFile(dir, file);
      if (found.exists) return { ...found, folder: { dir, side, source: side, writable: true } };
    }
    return null;
  }

  /** One-line description from the first non-empty line of text. */
  function describeFrom(text) {
    const first = String(text ?? "").split("\n").find((line) => line.trim().length > 0) ?? "";
    const trimmed = first.trim().replace(/^#+\s*/, "");
    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  }

  /** A file name from the first words of the text. */
  function nameFrom(text) {
    const slug = String(text ?? "").split(/\s+/).slice(0, 6).join("-").toLowerCase()
      .replace(/[^a-z0-9一-鿿-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return store.validateMemoryName(slug || `note-${new Date().toISOString().slice(0, 10)}`);
  }

  /** Reindex a folder right after this process writes it (best-effort). */
  async function reindexAfterWrite(dir) {
    try {
      await search.reindex(dir, { indexDir: roots.indexDir });
    } catch {
      // The unforced path picks the change up later.
    }
  }

  function intArg(value, fallback, min, max) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  function pageNote(offset, shown, total, noun) {
    if (shown === 0 || offset + shown >= total) return offset > 0 ? ` (last page: ${offset + 1}-${offset + shown} of ${total} ${noun})` : "";
    return ` (showing ${offset + 1}-${offset + shown} of ${total} ${noun}; call again with offset=${offset + shown} for the next page)`;
  }

  /** Refuse writes while a migration is pending. */
  function assertWritable(state) {
    if (state.pending) throw new Error(prompts.pendingNote(state));
  }

  async function runAction(args, agent) {
    const action = args.action;
    const state = await modeState();
    const cwd = cwdOf(agent);
    const folders = await foldersFor(cwd, state.mode, roots);

    if (action === "list") {
      const scans = await Promise.all(folders.read.map(async (folder) => ({ folder, entries: await store.scanMemoryFiles(folder.dir, 100_000) })));
      const all = scans.flatMap(({ folder, entries }) => entries.map((e) => ({ ...e, label: labelOf(folder) })));
      if (all.length === 0) return "no memories stored for this workspace";
      const needle = args.query ? String(args.query).toLowerCase() : "";
      if (!needle && !args.type) {
        const groups = new Map();
        for (const entry of all) {
          const key = entry.type ?? "untyped";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(`${entry.filename.replace(/\.md$/i, "")}${entry.label}`);
        }
        const counts = [...groups].map(([type, names]) => `${names.length} ${type}`).join(", ");
        const body = [...groups].map(([type, names]) => `[${type}] ${names.sort().join(", ")}`).join("\n\n");
        return `${all.length} memories (${counts}):\n\n${body}\n\nFind by topic: action=search query=<keywords>. Read one: action=read name=<file name>. Add query= or type= to see descriptions.`;
      }
      const filtered = all.filter((e) => (!args.type || e.type === args.type) && (!needle || `${e.filename} ${e.description ?? ""}`.toLowerCase().includes(needle)));
      if (filtered.length === 0) return `no memories match the filter (${all.length} memories total)`;
      const limit = intArg(args.limit, config.maxList, 1, 500);
      const offset = intArg(args.offset, 0, 0, filtered.length);
      const shown = filtered.slice(offset, offset + limit);
      if (shown.length === 0) return `offset ${offset} is past the end: ${filtered.length} memories match the filter`;
      return `${filtered.length} matching memories (${all.length} total)${pageNote(offset, shown.length, filtered.length, "matches")}:\n${store.formatIndexList(shown)}\n\nUse action=read name=<file name> to read one.`;
    }

    if (action === "search") {
      if (!args.query || !String(args.query).trim()) throw new Error("search requires the query parameter (keywords)");
      const offset = intArg(args.offset, 0, 0, 100_000);
      const { hits, total, empty } = await search.searchSources(folders.read, String(args.query), {
        limit: intArg(args.limit, config.searchLimit, 1, 100),
        offset,
        type: args.type ?? null,
        indexDir: roots.indexDir,
        minResyncIntervalMs: config.minResyncIntervalMs,
      });
      if (empty) return `"${args.query}" has no searchable keywords (only common words); use specific terms, or action=list`;
      if (total === 0) return `no memories match "${args.query}"`;
      if (hits.length === 0) return `offset ${offset} is past the end: ${total} memories match "${args.query}"`;
      const lines = hits.map((h) => `- [${h.type ?? "untyped"}] ${h.file}${h.source === "claude" && state.mode === "overlay" ? " (Claude Code)" : h.source === "legacy" ? " (legacy)" : ""}: ${h.description}`);
      return `${total} memories match "${args.query}"${pageNote(offset, hits.length, total, "matches")}:\n${lines.join("\n")}\n\nUse action=read name=<file name> to read one.`;
    }

    if (action === "read") {
      if (!args.name) throw new Error("read requires the name parameter");
      const file = store.validateMemoryName(args.name);
      const found = await findMemory(file, agent, state);
      if (!found) throw new Error(`memory ${file} not found; use action=search or action=list`);
      return `# ${file}${labelOf(found.folder)}\n\n${found.body.trim()}`;
    }

    if (action === "add") {
      assertWritable(state);
      if (!folders.write) throw new Error("this session has no workspace, so there is no project folder to save into");
      if (!args.text || !String(args.text).trim()) throw new Error("add requires the text parameter");
      const file = args.name ? store.validateMemoryName(args.name) : nameFrom(args.text);
      const title = file.replace(/\.md$/i, "");
      const description = args.description ? String(args.description) : describeFrom(args.text);
      const type = args.type ?? "project";
      if (!args.force) {
        const scans = await Promise.all(folders.read.map((f) => store.scanMemoryFiles(f.dir, 100_000)));
        const similar = store.findSimilar(scans.flat(), { file, name: title, description });
        if (similar.length > 0) {
          const list = similar.slice(0, 5).map(({ entry }) => `- ${entry.filename}: ${entry.description ?? ""}`).join("\n");
          return `Not saved: similar memories already exist:\n${list}\n\nUpdate one of them with action=update, or repeat the add with force=true if this is genuinely new.`;
        }
      }
      const filePath = await store.createMemory(folders.write.dir, file, {
        name: title, description, type, body: String(args.text).trim(), sessionId: sessionIdOf(agent),
      });
      refreshSnapshot(cwd);
      await reindexAfterWrite(folders.write.dir);
      return `saved memory ${file}${state.mode === "shared" ? " (shared with Claude Code)" : ""} at ${filePath}`;
    }

    if (action === "update" || action === "delete") {
      assertWritable(state);
      if (!args.name) throw new Error(`${action} requires the name parameter`);
      const file = store.validateMemoryName(args.name);
      const found = await findMemory(file, agent, state);
      if (!found) throw new Error(`memory ${file} not found; use action=search or action=list`);
      if (!found.folder.writable) {
        throw new Error(found.folder.source === "legacy"
          ? `${file} is a legacy memory and read-only; the user can run \`mem move-legacy\` to move it into this project`
          : `${file} belongs to Claude Code and is read-only in overlay mode`);
      }
      if (action === "update") {
        if (args.text === undefined && args.description === undefined && args.type === undefined) {
          throw new Error("update needs at least one of text, description, or type");
        }
        const filePath = await store.updateMemory(found.folder.dir, file, {
          ...(args.text !== undefined ? { body: String(args.text) } : {}),
          ...(args.description !== undefined ? { description: String(args.description) } : {}),
          ...(args.type !== undefined ? { type: args.type } : {}),
        }, found.folder.side);
        refreshSnapshot(cwd);
        await reindexAfterWrite(found.folder.dir);
        return `updated memory ${file} at ${filePath}`;
      }
      // Deleting a memory dsh did not create keeps a copy in the dsh store's trash.
      const mine = store.originOf(found.data, found.folder.side) === store.DSH_ORIGIN;
      const trashDir = mine ? undefined : join(roots.dshRoot, "trash", new Date().toISOString().replace(/[:.]/g, "-"));
      const result = await store.deleteMemory(found.folder.dir, file, { trashDir });
      // Don't leave an empty memory folder behind for a workspace that no longer has any.
      await store.removeIfEmpty(found.folder.dir);
      refreshSnapshot(cwd);
      await reindexAfterWrite(found.folder.dir);
      if (!result.deleted) return `memory ${file} does not exist`;
      return result.trashedTo ? `deleted memory ${file} (a copy was kept at ${result.trashedTo})` : `deleted memory ${file}`;
    }

    throw new Error(`unknown action: ${action} (available: ${ACTIONS.join(", ")})`);
  }

  ctx.tools.register(defineTool({
    name: "memory",
    description: prompts.TOOL_DESCRIPTION,
    parameters: {
      action: { type: "string", required: true, enum: ACTIONS, description: "add / update / delete / search / list / read" },
      name: { type: "string", description: "Memory file name (a short slug such as commit-message-style; generated for add when omitted)" },
      text: { type: "string", description: "Memory body (required for add; for feedback and project types: the fact, then **Why:** and **How to apply:** lines)" },
      description: { type: "string", description: "One-line description used to judge relevance later; defaults to the body's first line" },
      type: { type: "string", enum: store.MEMORY_TYPES, description: "user / feedback / project / reference (for list and search: a filter)" },
      query: { type: "string", description: "Keywords for search (required); for list, a filter that also shows descriptions" },
      limit: { type: "number", description: "For list and search: page size" },
      offset: { type: "number", description: "For list and search: results to skip, to fetch the next page" },
      force: { type: "boolean", description: "For add: save even though similar memories exist" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      return runAction(args, exec?.agent);
    },
  }));
}
