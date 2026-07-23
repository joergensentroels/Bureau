// Pure unit tests for standalone logic (no server, no Latch, no model). Imports the exported
// helpers from server.mjs directly.  run:  node test/units.test.mjs
import {
  ipv4Blocked, ipBlocked, normalizeAction, safeParse, ragTerms, expectsDeliverable,
  resolveReport, goalObjective, normKRs, cadenceMs, cleanPolicyWhen, htmlToText,
  ensureBudget, renderChecklist, validDeliverableName, rankDeliverables, workProduct,
  planObjective, normPlanItem, normSop, normSopSteps, sopObjective,
  rankByRelevance, recallSharedMemory,
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

console.log("# rankDeliverables — pure RAG keyword ranker (score >= 2, best first)");
{ const docs = [
    { name: "pricing.md", content: "our pricing tiers and competitor pricing comparison" },
    { name: "hello.md", content: "hi there, welcome" },
    { name: "market.md", content: "competitor pricing analysis of the market" } ];
  const r = rankDeliverables("competitor pricing analysis", docs, 3);
  chk("  only docs matching >=2 terms are returned", r.length === 2 && r.every((x) => x.name !== "hello.md"));
  chk("  best score first", r[0].name === "market.md");
  eq("  no query terms → []", rankDeliverables("the a of to", docs), []);
  eq("  excludeName is skipped", rankDeliverables("competitor pricing analysis", docs, 3, "market.md").map((x) => x.name), ["pricing.md"]);
  chk("  limit respected", rankDeliverables("competitor pricing analysis", docs, 1).length === 1); }

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

console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
