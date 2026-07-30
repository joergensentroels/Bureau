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
  chunkDocument, deliverableChunks,
} from "../server.mjs";

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

// makeSemaphore is async, so run it in a top-level await block before the summary prints.
await (async () => {
  console.log("# makeSemaphore — bounded async concurrency (parallel delegation primitive)");
  const sem = makeSemaphore(3);
  let active = 0, peak = 0, done = 0;
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => sem(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--; done++; return i * 2;
  })));
  chk("  caps concurrency at max (1 <= peak <= 3)", peak >= 1 && peak <= 3);
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

console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
