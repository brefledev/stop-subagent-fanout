# stop-subagent-fanout

A Claude Code hook that makes the model ask before it spawns a subagent. One prompt per spawn, and you can refuse any of them.

Left alone, a model can decide to launch a batch of subagents on its own. Each one costs tokens, and each one does work you never watched happen. Telling it "ask me first" in `CLAUDE.md` or a system prompt is a suggestion — a fresh session or a confident model steps over it. This wires the rule to something that runs whether the model cooperates or not.

If the model tries to spawn eight subagents, you get eight prompts. In an unattended run, spawns are denied by default. One environment variable lets you pre-approve a run, and the model can't set that variable itself.

## If you'd rather DIY

The gate is one small script and one hook entry. If you'd rather have your own model write it, paste the description below, (and read what it produces before you trust it).

Paste this:

> Write a Claude Code `PreToolUse` hook script called `subagent-gate.mjs` — Node, no dependencies — for the `Task`, `Agent`, and `Workflow` tools. It reads the hook JSON from stdin. Default: print a permission decision of `ask` so Claude Code prompts me before each subagent spawn. If the environment variable `SUBAGENT_GATE=allow` is set, print `allow` and skip the prompt. On any missing input or JSON parse error, exit 0 so a broken hook never wedges my tools. Append every decision to a `.subagent-gate.log` beside the script. Then wire the matching `PreToolUse` hook — matcher `Task|Agent|Workflow` — into `.claude/settings.json`, leaving my existing hooks in place.

You get the same behavior this repo ships.

## "haha tokens go brrrr"

A prompt-level rule lives in the model's context, which means the model decides whether to follow it. It drops that decision in predictable places: a new session that never read your note, a long context where the instruction fell off the back, a model that's convinced the swarm is a good idea. When the model ignores the rule, nothing errors. It spawns, the work runs, and you find out reading the transcript afterward.

Claude Code hooks run outside the model. A hook fires on the tool call no matter what the model intended, so the rule stands even when the model has forgotten it.

## Out of the prompt, into a hook

Claude Code runs a `PreToolUse` hook before any tool call. Spawning a subagent is a tool call — the `Task`/`Agent` tool, plus `Workflow` if you use workflows. The hook does three things:

1. Matches those tool names.
2. Pipes the pending call's JSON into `subagent-gate.mjs`.
3. Reads a decision the script prints back.

The script returns one of three decisions:

| Decision | What happens |
| --- | --- |
| `ask` | Claude Code stops and asks you to approve or deny this spawn. The default. |
| `allow` | The spawn runs with no prompt. Only when the override is set. |
| `deny` | The spawn is blocked. This is what `ask` becomes in a run with no human to answer. |

By default the script returns `ask` every time. A fan-out of ten subagents becomes ten separate prompts — approve the two you meant, refuse the other eight.

Refusing a spawn doesn't break the turn. Claude Code hands the model the reason and skips the tool call. The model carries on from there — usually doing the work itself in the main thread, or asking what you'd rather it do.

### Letting the swarm through (on purpose)

Set one environment variable when you launch the session:

```bash
SUBAGENT_GATE=allow
```

With it set, the script returns `allow` and skips the prompt — for when you've decided a bounded fan-out is worth it and you're watching the run.

The model can't set this on its own. The hook runs as a subprocess that reads the parent session's environment. A shell command the model issues sets variables in a different child process the hook never sees, so `SUBAGENT_GATE=allow` from inside the model's own shell goes nowhere. The person who starts the session controls it, and only that person.

None of this stops a model that can edit files. It could rewrite the gate to always allow, or pull the hook out of `settings.json` — the guard assumes an over-eager model prone to spawning without asking, and does nothing against one that sets out to disable the guard itself.

### When it breaks, it breaks toward "yes"

If the script hits a read or parse error — no input, malformed JSON — it exits 0 with no decision, which Claude Code reads as allow. A broken or missing dependency won't lock you out of subagents. That's a deliberate trade: a failed guard shouldn't cost you all subagent use. Treat it as a supervision gate for usage and oversight; don't lean on it as a security boundary. If you'd rather it deny on failure, change the exit-0 lines to emit `deny`.

### The paper trail

Every decision gets appended to `.subagent-gate.log`, next to the script:

```
2026-07-07T18:22:04.113Z	asked	Task	general-purpose — Research the auth flow
2026-07-07T18:25:31.900Z	allowed(env)	Workflow	— review-changes
```

It's git-ignored here. In your own project, add `.subagent-gate.log` to your ignore if you don't want it tracked. Delete it anytime.

## Things you need to already own

- **Node.js 18 or newer.** The script uses only built-in modules — no `npm install`, no dependencies, no build step.
- **Claude Code** with hook support.
- A shell to run the hook command. The example uses POSIX syntax (`cat |`, `$CLAUDE_PROJECT_DIR`); on Windows, Claude Code runs hook commands through Git Bash if it's installed, so the same line works.

Nothing to compile.

## Installation, such as it is

**The lazy way.** Run the installer from the project you want to guard, pointing at wherever you cloned this repo:

```bash
node /path/to/stop-subagent-fanout/install.mjs
```

It copies the gate to `.claude/hooks/subagent-gate.mjs` and wires the `PreToolUse` hook in `.claude/settings.json`, leaving any hooks you already have in place. Run it a second time and it changes nothing. Restart Claude Code and every subagent spawn asks you first.

**By hand.** If you'd rather see exactly what changes:

1. Copy `subagent-gate.mjs` into your repo — `.claude/hooks/subagent-gate.mjs` is the tidy spot, but anywhere works.
2. Merge the block from [`settings.example.json`](./settings.example.json) into `.claude/settings.json`, or create the file:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Task|Agent|Workflow",
           "hooks": [
             {
               "type": "command",
               "command": "cd \"$CLAUDE_PROJECT_DIR\" 2>/dev/null || exit 0; cat | node .claude/hooks/subagent-gate.mjs --hook"
             }
           ]
         }
       ]
     }
   }
   ```

   Match the path after `node` to wherever you put the script. Drop `Workflow` from the matcher if you don't use workflows.

3. Reload Claude Code or start a fresh session.

**Commit the hook.** `.claude/hooks/subagent-gate.mjs` and the `settings.json` block belong in git — that's how the guard reaches anyone who clones the repo, and how it survives a fresh checkout. Gitignore only `.subagent-gate.log`, the log the script writes as it runs.

## Confirm it isn't lying to you

Ask the model to spawn a subagent — "use a subagent to list the files in this directory." You should get an approval prompt before anything runs. Deny it, and the spawn shouldn't happen. The `.subagent-gate.log` file will show an `asked` line.

To check the override: launch with `SUBAGENT_GATE=allow` in the environment and try again. The spawn should run with no prompt and log an `allowed(env)` line.

## Fiddly bits

- **Which tools get gated:** edit the `matcher` regex in the hook and the `SUBAGENT_TOOLS` set in the script. Keep the two in sync.
- **The prompt text:** edit the `REASON` string.
- **Block instead of ask:** change the fail-open `process.exit(0)` calls and the default `emit('ask', ...)` to `emit('deny', ...)`.
- **The variable name:** change `SUBAGENT_GATE` in the script.

## The legal footnote

MIT. Use it, fork it, strip the comments, whatever.
