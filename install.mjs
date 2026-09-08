#!/usr/bin/env node
// stop-subagent-fanout installer — vendors the gate into a project's .claude/hooks/
// and wires the PreToolUse hook into .claude/settings.json. Idempotent: run it twice
// and the second run changes nothing.
//
// Run from your PROJECT root (the repo you want the gate to guard):
//   node /path/to/stop-subagent-fanout/install.mjs
// or, if you dropped this folder into the project:
//   node stop-subagent-fanout/install.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
const MATCHER = 'Task|Agent|Workflow';
const SUBAGENT_TOOLS = ['Task', 'Agent', 'Workflow'];
const HOOK_CMD =
  'cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0; cat | node .claude/hooks/subagent-gate.mjs --hook';

const log = m => process.stdout.write(m + '\n');
const fail = m => { process.stderr.write('✗ ' + m + '\n'); process.exit(1); };

// Read and validate settings before changing anything in the target project.
const settingsPath = join(projectRoot, '.claude', 'settings.json');
let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch { fail('.claude/settings.json is not valid JSON — fix it, then re-run'); }
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  fail('.claude/settings.json must contain a JSON object');
}
if (!Object.hasOwn(settings, 'hooks')) settings.hooks = {};
if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
  fail('.claude/settings.json hooks must be a JSON object');
}
if (!Object.hasOwn(settings.hooks, 'PreToolUse')) settings.hooks.PreToolUse = [];
if (!Array.isArray(settings.hooks.PreToolUse)) {
  fail('.claude/settings.json hooks.PreToolUse must be an array');
}

// 1) copy the gate script into <project>/.claude/hooks/
const src = join(here, 'subagent-gate.mjs');
if (!existsSync(src)) fail('cannot find subagent-gate.mjs next to install.mjs');
const hooksDir = join(projectRoot, '.claude', 'hooks');
mkdirSync(hooksDir, { recursive: true });
const destination = join(hooksDir, 'subagent-gate.mjs');
if (existsSync(destination)) {
  log('• gate already exists at .claude/hooks/subagent-gate.mjs — left as is');
} else {
  copyFileSync(src, destination);
  log('✓ copied gate → .claude/hooks/subagent-gate.mjs');
}

// 2) merge the hook into <project>/.claude/settings.json (preserve anything already there)
function matcherCoversAllTools(matcher) {
  // Claude Code treats an omitted matcher and `*` as match-all hooks.
  if (matcher === undefined || matcher === '*') return true;
  if (typeof matcher !== 'string') return false;

  let pattern;
  try { pattern = new RegExp(matcher); }
  catch { return false; }

  return SUBAGENT_TOOLS.every(tool => {
    pattern.lastIndex = 0;
    return pattern.test(tool);
  });
}

function hasCanonicalCommand(hook) {
  const compatibleShell = hook &&
    (!Object.hasOwn(hook, 'shell') || hook.shell === 'bash');
  return hook && hook.type === 'command' &&
    typeof hook.command === 'string' && hook.command.trim() === HOOK_CMD &&
    compatibleShell && !Object.hasOwn(hook, 'args') &&
    hook.async !== true && hook.asyncRewake !== true;
}

const alreadyWired = settings.hooks.PreToolUse.some(entry =>
  entry && typeof entry === 'object' &&
  matcherCoversAllTools(entry.matcher) &&
  Array.isArray(entry.hooks) && entry.hooks.some(hasCanonicalCommand));

if (alreadyWired) {
  log('• hook already wired in .claude/settings.json — left as is');
} else {
  settings.hooks.PreToolUse.push({
    matcher: MATCHER,
    hooks: [{ type: 'command', command: HOOK_CMD }],
  });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log('✓ wired PreToolUse hook in .claude/settings.json');
}

log('\nDone. Restart Claude Code (or start a fresh session) and every configured subagent spawn follows the installed hook policy.');
