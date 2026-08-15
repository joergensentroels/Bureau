// The model-facing action surface, derived from server.mjs. No assertions here — this is the half that
// two callers need, split out for the same reason `doc-figures.mjs` is split from `docs.test.mjs`.
//
// WHY IT IS NOT SIMPLY EXPORTED FROM `action-surface.test.mjs`. That file runs its 36 assertions at
// import time and sets `process.exitCode`, so importing it to read two numbers would execute the suite
// and let its verdict silently overwrite the verdict of whoever imported it. That is the same trap
// `docs.test.mjs` documents about importing `run-all.mjs`'s arrays. Measured, not assumed:
// `node -e "import('./test/action-surface.test.mjs')"` prints all 36 results and ALL PASS.
//
// Safe in the other direction: importing `server.mjs` boots nothing — it resolves to 152 exports and
// exits — which is what lets `reachable` be canonicalised by CALLING `normalizeAction` rather than by
// reading it. That distinction is not cosmetic. The `note` defect lived exactly in the gap between what
// the synonym table looks like it does and what the function does, and a checker that read the table
// instead of calling it would have reproduced the bug rather than caught it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAction, UNEXECUTED_ACTIONS } from "../server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const Q = String.fromCharCode(34);

// `src` is injectable so a caller can derive the surface of a MUTATED source without writing to disk;
// the default is the real file, which is what both real callers use.
export function deriveActionSurface(src = readFileSync(join(ROOT, "server.mjs"), "utf8")) {
  const SRC = src;

  // 1. The response schema enum: the alternatives in "actionType":"a"|"b"|...
  const enumStart = SRC.indexOf(Q + "actionType" + Q + ":");
  const fromEnum = SRC.slice(enumStart, SRC.indexOf(",'", enumStart)).split(Q).filter((s) => /^[a-z][a-z_]*$/.test(s));

  // 2. The prompt's action catalogue: the "- name: ..." doc lines. Parsed the same way systemPrompt's own hunt
  //    filter parses them, so a line this cannot see is also a line the review-round filter cannot see. Each doc
  //    line is one source line, so the promise the catalogue makes about an action is kept with its name.
  const docLines = new Map();
  for (const chunk of SRC.split(Q + "- ").slice(1)) {
    const line = chunk.split("\n")[0];
    const m = /^([a-z][a-z_]{2,}):/.exec(line);
    if (m && !docLines.has(m[1])) docLines.set(m[1], line);
  }
  const fromDocs = [...docLines.keys()];

  // 3. normalizeAction's synonym table: both the ALIASES the model might emit and the canonical TARGETS they
  //    resolve to. Aliases are included deliberately — a synonym list pointing at a type with no branch is the
  //    same defect wearing a different name, and it is the one nobody would think to look for.
  const normBody = SRC.slice(SRC.indexOf("export function normalizeAction"), SRC.indexOf("\n}", SRC.indexOf("export function normalizeAction")));
  const synTargets = [...new Set([...normBody.matchAll(/\bat = "([a-z_]+)"/g)].map((m) => m[1]))];
  const synAliases = [...new Set([...normBody.matchAll(/\[([^\]]*)\]\.includes\(at\)/g)]
    .flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])))];

  // 4. The dispatcher, in the two comparison forms the runner actually uses.
  //
  //    SCOPED to runAgentTask, and that is not tidiness. Unscoped, `actType === "email_draft"` matches inside
  //    requiresCeoAlways — the HARD FLOOR — and the checker would have called email_draft dispatched on the
  //    strength of the very line proving it needs a human it was never going to reach a branch for. The floor and
  //    the dispatcher ask about the same strings for opposite reasons; conflating them hides exactly this bug.
  const runStart = SRC.indexOf("async function runAgentTask");
  const catchAll = SRC.indexOf("cannot execute that action type yet");
  const RUN = SRC.slice(runStart, SRC.indexOf("\n}", catchAll));
  const after = (marker) => RUN.split(marker).slice(1).map((s) => s.split(Q)[0]);
  const dispatched = [...new Set([
    ...after("next.actionType || " + Q + Q + ") === " + Q),
    ...after("actType === " + Q),
  ])].filter((s) => /^[a-z][a-z_]*$/.test(s)).sort();

  const registered = Object.keys(UNEXECUTED_ACTIONS || {});

  // The fallback normalizeAction hands the dispatcher when it cannot make sense of a choice. Obtained by CALLING
  // it rather than by typing "other" here, so this keeps up with the function instead of with a memory.
  const fallback = normalizeAction({ type: "propose_action", actionType: "", title: "x", details: "y" }, "do a thing").actionType;

  const reachable = [...new Set([...fromEnum, ...fromDocs, ...synTargets, ...synAliases, fallback])].sort();

  return { SRC, Q, fromEnum, fromDocs, docLines, normBody, synTargets, synAliases,
           runStart, catchAll, RUN, dispatched, registered, fallback, reachable };
}
