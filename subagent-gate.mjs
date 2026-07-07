#!/usr/bin/env node
// stop-subagent-fanout — turn "don't let the model spawn subagents unsupervised"
// from a note in a prompt into a rule Claude Code actually enforces.
//
// Wired as a PreToolUse hook on the subagent tools (Task / Agent / Workflow) in
// .claude/settings.json. Claude Code runs this script BEFORE any such tool call and
// obeys the JSON decision it prints on stdout.
//
// Behavior:
//   * Escape hatch: env SUBAGENT_GATE=allow  -> ALLOW. Pre-sanction a bounded fan-out
//     for an autonomous / unattended run. The model CANNOT set this itself: a hook
//     subprocess inherits the parent session's environment, not anything the model
//     can write from its own shell, so it can't self-approve.
//   * Otherwise -> ASK. Emit permissionDecision "ask" so Claude Code prompts the human
//     for THIS spawn. A fan-out of N subagents becomes N separate prompts, each
//     rejectable. In a headless / no-human session "ask" resolves to deny — the safe
//     default for an unattended run.
//
// Fail-open by design: any parse/read error exits 0 (allow) so a hiccup never wedges
// all subagent use. Known trade-off: a broken guard is a silent hole, not a locked door.
//
// Usage (as a hook): cat <PreToolUse-hook-json> | node subagent-gate.mjs --hook
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REASON =
  'Subagent spawn requires explicit approval. Broad, unsupervised fan-out burns usage and ' +
  'runs work you did not see. Approve this spawn, or deny it. To pre-sanction a bounded ' +
  'fan-out for an autonomous run, launch the session with SUBAGENT_GATE=allow.';

// Log next to this script regardless of the caller's working directory.
const LOG = join(dirname(fileURLToPath(import.meta.url)), '.subagent-gate.log');
const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'Workflow']);

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,       // "allow" | "ask" | "deny"
      permissionDecisionReason: reason,
    },
  }));
}

function audit(decision, tool, input) {
  try {
    const label = input && (input.subagent_type || input.description)
      ? `${input.subagent_type || '?'} — ${(input.description || '').slice(0, 80)}`
      : '';
    appendFileSync(LOG, `${new Date().toISOString()}\t${decision}\t${tool}\t${label}\n`);
  } catch { /* best-effort; a logging failure must never break the hook */ }
}

function main() {
  if (!process.argv.includes('--hook')) process.exit(0); // only meaningful as a hook

  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { process.exit(0); } // no stdin -> fail open

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }    // unparseable -> fail open

  const tool = payload.tool_name || '';
  // If the matcher is ever widened, only act on the real subagent tools; allow anything else.
  if (tool && !SUBAGENT_TOOLS.has(tool)) process.exit(0);

  const input = payload.tool_input || {};

  if (process.env.SUBAGENT_GATE === 'allow') {
    audit('allowed(env)', tool || 'Task', input);
    emit('allow', 'Pre-sanctioned via SUBAGENT_GATE=allow (bounded autonomous fan-out).');
    process.exit(0);
  }

  audit('asked', tool || 'Task', input);
  emit('ask', REASON);
  process.exit(0);
}

main();
