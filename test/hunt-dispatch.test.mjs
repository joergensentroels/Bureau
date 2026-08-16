// Does the RUNNER enforce the review-phase scope, or does the prompt just ask?
//
// test/hunt-scope.test.mjs establishes what huntRefusal answers. It cannot establish that anything calls it, and this
// repo has been bitten by exactly that gap twice: a branch disabled with `&& false` left a source-scanning suite fully
// green, and an action was asserted to be "IS implemented" while two rewrite layers guaranteed it never reached a
// dispatcher that had no branch for it. test/action-surface.test.mjs says so in its own header and names the missing
// instrument: "Closing that gap needs a turn loop driven end to end, which needs a provider and a Latch; the pure
// suite cannot have one."
//
// It can. Latch is reached through exactly one function (`latch()`) at one base URL (LATCH_URL), so a forty-line HTTP
// stub is a provider, an approval queue and an executor at once. This file boots a REAL Bureau against that stub,
// starts REAL runs, and reads the events the runner actually emitted. Nothing here is parsed out of server.mjs.
//
// The three things it establishes, in the order they matter:
//   1. A hunting round refuses an action outside HUNT_ACTIONS — and files NO approval doing it, which is the half
//      that proves it short-circuited rather than merely lost the argument later.
//   2. A hunting round still does its own work: read_repo runs.
//   3. A NON-hunting run is completely unaffected — the same agent, the same proposal, and the file is really written.
//      That is the control that matters most, because the cheapest way to pass 1 and 2 is to break everything.
//
// The stub answers "approved" the instant an approval is polled. That is deliberate and it sharpens every assertion
// here: with the guard removed, a proposed file_write during a hunt does not stall, it SUCCEEDS and a document lands
// on disk. So "no deliverable" is evidence about the guard rather than about the stub being slow.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "hunttest_" + randomBytes(18).toString("base64url");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (detail ? "  — " + detail : "")); }
};
const done = async (code) => {
  // The workspace below calls itself a THROWAWAY and nothing ever threw it away: 128 of them had piled up in
  // the live datastore, against 6 real ones, because this suite runs on every pre-push. Deleted here rather
  // than at the end of the happy path, so a failed assertion or an early exit cleans up too — the leak was
  // invisible precisely because it left no failure behind.
  //
  // BEFORE child.kill(): the only way to remove a workspace is through the server's own API, so killing first
  // makes the delete unsendable. That ordering is the whole reason this is here and not two lines lower.
  if (typeof WS === "string" && WS && WS !== "default") {
    try { await api("DELETE", "/api/workspaces/" + WS); } catch {}
  }
  try { child?.kill(); } catch {} try { latch.close(); } catch {} try { rmSync(repo, { recursive: true, force: true }); } catch {}
  console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
  process.exit(code ?? (fail ? 1 : 0));
};

// ---- the stub Latch: provider + approval queue + executor -------------------------------------
// `reply` is what the model says next. Set before each run; runs are strictly sequential so there is no interleaving.
let reply = null;
const approvals = [];          // every approval Bureau FILED, with the act: tag it stamped on
let prompts = [];              // every message list Bureau SENT to the provider, newest run last
const setAction = (a) => { reply = JSON.stringify({ thought: "t", speak: "s", next: { type: "propose_action", ...a } }); };

const latch = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url.split("?")[0];
    const j = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    // `fallback` is what latchHealth reads as the PAID provider. It is advertised here so the run-start
    // rate-table check has something to look at; no agent in this file is funded, so canUsePaid() is still
    // false everywhere and nothing actually routes paid.
    if (url === "/api/llm/config") return j({ ok: true, model: "stub-model", provider: "stub", enabled: true,
      fallback: { model: "stub-unrated-paid", provider: "stub" } });
    if (url === "/api/state") return j({ approvals: [] });
    if (url === "/api/llm/chat") {
      // Every prompt Bureau actually SENT. The own-work section below reads these: what an agent was told is
      // only checkable from the provider's side, and this stub is the provider.
      try { prompts.push(JSON.parse(body)?.messages || []); } catch {}
      return j({ ok: true, text: reply, routing: { mode: "local" }, usage: { input: 10, output: 10, total: 20 } });
    }
    if (url === "/api/approvals" && req.method === "POST") {
      let b = {}; try { b = JSON.parse(body); } catch {}
      const id = "appr_" + (approvals.length + 1);
      // `act-<type>`, the tag fileApproval stamps on every approval it creates (mkTag joins with a hyphen).
      const act = (b.contextTags || []).map(String).find((t) => t.startsWith("act-")) || "act-?";
      approvals.push({ id, act: act.slice(4), title: String(b.title || "") });
      return j({ id, status: "pending" });
    }
    if (url.startsWith("/api/approvals/")) return j({ id: url.split("/").pop(), status: "approved", responseNote: "go ahead" });
    return j({ ok: true });
  });
});
await new Promise((r) => latch.listen(0, "127.0.0.1", r));
const LATCH_URL = `http://127.0.0.1:${latch.address().port}`;

// ---- a small repository for the round to look at ----------------------------------------------
const repo = mkdtempSync(join(os.tmpdir(), "bureau-huntrepo-"));
writeFileSync(join(repo, "sum.mjs"), "export function sum(xs) { let t = 0; for (let i = 0; i < xs.length - 1; i++) t += xs[i]; return t; }\n");
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "hunt-fixture", version: "1.0.0" }, null, 2) + "\n");

// ---- a real Bureau, on its own port, pointed at the stub --------------------------------------
const PORT = await new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const B = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, BUREAU_PORT: String(PORT), OPERATOR_TOKEN: TOKEN, LATCH_URL, BUREAU_LOG: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

let WS = "default";
const api = async (m, p, body) => {
  const headers = { "content-type": "application/json", "x-workspace": WS, authorization: `Bearer ${TOKEN}` };
  const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  return { status: r.status, j };
};

{
  const deadline = Date.now() + 25000;
  let up = false;
  while (Date.now() < deadline && !up) {
    await new Promise((r) => setTimeout(r, 300));
    if (child.exitCode !== null) { console.error("the test server exited early:\n" + serverLog); await done(2); }
    try { up = (await fetch(B + "/")).ok; } catch {}
  }
  if (!up) { console.error("the test server never came up:\n" + serverLog); await done(2); }
}

// Everything runs in a THROWAWAY workspace: these runs write real company state (agents, deliverables, audit rows).
WS = (await api("POST", "/api/workspaces", { name: "Hunt Enforcement" })).j.id;
if (!WS) { console.error("could not create a throwaway workspace"); await done(2); }

// One agent, TRUSTED, allowed everything this file proposes. The tier is the point: file_write is in
// SAFE_TIER_ACTIONS, so a trusted agent auto-approves it with no human — which is what made an unenforced
// review phase a real hole rather than a tidiness complaint.
const agent = (await api("POST", "/api/agents", { name: "Hunter", role: "Reviewer" })).j;
await api("PATCH", "/api/agents/" + agent.id, { tier: "trusted", allow: ["read_repo", "register_finding", "note", "file_write", "shell", "github_issue"] });
await api("POST", "/api/guardrails", { findingRepo: repo, investigateRounds: 1, coverageMap: false, refute: false });

// Start a run and wait for it to finish (or to block), then hand back its events.
const runAndWatch = async (spec, until) => {
  const started = await api("POST", "/api/run", spec);
  if (started.status !== 201) return { events: [], error: `run rejected: ${started.status} ${JSON.stringify(started.j)}` };
  const id = started.j.runId;
  const deadline = Date.now() + 90000;
  let events = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    events = (await api("GET", "/api/runs/" + id)).j.events || [];
    if (events.some((e) => ["done", "failed"].includes(e.type))) break;
    if (until && until(events)) break;
  }
  await api("POST", `/api/run/${id}/stop`, {});
  return { events, id };
};
const types = (evs) => evs.map((e) => e.type);
const blocked = (evs) => evs.filter((e) => e.type === "blocked").map((e) => e.data);
const results = (evs) => evs.filter((e) => e.type === "result").map((e) => e.data);
// The saved documents this company can see. The key is `files` — reading a key this endpoint does NOT return
// yields undefined, `?? []` turns that into a clean empty list, and "nothing was written" then passes forever
// against a probe that never looked. That happened on the first run of this file, so the shape is asserted here
// and the zero it reports is negative-controlled at the end of the run.
const deliverables = async () => {
  const r = await api("GET", "/api/deliverables");
  if (r.status !== 200 || !Array.isArray(r.j.files)) { fail++; console.log("✗ /api/deliverables did not answer with a file list — " + JSON.stringify(r).slice(0, 200)); return null; }
  return r.j.files;
};

try {
  // -------------------------------------------------------------------------------------------
  // Lives here because this is the only suite that SPAWNS a real Bureau and keeps its log. units asserts
  // what unratedTierModels computes; only a booted process can establish that anything calls it, and a
  // pure function nobody invokes is the same silence it was written to break.
  console.log("# a model the build offers but cannot price is announced at BOOT");
  {
    ok("floor: the server log was captured at all", serverLog.length > 0, "empty server log");
    ok("boot warned about the unrated paid model, by name", /PAID MODEL "kimi-k3" HAS NO RATE TABLE/.test(serverLog),
      serverLog.split("\n").slice(0, 12).join("\n"));
    ok("  and the warning carries the consequence, not just the name",
      /budgetUsd caps/.test(serverLog) && /flat blended/i.test(serverLog));
    ok("  the rated tier models are NOT warned about — it discriminates",
      !/PAID MODEL "kimi-k2\.6"/.test(serverLog) && !/PAID MODEL "kimi-k2\.7-code"/.test(serverLog));
  }

  // -------------------------------------------------------------------------------------------
  console.log("\n# a hunting round refuses what the review phase says it cannot do");
  {
    approvals.length = 0;
    setAction({ actionType: "file_write", title: "review-notes", details: "writing up the round",
      command: "# Review notes\n\nA complete finished document, long enough that nothing rewrites it into something else on the way to the dispatcher." });
    const { events, error } = await runAndWatch({ mode: "hunt", agentId: agent.id, objective: "Look for defects.", maxTurns: 2 });
    ok("the hunting run started and produced events", !error && events.length > 0, error || types(events).join(","));
    const b = blocked(events);
    ok("file_write was BLOCKED by the runner during the round", b.some((x) => x.actionType === "file_write"),
      JSON.stringify(b) || "no blocked event; types: " + types(events).join(","));
    ok("  and the reason names the scope, not the floor", b.some((x) => /hunting round can take/.test(x.reason || "")),
      JSON.stringify(b.map((x) => x.reason)));
    // The half that proves it short-circuited. Anything reaching fileApproval has already put a card in front of a
    // human — and, on this trusted agent, would have been auto-approved and EXECUTED a moment later.
    ok("  no approval was filed for it — it never reached the seam", approvals.length === 0,
      JSON.stringify(approvals));
    const saved = await deliverables();
    ok("  and nothing was written: the company has no saved document", saved?.length === 0, JSON.stringify(saved));
  }

  // -------------------------------------------------------------------------------------------
  console.log("\n# and a hard-floored action short-circuits instead of waiting out the ten-minute deadline");
  for (const [act, extra] of [["github_issue", { title: "sum() drops its last element", command: "Body of the issue." }],
                              ["shell", { title: "run the suite", command: "npm test" }]]) {
    approvals.length = 0;
    setAction({ actionType: act, details: "worth doing", ...extra });
    const { events, error } = await runAndWatch({ mode: "hunt", agentId: agent.id, objective: "Look for defects.", maxTurns: 2 });
    const b = blocked(events);
    ok(`${act} was blocked, with the unattended reason`, !error && b.some((x) => x.actionType === act && /unattended/.test(x.reason || "")),
      error || JSON.stringify(b) || types(events).join(","));
    ok(`  and no approval was filed for it — nothing was left pending for a CEO who is not there`, approvals.length === 0,
      JSON.stringify(approvals));
  }

  // -------------------------------------------------------------------------------------------
  console.log("\n# the round is narrowed, not disabled");
  {
    approvals.length = 0;
    setAction({ actionType: "read_repo", title: "sum.mjs", details: "reading the source under review" });
    const { events, error } = await runAndWatch({ mode: "hunt", agentId: agent.id, objective: "Look for defects.", maxTurns: 2 });
    ok("read_repo ran: the round still does its own work", !error && results(events).some((r) => r.actionType === "read_repo" && r.ok),
      error || JSON.stringify(results(events)) || types(events).join(","));
    ok("  and nothing in the round was blocked", blocked(events).length === 0, JSON.stringify(blocked(events)));
  }

  // -------------------------------------------------------------------------------------------
  // THE control. Same server, same agent, same tier, same proposal — a run that is not hunting.
  console.log("\n# a NON-hunting run is completely unaffected: the same proposal really executes");
  {
    approvals.length = 0;
    setAction({ actionType: "file_write", title: "welcome-note", details: "the deliverable",
      command: "# Welcome\n\nA complete finished document, long enough that nothing rewrites it into something else on the way to the dispatcher." });
    const { events, error } = await runAndWatch({ mode: "single", agentId: agent.id, investigate: false,
      objective: "Save a short welcome note as a document.", maxTurns: 2 });
    ok("the single run started and produced events", !error && events.length > 0, error || types(events).join(","));
    ok("file_write EXECUTED — the file was really written to disk",
      results(events).some((r) => r.actionType === "file_write" && r.ok && /^drafts\//.test(r.url || "")),
      JSON.stringify(results(events)) || types(events).join(","));
    // This is also the negative control for the zero above: the SAME call, on the same server, now reports a file.
    // Without it, "the company has no saved document" would be equally true of a probe pointed at nothing.
    const saved = await deliverables();
    ok("  and the company can see it — which is what makes the empty reading during the hunt a real zero",
      saved?.length >= 1, JSON.stringify(saved));
    ok("  the approval seam was reached, as it always was on this path",
      approvals.some((a) => a.act === "file_write"), JSON.stringify(approvals));
    ok("  and NOTHING in the run was blocked for being out of a hunting round's scope",
      blocked(events).every((x) => !/hunting round/.test(x.reason || "")), JSON.stringify(blocked(events)));
  }

  // -------------------------------------------------------------------------------------------
  console.log("\n# nor is the hard floor's ordinary behaviour changed outside a hunting round");
  {
    approvals.length = 0;
    setAction({ actionType: "github_issue", title: "sum() drops its last element", command: "Body of the issue.", details: "worth filing" });
    const { events, error } = await runAndWatch({ mode: "single", agentId: agent.id, investigate: false,
      objective: "Raise the defect on the repository.", maxTurns: 2 });
    ok("github_issue still goes to the seam and asks a human, as before", !error && approvals.some((a) => a.act === "github_issue"),
      error || JSON.stringify(approvals) || types(events).join(","));
    ok("  it is NOT short-circuited: the unattended reason belongs to hunting rounds only",
      blocked(events).every((x) => !/unattended/.test(x.reason || "")), JSON.stringify(blocked(events)));
  }

  // -------------------------------------------------------------------------------------------
  // ownWorkQuery/rankOwnWork/ownWorkBlock are unit-tested, and that establishes nothing about whether
  // runAgentTask CALLS them — the failure this repo keeps meeting. So: seed two memories on one agent,
  // then run a third task relevant to only ONE of them and read what the agent was actually told.
  //
  // The discriminating assertion is the ABSENCE of the irrelevant memory. Under the recency-only code
  // this replaced, both memories sat inside the same five-slot window and both were injected.
  console.log("\n# own-work memory reaches the agent RANKED, not merely recent");
  {
    const NOTE = (title) => ({ actionType: "note", title, details: "noted", command: "" });
    // Two runs on the same agent, two unrelated subjects. A completed run always leaves one memory entry
    // whose objective is the run's objective (persistRun prepends it), so this is how memory gets seeded.
    setAction(NOTE("checks"));
    await runAndWatch({ mode: "single", agentId: agent.id, investigate: false, maxTurns: 2,
      objective: "Review what the existing checks would accept as a passing result." });
    setAction(NOTE("hiring"));
    await runAndWatch({ mode: "single", agentId: agent.id, investigate: false, maxTurns: 2,
      objective: "Draft the quarterly hiring plan for the engineering department." });

    // Floor: the seeding really happened. Without this, every assertion below is about an empty corpus.
    // Read through /api/org — there is no GET /api/agents, and the first version of this floor asked for
    // one, got `{}`, and reported an empty memory for an agent that had two entries.
    const org = (await api("GET", "/api/org")).j;
    ok("  floor: the org read answered with a roster at all", Array.isArray(org.agents) && org.agents.length > 0,
      JSON.stringify(org).slice(0, 200));
    const mem = (org.agents || []).find((a) => a.id === agent.id)?.memory || [];
    ok("  floor: both subjects are really in the agent's memory now",
      mem.some((m) => /existing checks would accept/.test(m.objective || ""))
      && mem.some((m) => /quarterly hiring plan/.test(m.objective || "")),
      JSON.stringify(mem.map((m) => (m.objective || "").slice(0, 50))));
    ok("  floor: and they are inside the window the old code would have injected — both, not one",
      mem.slice(0, 5).filter((m) => /existing checks would accept|quarterly hiring plan/.test(m.objective || "")).length === 2,
      JSON.stringify(mem.slice(0, 5).map((m) => (m.objective || "").slice(0, 50))));

    // A third task that is about the checks and has nothing to do with hiring.
    prompts = [];
    setAction(NOTE("adversary"));
    const { error } = await runAndWatch({ mode: "single", agentId: agent.id, investigate: false, maxTurns: 2,
      objective: "Re-read the existing checks and say what a passing result would accept." });
    ok("  the third run reached the provider", !error && prompts.length > 0, error || "no prompt captured");

    const blocks = prompts.flat().map((m) => String(m?.content || "")).filter((c) => /^Your own recent work/.test(c));
    // Floor: the block exists at all. "hiring is absent" is trivially true of a prompt with no block in it,
    // which is exactly how this assertion would go vacuous.
    ok("  floor: the agent was given an own-work block", blocks.length > 0,
      "no own-work block in " + prompts.flat().length + " messages");
    const block = blocks.join("\n");
    ok("  it carries the memory the objective is about", /existing checks would accept/.test(block),
      block.slice(0, 400));
    ok("  and NOT the unrelated one recency would have included", !/quarterly hiring plan/.test(block),
      block.slice(0, 400));
  }

  // -------------------------------------------------------------------------------------------
  // The CROSS-TEAM block, on a real hunting round. Units establish that recallSharedMemory discriminates
  // when handed the lens; they establish nothing about which string runAgentTask hands it, and that call
  // site is the entire defect. Shared recall skips the asking agent, so this needs a SECOND agent — the
  // reason the single-agent company in TESTING.md saw an empty block and the defect stayed invisible.
  //
  // The irrelevant memory is deliberately written in HUNT vocabulary ("register a finding", "probe",
  // "round"). That is the mechanism rather than a trick: the standing instructions and the digest are
  // most of the objective's query terms, so a memory sharing their words outscores the one the lens is
  // about. Verified before this was written down — ranked against the whole objective, the irrelevant
  // memory comes back FIRST and the relevant one second. An "unrelated work is absent" assertion over a
  // fixture the old code also passed would have proved nothing.
  console.log("\n# cross-team memory is ranked against the LENS on a hunting round, not the objective");
  {
    const NOTE = (title) => ({ actionType: "note", title, details: "noted", command: "" });
    const RELEVANT = "Reconcile the stated version numbers across the documentation";
    const BOILERPLATE = "Register a finding about the probe that never ran in the round";
    // Six memories for four slots, so the block is a SELECTION. The first draft of this seeded two and
    // asserted the irrelevant one was absent; it failed, and the reason was the fixture rather than the
    // code. recallSharedMemoryHybrid fuses BM25 with vector similarity through RRF, and the semantic half
    // keeps every entry with cosine > 0 — so with fewer candidates than slots BOTH come back whatever the
    // query, and "absent" was arithmetic the ranker could not have produced. Ordering is asserted instead
    // of membership for the same reason it holds on both paths: this suite inherits BUREAU_EMBED_URL, so
    // the hybrid half is live on a machine running the local embedder and silently off on one that is not.
    const DECOYS = [
      BOILERPLATE,
      "Rebuild the approval card so it shows the command",
      "Give the scheduler a jitter so runs do not stack",
      "Move the state directory out of the repository",
      "Add an accessible name to every icon button",
    ];

    const mate = (await api("POST", "/api/agents", { name: "Mate", role: "Engineer" })).j;
    ok("floor: a second agent exists — shared recall excludes the asker, so one agent can never populate it",
      !!mate?.id && mate.id !== agent.id, JSON.stringify(mate).slice(0, 200));
    await api("PATCH", "/api/agents/" + mate.id, { tier: "trusted", allow: ["note"] });
    for (const objective of [RELEVANT, ...DECOYS]) {
      setAction(NOTE("seed"));
      await runAndWatch({ mode: "single", agentId: mate.id, investigate: false, maxTurns: 2, objective });
    }
    const mateMem = ((await api("GET", "/api/org")).j.agents || []).find((a) => a.id === mate.id)?.memory || [];
    ok("  floor: every seeded subject is really in the teammate's memory",
      [RELEVANT, ...DECOYS].every((o) => mateMem.some((m) => m.objective === o)),
      JSON.stringify(mateMem.map((m) => (m.objective || "").slice(0, 40))));
    ok("  floor: and there are more of them than the block has slots, so recall must CHOOSE",
      mateMem.length > 4, String(mateMem.length));

    // Company DELIVERABLES get the same query eleven lines further down, and unlike shared recall they are
    // excluded only by name — so this block is populated even on the single-agent company where the
    // cross-team one is empty. More documents than slots, same reason as above.
    //
    // `probe-register` is the one that makes this assertion mean anything, and it was added because the
    // negative control said so: with only the three topical documents below, reverting this call site to
    // the objective changed NOTHING and the check stayed green through the defect it was written for.
    // A decoy has to be dense in the standing instructions' own vocabulary — probe, finding, round,
    // register, repository — because that vocabulary IS what the diluted query is mostly made of.
    for (const [title, body] of [
      ["version-figures", "# Version figures\n\nEvery stated version number, count and date in the documentation, with the derivation for each. The stated totals were four commits stale before this existed."],
      ["scheduler-jitter", "# Scheduler jitter\n\nEvery schedule fired on the minute and three runs overlapped. Jitter is applied per schedule so they spread out."],
      ["approval-card", "# Approval card\n\nThe card showed the action type where the operator needed the actual command and its argument."],
      ["probe-register", "# Probe register\n\nEvery registered finding from each hunting round, the probe that proved it, and the repository file the defect was found in. A round that opens no repository files is recorded as dry, and the register orders lenses by what they confirm."],
    ]) {
      setAction({ actionType: "file_write", title, details: "seeding the company corpus", command: body });
      await runAndWatch({ mode: "single", agentId: agent.id, investigate: false, maxTurns: 2, objective: `Save ${title} as a document.` });
    }
    const docs = (await deliverables()) || [];
    ok("  floor: the company corpus has more documents than the RAG block has slots",
      docs.length > 3, JSON.stringify(docs.map((d) => d.name || d)));

    // One lens, chosen by us rather than by the register's rotation, so the round is deterministic.
    const installed = (await api("GET", "/api/lenses")).j.lenses || [];
    ok("  floor: the register answered with the built-in lenses", installed.length >= 8, JSON.stringify(installed).slice(0, 150));
    for (const l of installed) await api("PATCH", "/api/lenses/" + encodeURIComponent(l.id), { off: true });
    const LENS_ID = "stated-numbers";
    await api("POST", "/api/lenses", { id: LENS_ID,
      prompt: "Read every stated version number, count and date in the documentation and derive the true value from the source that would contradict it." });
    const active = ((await api("GET", "/api/lenses")).j.lenses || []).filter((l) => !l.off);
    ok("  floor: exactly one lens is active, and it is the one just installed",
      active.length === 1 && active[0].id === LENS_ID, JSON.stringify(active.map((l) => l.id)));

    prompts = [];
    setAction({ actionType: "read_repo", title: "sum.mjs", details: "reading the source under review" });
    const { events, error } = await runAndWatch({ mode: "hunt", agentId: agent.id, objective: "Look for defects.", maxTurns: 2 });
    ok("  the hunting round ran and reached the provider", !error && prompts.length > 0, error || types(events).join(","));
    ok("  floor: and it ran under the lens we installed, not one of the built-ins",
      events.some((e) => e.type === "lens" && e.data?.lens === LENS_ID),
      JSON.stringify(events.filter((e) => e.type === "lens").map((e) => e.data)));

    const blocks = prompts.flat().map((m) => String(m?.content || "")).filter((c) => /^What the company already knows/.test(c));
    // The floor that matters most here. Unwiring the call site entirely removes the block, and then
    // "the boilerplate memory is absent" is true for the wrong reason — absent because nothing was sent.
    // That is exactly how the own-work version of this check stayed green through a broken call site.
    ok("  floor: a cross-team block was actually sent to the agent", blocks.length > 0,
      "no cross-team block among " + prompts.flat().length + " messages");
    // `|| ""` throughout, and it is not defensive noise: with the block unwired these extractors read off
    // undefined and the suite THREW, taking every later assertion in the file with it. A missing block has
    // to make each assertion red on its own terms — an exception reports one problem and hides the rest.
    const block = blocks[0] || "";
    ok("  floor: and it names the teammate whose work it is", /Mate/.test(block), block.slice(0, 300));
    const rows = block.split("\n").filter((l) => l.startsWith("- "));
    ok("  floor: the block really is a selection — fewer rows than the teammate has memories",
      rows.length > 0 && rows.length < mateMem.length, `${rows.length} rows from ${mateMem.length} memories`);
    ok("  it carries the memory the LENS is about", rows.some((r) => r.includes(RELEVANT)), block.slice(0, 500));
    ok("  and that memory is FIRST — the lens decides the order, not the round's boilerplate",
      (rows[0] || "").includes(RELEVANT), rows[0] || "(no rows)");
    ok("  the hunt-vocabulary decoy did not take the top slot",
      !!rows[0] && !rows[0].includes(BOILERPLATE), rows[0] || "(no rows)");

    // The deliverable block from the SAME prompt, which is the call this suite would otherwise leave
    // uncovered — and the one that still bites a company of one.
    const rag = prompts.flat().map((m) => String(m?.content || "")).filter((c) => /^Relevant existing company deliverables/.test(c));
    ok("  floor: a deliverable block was actually sent to the agent too", rag.length > 0,
      "no deliverable block among " + prompts.flat().length + " messages");
    const named = (rag[0] || "").split("\n").filter((l) => l.startsWith("### ")).map((l) => l.slice(4).trim());
    ok("  floor: it names documents, and fewer than the company holds",
      named.length > 0 && named.length < docs.length, JSON.stringify(named));
    ok("  the document the LENS is about is first among them",
      /version-figures/.test(named[0] || ""), JSON.stringify(named));
  }

  // -------------------------------------------------------------------------------------------
  // The second of the three rate-table funnels, after the boot one at the top: the model LATCH reports as
  // its paid provider, learned at run start via configuredPaidModel(). Asserted after the runs above have
  // happened, because that is when it is first knowable. (The third funnel — the model that actually served
  // a paid call — needs a funded agent and real paid routing, and is covered in units only.)
  console.log("\n# and a Latch-configured model with no rate table is announced at RUN START");
  {
    ok("floor: runs really happened on this server", /Bureau on http/.test(serverLog));
    ok("the model the stub advertises as its paid provider was warned about, by name",
      /PAID MODEL "stub-unrated-paid" HAS NO RATE TABLE/.test(serverLog),
      serverLog.split("\n").filter((l) => /PAID MODEL/.test(l)).join("\n") || "no PAID MODEL line in the log");
    // Once per model per process, across every run above — not once per run and not once per turn.
    ok("  and exactly once, across every run in this file",
      serverLog.split(/PAID MODEL "stub-unrated-paid"/).length - 1 === 1,
      String(serverLog.split(/PAID MODEL "stub-unrated-paid"/).length - 1) + " occurrences");
  }
} catch (e) {
  fail++;
  console.log("✗ the suite threw — " + (e?.stack || e));
  console.log("server log tail:\n" + serverLog.split("\n").slice(-20).join("\n"));
}

await done();
