import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = process.env.STOP_SUBAGENT_FANOUT_ROOT ||
  dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(repoRoot, 'install.mjs');
const gate = join(repoRoot, 'subagent-gate.mjs');
const settingsName = join('.claude', 'settings.json');
const installedGateName = join('.claude', 'hooks', 'subagent-gate.mjs');
const tools = ['Task', 'Agent', 'Workflow'];
const matcher = 'Task|Agent|Workflow';
const hookCommand =
  'cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0; cat | node .claude/hooks/subagent-gate.mjs --hook';

const tempProjects = [];

afterEach(() => {
  for (const project of tempProjects.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

function createProject() {
  const project = mkdtempSync(join(tmpdir(), 'stop-subagent-fanout-'));
  tempProjects.push(project);
  return project;
}

function settingsPath(project) {
  return join(project, settingsName);
}

function installedGatePath(project) {
  return join(project, installedGateName);
}

function createGateFixture() {
  const root = createProject();
  const script = join(root, 'subagent-gate.mjs');
  copyFileSync(gate, script);
  return script;
}

function writeSettings(project, value) {
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(settingsPath(project), JSON.stringify(value, null, 2) + '\n');
}

function readSettings(project) {
  return JSON.parse(readFileSync(settingsPath(project), 'utf8'));
}

function runInstaller(project) {
  return spawnSync(process.execPath, [installer], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function runGate(script, input, { hook = true, gateValue } = {}) {
  const env = { ...process.env };
  delete env.SUBAGENT_GATE;
  if (gateValue !== undefined) env.SUBAGENT_GATE = gateValue;
  return spawnSync(process.execPath, [script, ...(hook ? ['--hook'] : [])], {
    input,
    encoding: 'utf8',
    env,
  });
}

function decision(result) {
  assert.equal(result.status, 0, result.stderr);
  if (!result.stdout) return undefined;
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

function hookEntry({ entryMatcher = matcher, command = hookCommand } = {}) {
  return {
    matcher: entryMatcher,
    hooks: [{ type: 'command', command }],
  };
}

function toolPayload(tool) {
  return JSON.stringify({
    tool_name: tool,
    tool_input: { subagent_type: 'general-purpose', description: `Review ${tool}` },
  });
}

test('fresh install copies the gate and wires every subagent tool', () => {
  const project = createProject();
  const result = runInstaller(project);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(installedGatePath(project), 'utf8'), readFileSync(gate, 'utf8'));
  assert.deepEqual(readSettings(project).hooks.PreToolUse, [hookEntry()]);
});

test('reinstall preserves a customized gate policy and leaves valid settings byte-for-byte unchanged', () => {
  const project = createProject();
  const customGate = readFileSync(gate, 'utf8').replace("emit('ask', REASON)", "emit('deny', REASON)");
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(installedGatePath(project), customGate);
  writeSettings(project, { hooks: { PreToolUse: [hookEntry()] }, custom: { keep: true } });
  const settingsBefore = readFileSync(settingsPath(project), 'utf8');

  assert.equal(decision(runGate(installedGatePath(project), toolPayload('Agent'))), 'deny');
  const result = runInstaller(project);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(installedGatePath(project), 'utf8'), customGate);
  assert.equal(readFileSync(settingsPath(project), 'utf8'), settingsBefore);
  assert.equal(decision(runGate(installedGatePath(project), toolPayload('Agent'))), 'deny');
});

test('running the installer twice is idempotent', () => {
  const project = createProject();
  const first = runInstaller(project);
  assert.equal(first.status, 0, first.stderr);
  const gateAfterFirst = readFileSync(installedGatePath(project), 'utf8');
  const settingsAfterFirst = readFileSync(settingsPath(project), 'utf8');

  const second = runInstaller(project);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(installedGatePath(project), 'utf8'), gateAfterFirst);
  assert.equal(readFileSync(settingsPath(project), 'utf8'), settingsAfterFirst);
});

test('an incomplete matcher does not suppress installation of the canonical hook', () => {
  const project = createProject();
  const existing = hookEntry({ entryMatcher: 'Task' });
  writeSettings(project, { hooks: { PreToolUse: [existing] } });

  const result = runInstaller(project);
  const entries = readSettings(project).hooks.PreToolUse;

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [existing, hookEntry()]);
});

test('a command without --hook does not count as effective wiring', () => {
  const project = createProject();
  const incompleteCommand = hookCommand.replace(' --hook', '');
  const existing = hookEntry({ command: incompleteCommand });
  writeSettings(project, { hooks: { PreToolUse: [existing] } });

  const result = runInstaller(project);
  const entries = readSettings(project).hooks.PreToolUse;

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [existing, hookEntry()]);
});

test('a filename-only command does not count as effective wiring', () => {
  const project = createProject();
  const existing = hookEntry({ command: 'node .claude/hooks/subagent-gate.mjs --hook' });
  writeSettings(project, { hooks: { PreToolUse: [existing] } });

  const result = runInstaller(project);
  const entries = readSettings(project).hooks.PreToolUse;

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [existing, hookEntry()]);
});

test('an exec-style args field does not count as effective wiring', () => {
  const project = createProject();
  const existing = { ...hookEntry(), hooks: [{ type: 'command', command: hookCommand, args: [] }] };
  writeSettings(project, { hooks: { PreToolUse: [existing] } });

  const result = runInstaller(project);
  const entries = readSettings(project).hooks.PreToolUse;

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [existing, hookEntry()]);
});

test('an asynchronous hook does not count as effective PreToolUse wiring', () => {
  const project = createProject();
  const existing = { ...hookEntry(), hooks: [{ type: 'command', command: hookCommand, async: true }] };
  writeSettings(project, { hooks: { PreToolUse: [existing] } });

  const result = runInstaller(project);
  const entries = readSettings(project).hooks.PreToolUse;

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [existing, hookEntry()]);
});

test('an asyncRewake hook does not count as effective PreToolUse wiring', () => {
  const project = createProject();
  const existing = { ...hookEntry(), hooks: [{ type: 'command', command: hookCommand, asyncRewake: true }] };
  writeSettings(project, { hooks: { PreToolUse: [existing] } });

  const result = runInstaller(project);
  const entries = readSettings(project).hooks.PreToolUse;

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [existing, hookEntry()]);
});

test('a PowerShell shell does not count as effective wiring for the POSIX command', () => {
  const project = createProject();
  const existing = { ...hookEntry(), hooks: [{ type: 'command', command: hookCommand, shell: 'powershell' }] };
  writeSettings(project, { hooks: { PreToolUse: [existing] } });

  const result = runInstaller(project);
  const entries = readSettings(project).hooks.PreToolUse;

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(entries, [existing, hookEntry()]);
});

test('an omitted matcher is recognized as match-all wiring', () => {
  const project = createProject();
  const existing = { hooks: [{ type: 'command', command: hookCommand }] };
  writeSettings(project, { hooks: { PreToolUse: [existing] } });
  const settingsBefore = readFileSync(settingsPath(project), 'utf8');

  const result = runInstaller(project);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(settingsPath(project), 'utf8'), settingsBefore);
});

test('a star matcher is recognized as match-all wiring', () => {
  const project = createProject();
  const existing = hookEntry({ entryMatcher: '*' });
  writeSettings(project, { hooks: { PreToolUse: [existing] } });
  const settingsBefore = readFileSync(settingsPath(project), 'utf8');

  const result = runInstaller(project);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(settingsPath(project), 'utf8'), settingsBefore);
});

test('invalid JSON fails before copying or rewriting project files', () => {
  const project = createProject();
  const invalidSettings = '{"hooks":';
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(settingsPath(project), invalidSettings);

  const result = runInstaller(project);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not valid JSON/);
  assert.equal(readFileSync(settingsPath(project), 'utf8'), invalidSettings);
  assert.equal(existsSync(installedGatePath(project)), false);
});

test('malformed hook structure fails before copying or rewriting project files', () => {
  const project = createProject();
  const malformedSettings = { hooks: { PreToolUse: { matcher } } };
  writeSettings(project, malformedSettings);
  const settingsBefore = readFileSync(settingsPath(project), 'utf8');

  const result = runInstaller(project);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PreToolUse must be an array/);
  assert.equal(readFileSync(settingsPath(project), 'utf8'), settingsBefore);
  assert.equal(existsSync(installedGatePath(project)), false);
});

test('the gate asks for every subagent trigger by default', () => {
  const script = createGateFixture();

  for (const tool of tools) {
    const result = runGate(script, toolPayload(tool));
    assert.equal(decision(result), 'ask', `${tool}: ${result.stderr}`);
  }
});

test('the environment override allows every subagent trigger', () => {
  const script = createGateFixture();

  for (const tool of tools) {
    const result = runGate(script, toolPayload(tool), { gateValue: 'allow' });
    assert.equal(decision(result), 'allow', `${tool}: ${result.stderr}`);
  }
});

test('unrelated tools pass through without a decision', () => {
  const script = createGateFixture();
  const result = runGate(script, toolPayload('Bash'));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('malformed hook JSON passes through without a decision', () => {
  const script = createGateFixture();
  const result = runGate(script, '{not-json');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('running the gate without --hook passes through without a decision', () => {
  const script = createGateFixture();
  const result = runGate(script, toolPayload('Agent'), { hook: false });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('README exports the environment override and the exact snippet reaches the gate', (t) => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  const snippet = readme.match(/```bash\r?\n(export SUBAGENT_GATE=allow)\r?\n```/);
  assert.ok(snippet, 'README must show an exported Bash assignment');

  const bashCandidates = process.platform === 'win32'
    ? [join(process.env.ProgramFiles || '', 'Git', 'usr', 'bin', 'bash.exe'), 'bash.exe']
    : ['bash'];
  const bash = bashCandidates.find(candidate => candidate === 'bash' || existsSync(candidate));
  if (!bash) {
    t.skip('Bash is unavailable in this environment');
    return;
  }

  const script = createGateFixture();
  const result = spawnSync(bash, ['-c', `${snippet[1]}\nnode ./subagent-gate.mjs --hook`], {
    cwd: dirname(script),
    input: toolPayload('Agent'),
    encoding: 'utf8',
    env: (() => {
      const env = { ...process.env };
      delete env.SUBAGENT_GATE;
      return env;
    })(),
  });

  assert.equal(decision(result), 'allow', result.stderr);
});
