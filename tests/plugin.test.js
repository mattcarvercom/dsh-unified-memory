import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { apply, Config, rootsFrom } from "../lib/index.js";
import { projectKey } from "../lib/keys.js";
import { writeState } from "../lib/state.js";
import { claudeMemoryDir, claudeOld, dshMade, dshMemoryDir, makeRoots, putMemory } from "./helpers.js";

/** Load the plugin against a fake host and return a tool caller. */
function load(t, config) {
  let tool;
  const sections = [];
  const ctx = {
    tools: { register: (def) => { tool = def; return () => {}; } },
    systemPrompt: { section: (s) => sections.push(s) },
    on: () => {},
    logger: { warn: () => {} },
  };
  apply(ctx, { dshRoot: t.dshRoot, claudeRoot: t.claudeRoot, indexDir: t.indexDir, projectAliases: {}, maxList: 200, maxIndexLines: 200, maxIndexBytes: 25000, searchLimit: 5, minResyncIntervalMs: 0, promptMode: "full", ...config });
  return {
    call: (args, cwd, sessionId = "session-test") => tool.execute(args, { agent: { id: sessionId, session: { id: sessionId, header: { cwd } } } }),
    tool,
    sections,
  };
}

describe("memory tool", () => {
  let t;
  let dev;
  let project;
  let claude;
  beforeEach(async () => {
    t = await makeRoots();
    dev = join(t.home, "dev");
    project = join(dev, "myapp");
    await mkdir(project, { recursive: true });
    claude = claudeMemoryDir(t.claudeRoot, projectKey(dev));
    await putMemory(claude, "no-emdash.md", claudeOld("no-emdash", "Never use em-dashes in prose"));
  });
  afterEach(() => t.cleanup());

  it("shared: saves into Claude Code's folder resolved by walking up, with provenance", async () => {
    const { call } = load(t, { mode: "shared" });
    const out = await call({ action: "add", name: "deploy-notes", text: "Deploys go through Cloudflare.", type: "project", description: "How myapp deploys" }, project, "session-abc");
    assert.match(out, /shared with Claude Code/);
    const content = await readFile(join(claude, "deploy-notes.md"), "utf8");
    const { data } = parseFrontmatter(content);
    assert.deepEqual(data.metadata, { type: "project", origin: "dsh", originSessionId: "session-abc", modified: data.metadata.modified });
    assert.match(await readFile(join(claude, "MEMORY.md"), "utf8"), /\(deploy-notes\.md\) — How myapp deploys/);
  });

  it("shared: updating Claude Code's memory keeps its fields and marks updatedBy", async () => {
    const { call } = load(t, { mode: "shared" });
    await call({ action: "update", name: "no-emdash", text: "Never use em-dashes anywhere." }, project);
    const content = await readFile(join(claude, "no-emdash.md"), "utf8");
    assert.match(content, /^type: feedback$/m);
    assert.match(content, /^originSessionId: 3f2a9c1e/m);
    assert.match(content, /updatedBy: dsh/);
    assert.match(content, /Never use em-dashes anywhere\./);
  });

  it("shared: deleting Claude Code's memory keeps a copy in the dsh trash", async () => {
    const { call } = load(t, { mode: "shared" });
    assert.match(await call({ action: "delete", name: "no-emdash" }, project), /a copy was kept at/);
    const trash = await readdir(join(t.dshRoot, "trash"));
    assert.equal(trash.length, 1);
  });

  it("delete removes a memory folder left empty", async () => {
    const { call } = load(t, { mode: "shared" });
    const other = join(t.home, "elsewhere");
    await mkdir(other, { recursive: true });
    await call({ action: "add", name: "only", text: "t", description: "the only one here" }, other);
    const dir = claudeMemoryDir(t.claudeRoot, projectKey(other));
    assert.deepEqual((await readdir(dir)).sort(), ["MEMORY.md", "only.md"]);
    await call({ action: "delete", name: "only" }, other);
    await assert.rejects(readdir(dir), /ENOENT/);
  });

  it("add refuses a near-duplicate unless forced", async () => {
    const { call } = load(t, { mode: "shared" });
    const out = await call({ action: "add", name: "emdash-rule", text: "x", description: "Never use em-dashes in prose" }, project);
    assert.match(out, /Not saved: similar memories already exist:\n- no-emdash\.md/);
    assert.match(await call({ action: "add", name: "emdash-rule", text: "x", description: "Never use em-dashes in prose", force: true }, project), /saved memory/);
  });

  it("overlay: writes to the dsh store, reads Claude Code's, and refuses to change them", async () => {
    const { call } = load(t, { mode: "overlay" });
    await call({ action: "add", name: "local", text: "dsh only", description: "overlay test" }, project);
    assert.deepEqual((await readdir(dshMemoryDir(t.dshRoot, projectKey(dev)))).sort(), ["MEMORY.md", "local.md"]);
    assert.match(await call({ action: "read", name: "no-emdash" }, project), /\(Claude Code\)/);
    await assert.rejects(call({ action: "update", name: "no-emdash", text: "x" }, project), /read-only in overlay mode/);
    const list = await call({ action: "list" }, project);
    assert.match(list, /no-emdash \(Claude Code\)/);
    assert.match(list, /local/);
    const found = await call({ action: "search", query: "em-dashes" }, project);
    assert.match(found, /no-emdash\.md \(Claude Code\)/);
  });

  it("dsh: never reads or writes Claude Code's folder", async () => {
    const { call } = load(t, { mode: "dsh" });
    await assert.rejects(call({ action: "read", name: "no-emdash" }, project), /not found/);
    await call({ action: "add", name: "x", text: "y", description: "zzz qqq" }, project);
    assert.equal((await readdir(claude)).includes("x.md"), false);
  });

  it("refuses writes while a migration is pending, but still reads", async () => {
    await writeState(t.dshRoot, "dsh");
    await putMemory(dshMemoryDir(t.dshRoot, projectKey(dev)), "d.md", dshMade("d", "dsh memory"));
    const { call } = load(t, { mode: "shared" });
    await assert.rejects(call({ action: "add", name: "n", text: "t" }, project), /mem mode shared/);
    assert.match(await call({ action: "read", name: "d" }, project), /Body of d/);
  });

  it("uses the recorded mode when none is configured", async () => {
    await writeState(t.dshRoot, "shared");
    const { call } = load(t, {});
    await call({ action: "add", name: "via-marker", text: "t", description: "marker decides" }, project);
    assert.equal((await readdir(claude)).includes("via-marker.md"), true);
  });

  it("defaults the dsh store to $DSH_HOME/memory", () => {
    const saved = process.env.DSH_HOME;
    try {
      process.env.DSH_HOME = "/opt/dsh-home";
      assert.equal(rootsFrom({}).dshRoot, "/opt/dsh-home/memory");
      delete process.env.DSH_HOME;
      assert.match(rootsFrom({}).dshRoot, /\/\.dsh\/memory$/);
      assert.equal(rootsFrom({ dshRoot: "/x/store" }).dshRoot, "/x/store");
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = saved;
    }
  });

  it("injects the index into the prompt section", async () => {
    const { sections } = load(t, { mode: "shared" });
    const scope = { session: { header: { cwd: project } } };
    assert.equal(sections[0].text({ scope }), "");
    await new Promise((r) => setTimeout(r, 100));
    const text = sections[0].text({ scope });
    assert.match(text, /shared with Claude Code/);
    assert.match(text, /no-emdash\.md/);
  });
});

describe("config defaults", () => {
  it("defaults promptMode to feedback", () => {
    assert.equal(Config({}).promptMode, "feedback");
  });
});
