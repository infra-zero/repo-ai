---
name: ai-loop-stop
description: |
  Stop this repo's ai-loop in this session — delete its recurring `/ai-loop`
  job, stop its `loop watch` Monitor, and mark the status file `stopped·user`.
  Use when the user says "stop the loop", "pause the loop", "kill the loop",
  or invokes `/ai-loop-stop`. Current repo only; never strips a claim label.
  GitHub only (`gh`) — not GitLab.
---

# ai-loop-stop

Stop the `ai-loop` running for **this repo** in this session. Every step is idempotent; a second run changes nothing and says so. `ai-loop`'s quiet stop (#124) runs Steps 1–2 below — this file is the one place they are written down.

**Current repo only.** `<root>` is the tick's `.env.root`, resolved from the working directory — never from `$ARGUMENTS`. Never touch another root's job or watcher.

```bash
npx @infrazero/repo-ai loop tick --json
```

Read-only. Keep `.env.root` as `<root>` and `.liveAgents` for Step 4. A halt or non-zero exit without `.env.root`: fall back to `git rev-parse --show-toplevel`.

## Step 1 — delete this repo's cron job

`CronList` (`ToolSearch` `select:CronList,CronDelete` if deferred), then `CronDelete` every job whose prompt is exactly `/ai-loop --root <root>`, **or** exactly `/ai-loop` (a bare job from an older version — it always ticks its own session's working directory). Leave a job with any other `--root`.

## Step 2 — stop this repo's watcher

`TaskStop` every running Monitor whose command is exactly `npx @infrazero/repo-ai loop watch --root <root>`. Leave watchers for other roots running.

## Step 3 — mark the status file

Skip when Steps 1–2 stopped nothing and line 1 already starts `stopped·`. Otherwise keep line 2 (suggested) and line 4 (changed), empty line 3 (next):

```bash
STATUS='<root>/.claude/ai-loop-status'
SUGGESTED=$(sed -n 2p "$STATUS" 2>/dev/null); CHANGED=$(sed -n 4p "$STATUS" 2>/dev/null)
mkdir -p '<root>/.claude'
printf '%s\n%s\n%s\n%s\n' 'stopped·user' "$SUGGESTED" '' "$CHANGED" > "$STATUS"
```

## Step 4 — report what is still in flight

**Never strip a claim label.** A background Workflow from this session may still finish and label its PR, and a dead agent's claim is reaped by the next tick after `staleMinutes`. List them, nothing more:

```bash
gh issue list --label ai-wip --state open --json number,title --jq '.[] | "#\(.number) ai-wip \(.title)"'
gh pr list --state open --json number,title,labels --jq '.[] | select([.labels[].name] | any(startswith("ai-reviewing-") or . == "ai-fixing")) | "#\(.number) \([.labels[].name | select(startswith("ai-reviewing-") or . == "ai-fixing")] | join(",")) \(.title)"'
```

Print one line — `Loop stopped for <root>: deleted N job(s), stopped N watcher(s).`, or `Loop already stopped for <root>.` when Steps 1–3 changed nothing — then `<liveAgents> live agents` and the in-flight lines, if any. End with `/ai-loop restarts it.`
