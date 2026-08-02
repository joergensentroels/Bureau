// The MCP surface must never be able to DECIDE an approval.
//
//   start:  BUREAU_PORT=4174 node server.mjs
//   run:    BUREAU_PORT=4174 node test/mcp-floor.test.mjs
//
// This guards a breach that is easy to introduce because it looks like a feature. While scoping MCP
// elicitation (ROADMAP item 3), the obvious shortcut was "expose pending_approvals + decide_approval as
// tools, so an MCP client can surface and decide what needs a human". It reads as equivalent to deciding in
// Latch. It is not:
//
//   **MCP tools are invoked by the MODEL, not by the human.**
//
// So a `decide_approval` tool hands an LLM the power to approve a hard-floored `shell` — the precise
// escalation `mcp_call` is hard-floored to prevent, inverted and handed back. Bureau holds the operator
// token, which is what makes it load-bearing rather than theoretical.
//
// Elicitation is interesting exactly because it routes to the USER rather than the model, which is why it
// is the only MCP-native way to do this — and why it needs a long-lived call Bureau does not currently have.
//
// The tool list is pinned EXACTLY rather than pattern-matched on suspicious names. A name-based check
// ("nothing containing 'approve'") is a substring test, and this repo has been bitten repeatedly by
// substrings standing in for meaning — `"read_file".includes("file")` cost a whole debugging session. An
// exact list means adding any tool trips this test, which forces the question to be answered deliberately.
const PORT = process.env.BUREAU_PORT || 4174;
const B = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.OPERATOR_TOKEN ? process.env.OPERATOR_TOKEN.trim() : await (async () => {
  const { readFileSync } = await import("node:fs");
  const os = await import("node:os"); const path = await import("node:path");
  try {
    const dir = process.env.LATCH_DATA || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data");
    return JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8")).operatorToken || "";
  } catch { return ""; }
})();

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  :: " + detail : ""}`); }
};
const rpc = async (method, params) => {
  const r = await fetch(`${B}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The exact surface, as of 2026-08-02. Changing this list is the point: it should require a decision.
const ALLOWED = ["list_agents", "list_sops", "run_sop", "start_run", "search_memory", "list_deliverables", "read_deliverable"].sort();

const list = await rpc("tools/list", {});
ok("tools/list answers", list.status === 200 && Array.isArray(list.body?.result?.tools), `status ${list.status}`);
const names = (list.body?.result?.tools || []).map((t) => t.name).sort();

ok(`the MCP surface is exactly the ${ALLOWED.length} known tools`,
  JSON.stringify(names) === JSON.stringify(ALLOWED),
  `got ${JSON.stringify(names)}`);
ok("no tool grants an approval decision — the floor is not reachable from MCP",
  !names.some((n) => ALLOWED.indexOf(n) === -1),
  names.filter((n) => ALLOWED.indexOf(n) === -1).join(", "));

// And the decision endpoint must not be reachable as a tool by any name: calling one that does not exist
// has to fail rather than fall through to something.
for (const invented of ["decide_approval", "approve", "approve_action", "decide"]) {
  const r = await rpc("tools/call", { name: invented, arguments: {} });
  const refused = r.body?.error || /unknown tool|not found|no such/i.test(JSON.stringify(r.body || {}));
  ok(`tools/call "${invented}" is refused, not silently dispatched`, Boolean(refused), JSON.stringify(r.body).slice(0, 120));
}

// Reads are fine; the point is only that DECIDING is not a tool. Prove the surface still works, so this
// file cannot pass by the server being broken.
const agents = await rpc("tools/call", { name: "list_agents", arguments: {} });
ok("a read tool still works (this test is not passing because MCP is down)",
  agents.status === 200 && !agents.body?.error, JSON.stringify(agents.body).slice(0, 120));

console.log(fail ? `\nFAILURES — ${pass} passed, ${fail} failed` : `\nALL PASS ✓ — ${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
