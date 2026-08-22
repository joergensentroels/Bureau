// How a round's repo actions divide up — the pure half, split out so it can be IMPORTED.
//
// Same reason test/action-surface.mjs is split from its suite, and doc-figures.mjs from docs.test.mjs:
// tools/attention.mjs prints a report and can call process.exit at import time, so a caller that imported
// it to reuse one function would run the whole report and possibly be killed by it. That is not a
// hypothetical — eval/attention-ab.mjs imported attention.mjs first and the report appeared in the middle
// of its own output.
//
// TWO MEASUREMENT TRAPS live here, both of which caught me by hand before this existed:
//
//   1. A SEARCH IS A read_repo. There is no separate action type. A search is a read_repo whose `url` is
//      `<file>:<term>|<term>`; a plain read is a bare `<file>`. Counting action types alone reports zero
//      searches, and the roadmap's own metric cannot be computed at all.
//
//   2. THE URL MUST BE NORMALISED TO THE FILE FIRST. Tallying raw urls treats `src/server.mjs` and
//      `src/server.mjs:signin|session` as two different files — which inflates the distinct-file count and
//      deflates concentration. Measured that way the last runs looked like 4-17% and the pathology looked
//      solved; normalised they are 24-64%, and the early ones 100%. One split(":") separates "solved" from
//      "still a third of every round".
export function classifyReads(urls) {
  const file = (u) => String(u).split(":")[0];
  const searches = urls.filter((u) => String(u).includes(":"));
  const reads = urls.filter((u) => !String(u).includes(":"));
  const searchByFile = {};
  for (const u of searches) searchByFile[file(u)] = (searchByFile[file(u)] || 0) + 1;
  const topSearch = searches.length ? Math.max(...Object.values(searchByFile)) : 0;
  return {
    searches: searches.length,
    reads: reads.length,
    files: new Set(urls.map(file)).size,
    topSearchFile: Object.entries(searchByFile).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
    topSearchCount: topSearch,
    // null rather than 0 when nothing was searched: a round that never searched has no concentration, and
    // reporting 0% would read as perfectly spread attention.
    concentration: searches.length ? topSearch / searches.length : null,
  };
}
