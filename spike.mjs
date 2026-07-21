#!/usr/bin/env node
// Foreman — Phase 0 spike.
//
// Goal: FEEL the core loop before building any UI.
//   A persona-driven agent, orchestrated by this Node "brain", takes an objective,
//   reasons via Latch's LLM, proposes REAL actions, and every action is gated through
//   Latch's approval model — with YOU as the CEO who approves or denies.
//
// It talks to a running Latch host (local qwen3, no external key) for two things only:
//   1. LLM turns      -> POST /api/llm/chat
//   2. Gated actions  -> POST /api/approvals   (files a pending approval)
//                        PATCH /api/approvals/:id  (you decide, as operator/CEO)
//
// No dependencies. Node built-ins only (matches Latch's house rule).
//
// Usage:
//   node spike.mjs                          # interactive; asks for the objective
//   node spike.mjs --objective "..."        # give the objective up front
//   node spike.mjs --agent rex --turns 6    # pick a persona, cap the turn budget
//   node spike.mjs --auto                   # auto-approve every action (hands-off test)
//
// Env:
//   LATCH_URL       default http://127.0.0.1:8787
//   OPERATOR_TOKEN  overrides the token read from Latch's data/auth.json
//   LATCH_DATA      path to Latch's data dir (to find auth.json)

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ---------- config ----------------------------------------------------------

const LATCH_URL = (process.env.LATCH_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const DEFAULT_DATA_DIR = process.env.LATCH_DATA
  || path.join(os.homedir(), "Documents", "LLM server", "openclaw-command-center", "data");

const args = parseArgs(process.argv.slice(2));
const MAX_TURNS = clampInt(args.turns, 1, 30, 8);
const AUTO = Boolean(args.auto);

// A "personality" is, for now, just a role + a voice. This is the seed of the
// hiring/persona system — later it also carries tool scope, budget and traits.
const AGENTS = {
  ada: {
    name: "Ada",
    role: "Research Assistant",
    voice:
      "You are meticulous, calm and concise. You think before acting and you flag "
      + "uncertainty honestly rather than bluffing.",
  },
  rex: {
    name: "Rex",
    role: "Operations Engineer",
    voice:
      "You are blunt, action-oriented and pragmatic. You prefer the smallest concrete "
      + "step that makes progress, and you say plainly when something is a bad idea.",
  },
};
const agent = AGENTS[(args.agent || "ada").toLowerCase()] || AGENTS.ada;

// ---------- the protocol the agent must speak --------------------------------

function systemPrompt(objective) {
  return [
    `You are ${agent.name}, a ${agent.role} employed at the operator's company.`,
    agent.voice,
    "",
    "The human you report to is the CEO. You do NOT have direct access to any real",
    "system, credential or tool. To DO anything in the real world you must PROPOSE an",
    "action; the CEO reviews it and approves or denies. This is a hard rule: you never",
    "assume an action happened until you are told its result.",
    "",
    `Your current objective from the CEO: "${objective}"`,
    "",
    "On every turn respond with STRICT JSON only — no prose, no code fences — matching:",
    "{",
    '  "thought": "one short sentence of private reasoning",',
    '  "speak": "what you say to the CEO, in your own voice (1-3 sentences)",',
    '  "next": {',
    '     "type": "propose_action" | "finish",',
    '     // when type = "propose_action":',
    '     "actionType": "web_research" | "email_draft" | "note" | "shell" | "other",',
    '     "title": "short imperative title of the action",',
    '     "details": "what exactly you want to do and why (the CEO reads this)",',
    '     "command": "optional: the exact command/query/text, if applicable",',
    '     // when type = "finish":',
    '     "summary": "what was accomplished / where things stand"',
    "  }",
    "}",
    "",
    "Propose ONE action at a time. Prefer the smallest useful step. When the objective is",
    "met (or blocked pending the CEO), use type \"finish\".",
  ].join("\n");
}

// ---------- Latch client -----------------------------------------------------

async function loadToken() {
  if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN.trim();
  const authPath = path.join(DEFAULT_DATA_DIR, "auth.json");
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.operatorToken) return parsed.operatorToken;
  } catch (err) {
    fail(
      `Could not read the operator token from ${authPath}\n` +
      `  (${err.message})\n` +
      `Set OPERATOR_TOKEN env, or LATCH_DATA to Latch's data dir.`
    );
  }
  fail(`No operatorToken found in ${authPath}.`);
}

let TOKEN; // set in main(); never logged.

async function latch(method, route, body) {
  let res;
  try {
    res = await fetch(`${LATCH_URL}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${TOKEN}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    fail(`Cannot reach Latch at ${LATCH_URL} (${err.message}).\nIs the host running? (Start-CommandCenter.ps1)`);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function askLlm(messages) {
  const { status, json } = await latch("POST", "/api/llm/chat", {
    messages,
    routingPreference: "local", // local qwen3, credentials never leave the host
    temperature: 0.3,
    maxTokens: 700,
  });
  if (json && json.ok && typeof json.text === "string") return json.text;
  const why = json?.error || json?.message || `status ${status}`;
  fail(
    `Latch LLM call failed: ${why}\n` +
    `Make sure a local model is configured/enabled (LLM-PROVIDER.md, /api/llm/config).`
  );
}

async function fileApproval(action) {
  const { status, json } = await latch("POST", "/api/approvals", {
    type: mapActionType(action.actionType),
    title: action.title || "Action requested",
    details: action.details || "",
    command: action.command || "",
    riskLevel: action.actionType === "shell" ? "high" : "medium",
    contextTags: ["foreman", `agent:${agent.name.toLowerCase()}`],
  });
  if (status !== 201 && status !== 200) {
    fail(`Filing the approval failed (status ${status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json; // { id, status, ... }
}

async function decide(approvalId, status, note) {
  await latch("PATCH", `/api/approvals/${approvalId}`, { status, note: note || "" });
}

// Latch validates the type against a fixed list and silently falls back to "other".
// We keep a couple of real ones so the spike exercises real branches when configured.
function mapActionType(t) {
  switch (t) {
    case "email_draft": return "external_contact";
    case "shell": return "other";      // real shell needs the worker VM; "other" keeps the spike self-contained
    case "web_research": return "other";
    case "note": return "context_question";
    default: return "other";
  }
}

// ---------- the loop ---------------------------------------------------------

async function main() {
  TOKEN = await loadToken();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const objective = (args.objective || (await rl.question(
    `\n${bold("Foreman — Phase 0 spike")}\n` +
    `Employee on duty: ${bold(agent.name)} (${agent.role})\n` +
    `Turn budget: ${MAX_TURNS}${AUTO ? "   [auto-approve ON]" : ""}\n\n` +
    `${bold("CEO, what is the objective?")} > `
  ))).trim();

  if (!objective) { rl.close(); fail("No objective given."); }

  line();
  say(`Objective set: ${objective}`, "🎯 CEO");
  line();

  const history = [{ role: "system", content: systemPrompt(objective) }];
  let tokensSpent = 0; // rough seed of the "economy" meter

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const raw = await askLlm(history);
    tokensSpent += estimateTokens(history) + estimateTokens([{ content: raw }]);

    const parsed = safeParse(raw);
    if (!parsed) {
      history.push({ role: "assistant", content: raw });
      history.push({ role: "user", content: "That was not valid JSON. Reply again with STRICT JSON only, matching the schema." });
      continue;
    }
    history.push({ role: "assistant", content: JSON.stringify(parsed) });

    say(parsed.speak || "(…)", `👤 ${agent.name} · turn ${turn}/${MAX_TURNS}`);
    const next = parsed.next || {};

    if (next.type === "finish") {
      line();
      say(next.summary || "Done.", "✅ FINISHED");
      break;
    }

    // propose_action -> real Latch approval gate
    const approval = await fileApproval(next);
    approvalCard(next, approval);

    const verdict = await getVerdict(rl, next);
    await decide(approval.id, verdict.status, verdict.note);

    if (verdict.status === "approved") {
      const result = verdict.note?.trim()
        ? `CEO APPROVED. Result reported by CEO: ${verdict.note.trim()}`
        : `CEO APPROVED and the action was carried out. (No extra result provided.)`;
      say(dim(result), "🔓");
      history.push({ role: "user", content: result });
    } else {
      const result = `CEO DENIED this action.${verdict.note?.trim() ? " Reason: " + verdict.note.trim() : ""} Choose a different approach or finish.`;
      say(dim(result), "⛔");
      history.push({ role: "user", content: result });
    }

    if (turn === MAX_TURNS) {
      line();
      say("Turn budget exhausted — stopping. (Raise it with --turns N.)", "⏳ BUDGET");
    }
  }

  rl.close();
  line();
  console.log(`${bold("Run complete.")}  approx tokens spent: ${tokensSpent}  ·  (this is the seed of the budget/economy meter)`);
  line();
}

// ---------- operator interaction --------------------------------------------

async function getVerdict(rl, action) {
  if (AUTO) {
    console.log(dim("   [auto] approved"));
    return { status: "approved", note: "" };
  }
  if (!stdin.isTTY) {
    // Non-interactive without --auto: don't silently act. Default to approve but say so loudly.
    console.log(dim("   [no TTY, no --auto] defaulting to approve"));
    return { status: "approved", note: "" };
  }
  for (;;) {
    const ans = (await rl.question(`   ${bold("CEO decision")} — [a]pprove / [d]eny / [r]esult+approve > `)).trim().toLowerCase();
    if (ans === "a" || ans === "approve" || ans === "y" || ans === "") return { status: "approved", note: "" };
    if (ans === "d" || ans === "deny" || ans === "n") {
      const why = await rl.question("   reason (optional) > ");
      return { status: "denied", note: why };
    }
    if (ans === "r" || ans === "result") {
      const note = await rl.question("   paste the real-world result to hand back > ");
      return { status: "approved", note };
    }
    console.log(dim("   (type a, d, or r)"));
  }
}

// ---------- presentation -----------------------------------------------------

function approvalCard(action, approval) {
  console.log("");
  console.log(`  ┌─ 🔒 ${bold("PENDING APPROVAL")}  ·  ${approval.status}  ·  id ${approval.id}`);
  console.log(`  │  ${bold(action.title || "(untitled)")}   [${action.actionType || "other"}]`);
  wrap(action.details || "", "  │  ").forEach((l) => console.log(l));
  if (action.command) console.log(`  │  $ ${action.command}`);
  console.log(`  └─ waiting on the CEO…`);
}

function say(text, who) {
  console.log(`\n${bold(who)}`);
  wrap(text, "   ").forEach((l) => console.log(l));
}
function line() { console.log("\n" + "─".repeat(64)); }
function wrap(text, prefix) {
  const words = String(text).split(/\s+/);
  const out = [];
  let cur = prefix;
  for (const w of words) {
    if ((cur + w).length > 76) { out.push(cur); cur = prefix + w + " "; }
    else cur += w + " ";
  }
  if (cur.trim()) out.push(cur.replace(/\s+$/, ""));
  return out.length ? out : [prefix];
}
const useColor = stdout.isTTY;
function bold(s) { return useColor ? `\x1b[1m${s}\x1b[0m` : s; }
function dim(s) { return useColor ? `\x1b[2m${s}\x1b[0m` : s; }

// ---------- helpers ----------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") out.auto = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
function estimateTokens(messages) {
  return Math.ceil(messages.reduce((n, m) => n + String(m.content || "").length, 0) / 4);
}
// qwen3 & friends sometimes wrap JSON in prose/fences. Grab the outermost {...}.
function safeParse(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}
function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

main().catch((err) => fail(err?.stack || String(err)));
