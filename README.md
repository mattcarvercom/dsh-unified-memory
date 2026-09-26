# dsh-unified-memory

Long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) that keeps the per-turn cost of memory small. Whatever a memory system puts in the system prompt takes up context on every turn, whether or not the task needs it, so memory tools that preload their whole index, Claude Code's `MEMORY.md` included, get more expensive with every memory they save. This plugin preloads only your standing feedback rules and finds everything else through a local SQLite full-text index when a task calls for it. On one store of about 150 memories, that is roughly 1.3k tokens per turn against about 15k with the whole index preloaded. The per-turn cost stays nearly flat as the store grows, and each memory costs context only in the turns that actually use it.

That matters most where context is scarce. A locally hosted model often runs with a context window of a few tens of thousands of tokens, and every token spent on memory it will not use comes out of the room left for code, tool output and reasoning, and is prefilled again on hardware that has none to spare. Long agentic runs feel the same pressure over hundreds of turns. A memory that grows without growing the prompt lets these setups remember as much as a large hosted deployment, without giving up the context they need to do the work.

Memories are plain markdown files in Claude Code's memory format. Run it as dsh's own private store, as a private store that also reads Claude Code's memories, or as one store shared with Claude Code so both agents read and write the same memories. Every file dsh creates says so in its frontmatter, which makes switching modes a mechanical migration and lets you remove everything dsh ever wrote with one command.

## Modes

| Mode | dsh writes to | dsh reads and searches | Claude Code sees dsh's memories |
|---|---|---|---|
| `dsh` | the dsh store (`~/.dsh/memory`) | the dsh store | no |
| `overlay` | the dsh store | the dsh store, plus Claude Code's memories (read-only) | no |
| `shared` | Claude Code's memory folder | Claude Code's memory folder | yes |

- **shared** suits one person using both agents on one machine: neither agent relearns what the other already knows.
- **overlay** lets dsh benefit from Claude Code's memories without ever writing into them.
- **dsh** keeps everything separate, and works without Claude Code installed.

## Install

```sh
dsh plugin --profile web add github:mattcarvercom/dsh-unified-memory#v1.0.1
```

Restart `dsh web` afterwards. The plugin starts in `dsh` mode (its own store in `~/.dsh/memory`); see [Modes](#modes) to share memories with Claude Code.

To work on the plugin itself, install from a checkout instead. dsh then loads it from outside the profile, so link the checkout's `node_modules` to the runtime's for its `@deepseek-ai/*` imports to resolve:

```sh
git clone https://github.com/mattcarvercom/dsh-unified-memory
ln -s ~/.dsh/profiles/node_modules dsh-unified-memory/node_modules
dsh plugin --profile web add ./dsh-unified-memory
```

## Compatibility and permissions

| | |
|---|---|
| dsh | Tested with DeepSeek Harness 0.1.7-rc.1, `web` profile |
| Node | Whatever dsh requires (22.19+ or 24+), which includes the built-in `node:sqlite` used for search; tested on Node 24 |
| Claude Code | Key and folder rules verified against Claude Code 2.1.282; only needed for `overlay` and `shared` modes |
| Platforms | Linux and macOS tested paths; Windows paths follow the same key rule but are untested |
| Dependencies | None beyond the dsh runtime (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`) |
| Network | None. Nothing leaves your machine |
| Files read | The dsh store (`~/.dsh/memory`) and, in `overlay` and `shared` modes, `~/.claude/projects/*/memory` |
| Files written | The dsh store, plus Claude Code's memory folders in `shared` mode only; search indexes in `~/.cache/dsh-unified-memory` |
| Processes | Runs `git rev-parse` to find a session's repository root |

Memories are plain text on disk. Do not store secrets in them; the injected prompt tells the agent the same.

## Configure

Override the `memory` row in your profile's `cordis.patch.yml`. The override replaces the row's config wholesale, so restate every field you set.

```yaml
- id: memory
  config:
    mode: shared
    promptMode: full    # opt out of the default (feedback) and also preload MEMORY.md
```

| Key | Default | Meaning |
|---|---|---|
| `mode` | unset | `dsh`, `overlay` or `shared`. Unset follows whatever `mem mode` last recorded |
| `dshRoot` | `$DSH_HOME/memory`, else `~/.dsh/memory` | The dsh store |
| `claudeRoot` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Claude Code's home |
| `projectAliases` | `{}` | Project key to canonical key, so several checkouts share one folder |
| `promptMode` | `feedback` | `feedback` injects only the standing feedback rules and relies on search; `full` also injects each folder's `MEMORY.md` and a file list |
| `includeInPrompt` | `true` | Inject the memory section into the system prompt |
| `maxIndexLines` / `maxIndexBytes` | `200` / `25000` | How much of `MEMORY.md` is injected in `full` mode |
| `maxList` | `200` | Default cap for the `list` action, and on files listed in the prompt in `full` mode |
| `searchLimit` | `5` | Default hits returned by search |
| `indexDir` | `$XDG_CACHE_HOME/dsh-unified-memory` | Search index cache |
| `minResyncIntervalMs` | `60000` | Minimum time between automatic rescans of a folder for search; dsh's own writes reindex immediately |

**Setting `mode` never moves files.** The files on disk are in the mode recorded in `<dshRoot>/state.json`. When the configured mode differs, the plugin stays readable but refuses writes and tells the agent to have you run `mem mode`.

A fresh install adopts the configured mode (or `dsh`) on first use, since there is nothing to migrate.

## Changing modes: `mem mode`

```sh
mem mode                        # print the current mode
mem mode shared --dry-run       # show exactly what would move
mem mode shared                 # back up, migrate, rebuild search indexes
```

| From | To | What moves |
|---|---|---|
| `dsh` | `overlay` | nothing |
| `overlay` | `dsh` | nothing |
| `dsh` or `overlay` | `shared` | dsh's memories move into Claude Code's folders, with their `MEMORY.md` lines |
| `shared` | `overlay` | memories dsh created move out to the dsh store |
| `shared` | `dsh` | as above, plus copies of Claude Code's memories, so dsh keeps what it knew; `--clean` skips the copies |

Details that keep this safe:

- **Backups.** Every migration first copies the dsh store and each Claude Code memory folder to `<dshRoot>/backups/<timestamp>/`. Only the `memory` folders are copied, never Claude Code's session transcripts.
- **Name collisions.** An incoming file whose name is taken is renamed with a `-dsh` (or `-claude`) suffix, and the dry run shows it.
- **Edits stay with the file.** A Claude Code memory that dsh edited stays in Claude Code's folder when you leave shared mode.
- **Returning to shared with copies.** An unchanged copy is dropped, because the original is already there. A copy dsh edited is a conflict: rerun with `--prefer dsh` (dsh's version replaces the original's body and description) or `--prefer claude`. A copy whose original you deleted is dropped unless you pass `--restore-deleted`.

## Provenance and removal

Files dsh creates carry provenance under `metadata:`:

```yaml
---
name: deploy-notes
description: How myapp deploys
metadata:
  type: project
  origin: dsh
  originSessionId: session-7c1e4b2a-9d3f-4a6b-8e5c-2f1a0b9c8d7e
  modified: 2026-09-24T18:02:11.000Z
---
```

| Field | Meaning |
|---|---|
| `origin` | Who created the file. Absent means Claude Code in Claude Code's folders, and dsh in the dsh store |
| `originSessionId` | The dsh session that created it (Claude Code writes the same field for its own files) |
| `updatedBy` | Added when dsh edits a file it did not create; `origin` never changes |
| `copiedFrom`, `copiedAt` | On copies taken when leaving shared mode |

```sh
mem list --origin dsh           # everything dsh created
mem list --updated-by dsh       # Claude Code memories dsh edited
mem purge --origin dsh --dry-run
mem purge --origin dsh          # back up, then delete dsh's files and their index lines
```

Purge never removes files dsh only edited; it lists them. When dsh deletes a memory it did not create, a copy goes to `<dshRoot>/trash/`.

## How files are written

- **Claude Code's format.** A memory is a markdown file with YAML frontmatter; each folder has a `MEMORY.md` index with one `- [Title](file.md) — hook` line per memory.
- **Edits change only what they set.** Updating a file rewrites just the frontmatter lines being changed; unknown fields, lists and comments are kept byte for byte. A file that keeps `type:` at the top level keeps it there.
- **Index edits re-read `MEMORY.md` first.** Claude Code takes no lock, so the plugin reads the index immediately before each change to keep a concurrent edit from being lost.
- **Types:** `user`, `feedback`, `project`, `reference`.

## Which folder a session uses

Claude Code keys memory by the git repository root of the directory it was launched from (a worktree maps to its main checkout), or the directory itself outside a repository. The key replaces every non-alphanumeric character with `-`, so `/home/me/dev` becomes `-home-me-dev`; keys over 200 characters are cut and given a hash suffix.

dsh sessions often start deeper than where Claude Code was launched, so the plugin walks from the session's root up to the nearest ancestor that already has a memory folder on either side, stopping at your home directory. Without a match, the root's own key is used. `projectAliases` apply before the walk.

## Search

`memory action=search` and `mem search` use a SQLite FTS5 index (built into Node's `node:sqlite`, no native dependency) with Porter stemming and bm25 ranking, name and description weighted above the body. The markdown files are the only source of truth: the index lives in `indexDir`, is updated incrementally, and can be deleted at any time.

With the default `promptMode: feedback`, only the standing feedback rules are preloaded (about 1k tokens for a hundred memories) and the agent searches for everything else per task. `promptMode: full` also preloads each `MEMORY.md` and a file list, which saves a search call per task at the cost of a prompt that grows with the store; before 1.0.1 it was the default.

## The agent's tool

The `memory` tool offers `add`, `update`, `delete`, `search`, `list` and `read`. `add` refuses a memory whose name or description closely matches an existing one and lists the matches, so the agent updates one of them instead; `force: true` saves anyway. The model decides when to save; the injected prompt tells it what is worth keeping.

## `mem` reference

```
mem status [--cwd DIR]
mem search <keywords...> [-n N] [-o OFFSET] [-t TYPE] [--cwd DIR] [--json]
mem list [--origin dsh|claude] [--updated-by dsh] [--json]
mem mode [dsh|overlay|shared] [--dry-run] [--clean] [--prefer dsh|claude] [--restore-deleted]
mem purge --origin dsh [--dry-run]
mem move-legacy [--cwd DIR] [--dry-run]
mem reindex [--rebuild]
```

Common options: `--dsh-root`, `--claude-root`, and `--alias RAW=KEY` (repeatable). `$DSH_MEMORY_ROOT` (else `$DSH_HOME/memory`) and `$CLAUDE_CONFIG_DIR` set the defaults.

## Upgrading from deepseek-harness-memory 0.1

- The `memoryRoot`, `scope` and `importClaudeMemory` settings are gone (still accepted, and ignored with a warning). Use `mode`, `dshRoot` and `claudeRoot`.
- An existing dsh store is treated as `dsh` mode. Run `mem mode <mode>` to move to another mode.
- User-level memories at the top of the old store (`~/.dsh/memory/*.md`) stay readable but read-only; `mem move-legacy --cwd <project>` folds them into a project.
- The `import-claude` tool action is gone: `overlay` mode reads Claude Code's memories in place, and `mem mode dsh` from `shared` takes copies.
- The search cache moved from `~/.cache/deepseek-harness-memory` to `~/.cache/dsh-unified-memory`; the old folder can be deleted.

## Format contract for other tools

Anything else that reads or writes a folder shared with dsh-unified-memory and Claude Code should:

1. Keep one `.md` file per memory, with YAML frontmatter holding at least `name` and `description`, and a type either as top-level `type:` or as `metadata.type`.
2. Keep one `- [Title](file.md) — hook` line per memory in `MEMORY.md`, change only its own lines, and re-read the file immediately before writing it.
3. Preserve every frontmatter field it does not understand.
4. Mark files it creates with `metadata.origin: <tool>` and files it edits with `metadata.updatedBy: <tool>`, never changing another tool's `origin`.
5. Write through a temporary file and rename it into place.

## Development

```sh
ln -s ~/.dsh/profiles/node_modules node_modules   # runtime imports, for the plugin tests
npm test
```

## Credits

dsh-unified-memory began as a fork of deepseek-harness-memory by jzc (MIT). Its frontmatter parsing and a few storage helpers still derive from that work; the storage modes, provenance tracking, migrations, full-text search, Claude Code key resolution, and the `mem` CLI are new.
