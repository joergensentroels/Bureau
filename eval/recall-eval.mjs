// Recall quality harness for shared-memory retrieval.
//
// Why this exists: a single query that "feels wrong" is a terrible reason to change a ranker. One
// paraphrase ("keeping servers healthy under heavy traffic") missed the entry a human would want, and
// the obvious reactions — weight the vectors higher, filter weak keyword hits, strip boilerplate before
// embedding — all turned out to make overall recall the same or WORSE. This harness is how that was
// established, and how to re-establish it after any change to rankByRelevance, the fusion, or the
// embedding model.
//
//   node eval/recall-eval.mjs
//
// Requires: Bureau running (default :4173) and an embedding model pulled. Read-only — it starts no runs,
// files no approvals, writes nothing. It scores against whatever is in the live corpus, so absolute
// numbers move as the company does real work; what matters is the RELATIVE ordering of variants in one
// run. Re-run it before and after a ranking change, in the same session, and compare.
//
// LABELS ARE JUDGEMENT, NOT GROUND TRUTH. Each is "the entry a person asking this would want". They were
// written by reading the corpus, and they encode one person's opinion of relevance. Twelve queries is a
// small set: treat a one-query difference as noise, and only act on gaps of several queries.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const PORT = process.env.BUREAU_PORT || 4173;
const B = `http://127.0.0.1:${PORT}`;
const EMBED_URL = (process.env.BUREAU_EMBED_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const EMBED_MODEL = process.env.BUREAU_EMBED_MODEL || "nomic-embed-text";
const HERE = path.dirname(fileURLToPath(import.meta.url));   // not URL.pathname: that is percent-encoded
const { rankByRelevance, cosine, objectiveSignature } = await import(pathToFileURL(path.join(HERE, "..", "server.mjs")).href);

const TOKEN = (() => { if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN.trim();
  try { const dir = process.env.LATCH_DATA || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data"); return JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).operatorToken || ""; } catch { return ""; } })();

const embed = async (input) => {
  const r = await fetch(`${EMBED_URL}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: EMBED_MODEL, input }) });
  if (!r.ok) throw new Error(`embedder returned ${r.status} — is '${EMBED_MODEL}' pulled?`);
  return new Float32Array((await r.json()).embeddings[0]);
};

// query -> pattern matching the objective of the entry that SHOULD surface.
const LABELS = [
  ["keeping servers healthy under heavy traffic", /monitoring, auto-scaling/i],
  ["picking what matters most next quarter", /single top priority for Q3/i],
  ["greeting a brand new client", /welcome note for a new customer|welcome email draft/i],
  ["saying thanks to someone who bought something", /thank-you note to Alex/i],
  ["why lists help you not forget steps", /why checklists are useful|defining a to-do list/i],
  ["shipping code automatically to a test environment", /CI\/CD pipelines/i],
  ["how we reward loyal buyers", /reward structures|reward tiers|tier descriptions/i],
  ["making the app pleasant to use", /customer dashboard frontend|intuitive tier descriptions/i],
  ["telling people about us through other channels", /marketing channels|announcement email/i],
  ["rules new staff must follow", /security guidelines and ethical standards|onboarding processes/i],
  ["storing files in the cloud cheaply", /cloud object storage/i],
  ["when each phase of the launch happens", /launch timeline/i],
];

// Weighted Reciprocal Rank Fusion — the shipped ranker is this with equal weights.
function fuse(lists, weights, limit = 3) {
  const acc = new Map();
  lists.forEach((list, li) => list.forEach((r, i) => {
    const k = r.item._key;
    const cur = acc.get(k) || { item: r.item, score: 0 };
    cur.score += (weights[li] || 1) / (60 + i + 1);
    acc.set(k, cur);
  }));
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
const weakLexDropped = (lex) => lex.filter((r) => r.score >= 0.4 * (lex[0]?.score || 0));

const VARIANTS = {
  "lexical only (what shipped before embeddings)": (lex, sem) => fuse([lex], [1]),
  "semantic only": (lex, sem) => fuse([sem], [1]),
  "RRF equal weights  <-- SHIPPED": (lex, sem) => fuse([lex, sem], [1, 1]),
  "RRF, semantic weighted 2x": (lex, sem) => fuse([lex, sem], [1, 2]),
  "RRF, semantic weighted 3x": (lex, sem) => fuse([lex, sem], [1, 3]),
  "RRF equal, weak lexical hits dropped": (lex, sem) => fuse([weakLexDropped(lex), sem], [1, 1]),
  "RRF 2x semantic, weak lexical dropped": (lex, sem) => fuse([weakLexDropped(lex), sem], [1, 2]),
};

(async () => {
  const org = await (await fetch(`${B}/api/org`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  if (!org?.agents) { console.error("could not read /api/org — is Bureau running and the token right?"); process.exit(2); }

  // Same pooling + de-duplication the server does, so we score what recall actually sees.
  const seen = new Map();
  for (const a of org.agents) for (const m of (a.memory || [])) {
    const sig = objectiveSignature(m.objective);
    const key = sig ? `${a.id}|${sig}` : `#${seen.size}`;
    const real = !!String(m.summary || "").trim() && !/^\(stopped/i.test(m.summary || "");
    const prev = seen.get(key);
    if (!prev || (real && !prev.real)) seen.set(key, { _key: key, who: a.name, objective: String(m.objective || ""), summary: String(m.summary || ""), real });
  }
  const docs = [...seen.values()];
  if (docs.length < 5) { console.error(`only ${docs.length} memory entries — too few to measure anything`); process.exit(2); }

  const vecs = new Map();
  for (const d of docs) vecs.set(d._key, await embed(`${d.objective}\n${d.summary}`.trim()));

  const score = {}, misses = {};
  for (const [q, want] of LABELS) {
    const qv = await embed(q);
    const lex = rankByRelevance(q, docs, (it) => `${it.objective} ${it.summary}`, 10);
    const sem = docs.map((it) => ({ item: it, score: cosine(qv, vecs.get(it._key)) }))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
    for (const [name, fn] of Object.entries(VARIANTS)) {
      const hit = fn(lex, sem).some((r) => want.test(r.item.objective));
      score[name] = (score[name] || 0) + (hit ? 1 : 0);
      if (!hit) (misses[name] = misses[name] || []).push(q);
    }
  }

  console.log(`\nrecall@3 over ${LABELS.length} labelled queries — corpus: ${docs.length} de-duplicated entries\n`);
  for (const [name, n] of Object.entries(score).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(2)}/${LABELS.length}  ${String(Math.round(100 * n / LABELS.length)).padStart(3)}%   ${name}`);
  const shipped = Object.keys(VARIANTS).find((k) => k.includes("SHIPPED"));
  console.log(`\n${shipped} misses: ${(misses[shipped] || []).map((q) => `"${q}"`).join(", ") || "none"}`);
  console.log("\nReminder: one-query differences are noise at this sample size. Act on gaps of several.");
})();
