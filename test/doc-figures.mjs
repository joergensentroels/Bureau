// Figures claimed in the documents, checked against what a real run produces.
//
// WHY. Every count in this repo's docs has been wrong at least once, and always the same way: the number
// was true when it was typed and nothing ever re-read it. ROADMAP said "636 headless assertions across 7
// suites" while a run produced more than twice that across eighteen; test/README said "292 in all" and
// listed nine suites that no longer existed. Nobody was careless — prose is simply never re-executed, so
// there is no moment at which a stale figure is discovered. TESTING.md already records the general form
// of this ("a documented limitation is a claim, and claims go stale"); this is the mechanical version.
//
// HOW. A figure that must stay true carries a marker naming what it counts:
//
//     <!--fig:assertions-->1,707 headless assertions across <!--fig:suites-->18 suites
//
// The marker is an HTML comment, so it renders as nothing — the reader sees the sentence, the checker
// sees the claim. Markers are used rather than pattern-matching English on purpose: TESTING.md is a
// narrative that legitimately records what the suite counted at earlier commits ("792 unit assertions",
// "852 assertions"), and a checker that could not tell a dated record from a live claim would either
// rewrite history or be switched off.
//
// WHERE EACH FIGURE IS SETTLED. Two different costs, so two different places:
//   - suite counts are derivable from `run-all.mjs`'s own arrays, statically → checked by docs.test.mjs
//     in the pure set, on every run, for free;
//   - assertion counts need the suites to actually run → checked by run-all.mjs itself, after the run,
//     from the summaries it already parses. NOT from inside a suite: spawning the runner from a suite it
//     spawns does not terminate, which is the trap 4water's test/docs.test.mjs documents rather than
//     stepping into.
//
// AND IT CONTROLS ITSELF. A checker that quietly stopped discriminating would print the same clean bill
// of health as one that works, so `selfTestProblems()` runs on every invocation: it re-checks the same
// sources against a deliberately WRONG observation and requires a complaint for every key. If the
// comparison is pinned true, the marker syntax drifts, or a doc stops carrying claims, that fires — the
// empty set is a subset of everything, and "no claims found" must never read the same as "all correct".

// The figures a document may pin. Adding a key here without claiming it somewhere is itself reported:
// a key nobody states is a figure nobody is checking.
export const FIG_KEYS = ["assertions", "suites", "pure-assertions", "pure-suites", "server-assertions", "server-suites"];

// Documents scanned for claims. A doc absent from this list is unchecked, which is why the list is short
// and the required floor below is not empty.
export const FIGURE_DOCS = ["README.md", "ROADMAP.md", "TESTING.md", "test/README.md"];

// The floor, not a ceiling: these must each carry at least one claim. Without it, deleting every marker
// would make this file pass perfectly while checking nothing — the failure mode it exists to prevent.
export const REQUIRED_DOCS = ["ROADMAP.md", "test/README.md"];

const MARKER = /<!--fig:([a-z-]+)-->\s*\**\s*([\d][\d,]*)/g;

// Every claim in one document, in order. `raw` is what the reader sees, for a message that says where to look.
export function extractClaims(text) {
  const out = [];
  for (const m of String(text || "").matchAll(MARKER)) {
    out.push({ key: m[1], value: Number(m[2].replace(/,/g, "")), raw: m[0] });
  }
  return out;
}

// Any marker whose key is not in FIG_KEYS — a typo in a marker is silent otherwise, and a silent marker
// is a figure that reads as pinned and is not.
export function unknownKeys(claims) {
  return [...new Set(claims.filter((c) => !FIG_KEYS.includes(c.key)).map((c) => c.key))];
}

const fmt = (n) => n.toLocaleString("en-US");

// sources: [{ file, text }].  observed: { key: number } for the keys this caller can actually settle.
// Only keys present in `observed` are compared, so run-all can check assertions while the pure suite
// checks suite counts, and neither pretends to have settled the other's.
export function compare(observed, sources) {
  const problems = [];
  const claimed = new Map();          // key -> [{file, value}]
  for (const { file, text } of sources) {
    const claims = extractClaims(text);
    for (const bad of unknownKeys(claims)) problems.push(`${file}: <!--fig:${bad}--> is not a known figure key (${FIG_KEYS.join(", ")})`);
    for (const c of claims) {
      if (!FIG_KEYS.includes(c.key)) continue;
      if (!claimed.has(c.key)) claimed.set(c.key, []);
      claimed.get(c.key).push({ file, value: c.value });
      if (Object.hasOwn(observed, c.key) && c.value !== observed[c.key]) {
        problems.push(`${file}: claims ${fmt(c.value)} for "${c.key}", a real run produced ${fmt(observed[c.key])} — write "<!--fig:${c.key}-->${fmt(observed[c.key])}"`);
      }
    }
  }
  // Two claims about the same key that disagree with each other are wrong even if this caller cannot
  // settle which is right.
  for (const [key, list] of claimed) {
    const distinct = [...new Set(list.map((l) => l.value))];
    if (distinct.length > 1) problems.push(`"${key}" is claimed as ${distinct.map(fmt).join(" and ")} in different documents (${list.map((l) => l.file).join(", ")})`);
  }
  return { problems, claimed };
}

// The full check, including the reasons a clean result would be worthless.
export function checkDocFigures(observed, sources) {
  const problems = [];

  // A source that could not be read is not a source with no claims.
  for (const s of sources) {
    if (typeof s.text !== "string" || s.text.length === 0) problems.push(`${s.file}: unreadable or empty — this check cannot pass on a document it did not read`);
  }
  for (const req of REQUIRED_DOCS) {
    if (!sources.some((s) => s.file === req)) problems.push(`${req} was not scanned, and it is on the required list`);
  }

  const { problems: cmp, claimed } = compare(observed, sources);
  problems.push(...cmp);

  for (const req of REQUIRED_DOCS) {
    const src = sources.find((s) => s.file === req);
    if (src && extractClaims(src.text).length === 0) problems.push(`${req} carries no <!--fig:…--> claim at all — a document that pins nothing cannot go stale, and cannot be checked either`);
  }
  // Every key this caller CAN settle must be claimed somewhere, or it is silently unchecked.
  for (const key of Object.keys(observed)) {
    if (!claimed.has(key)) problems.push(`nothing claims "${key}" (a real run produced ${fmt(observed[key])}) — either state it with <!--fig:${key}--> or drop it from the observation`);
  }

  problems.push(...selfTestProblems(observed, sources));
  return problems;
}

// The negative control, run every time. Perturb each observed figure and require the comparison to
// notice — separately per key, so one loud key cannot cover for a key nobody states.
//
// The perturbation must not land on a value some document already claims, or the control tests nothing.
// That is not hypothetical: with the docs claiming 20 and a run producing 19, a naive +1 perturbation is
// 20, the comparison agrees with the document, and this reported the checker as blind on the one run
// where it was working perfectly. Found by reading a self-test that fired next to a real failure it had
// no business commenting on.
export function selfTestProblems(observed, sources) {
  const out = [];
  const { claimed } = compare({}, sources);
  for (const key of Object.keys(observed)) {
    const taken = new Set((claimed.get(key) || []).map((c) => c.value));
    let wrongVal = observed[key] + 1;
    while (taken.has(wrongVal)) wrongVal++;
    const named = compare({ [key]: wrongVal }, sources).problems.filter((p) => p.includes(`"${key}"`));
    if (!named.length) out.push(`SELF-TEST: a wrong value for "${key}" produced no complaint, so this checker is not discriminating on it — a clean result on "${key}" would mean nothing`);
  }
  return out;
}
