---
title: Getting started
description: Zero to a first merged and released PR — the bot account, config, Claude Code allow rules and sandbox, repo prerequisites, labels, stopping, merging and releasing.
---

# Getting started

Everything below gets a new repo from nothing to a first PR the loop has
implemented, reviewed and handed to you to merge. It's the practical
walkthrough; [The AI Loop](./ai-loop.md) is the reference for how the pipeline
itself works, and [Risks and responsibilities](./risks.md) is what you're
accepting by running it.

:::warning

**Costs and liability.** repo-ai runs AI agents unattended, and they spend your
Anthropic credits or plan limits and your GitHub Actions minutes. Read the full
[Risks and responsibilities](./risks.md) before continuing.

:::

## 0. Prerequisites

- **Node ≥ 22** and **`gh`**, authenticated (`gh auth status`).
- **Claude Code**, since the loop is a skill it drives.
- A GitHub repo you can push to and label.

## 1. Give the loop its own GitHub identity (recommended)

By default every agent runs as **your own `gh` login** — nothing to set up,
but every comment, branch and PR *is* you, and GitHub refuses
`gh pr review --approve` on your own PR (see
[the one constraint](./ai-loop.md#the-one-constraint)). A second identity
fixes the attribution problem; it does not remove the human-merges rule below.

Simplest path, per session:

```bash
gh auth login --web --scopes repo   # once, signed in as the bot account
GH_TOKEN=$(gh auth token --user <bot-login>) claude   # this session only
```

Everything that session pushes, comments or labels runs as `<bot-login>`;
every other terminal stays you. For a checkout dedicated to the loop, wire it
permanently instead:

```bash
npx @infrazero/repo-ai fix ai-loop-identity
```

Either way, invite the bot as a collaborator with **push** access first — read
access can't push branches or apply labels — and see
[Running reviewers as a second identity](./ai-loop.md#running-reviewers-as-a-second-identity)
for what this does and doesn't buy you.

## 2. Configure `.repo-ai.json`

At the repo root:

```json
{
  "$schema": "https://docs.infrazero.dev/repo-ai/repo-ai.json",
  "agentUser": "<bot-login>"
}
```

`agentUser` makes `loop guard` halt any tick not running as that account —
the safety net for step 1. `npx @infrazero/repo-ai fix config` creates or
updates the file for you. See the [full key table](./ai-loop.md#configuration)
for `requiredSkills`, `pollSeconds`, `budgetTokens`, `quietStopMinutes` and
`autoMerge`; the defaults are fine to start.

## 3. Let Claude run unattended

The loop makes many `gh`/`git`/`npx @infrazero/repo-ai` calls per tick. Without
an allow rule, Claude Code prompts you to approve each one — which defeats an
unattended loop. Add a project-level `.claude/settings.json` (not
`settings.local.json`, which is per-checkout and gitignored) with the commands
the loop needs:

```json
{
  "permissions": {
    "allow": [
      "Bash(gh:*)",
      "Bash(git:*)",
      "Bash(npx @infrazero/repo-ai:*)"
    ]
  }
}
```

**With Claude Code's sandbox on**, an allow rule only skips the prompt; the
call still runs sandboxed, where `gh` and `npx` fail. Add the loop's own calls
to `sandbox.excludedCommands` in whichever settings file sets
`sandbox.enabled`:

```json
{
  "sandbox": {
    "excludedCommands": ["gh *", "npx @infrazero/repo-ai *"]
  }
}
```

`npx @infrazero/repo-ai fix sandbox` writes this for you, and `doctor` flags it
when it is missing. See [Claude Code permissions](./ai-loop.md#claude-code-permissions)
for why.

Already have prompts piling up from other tools? The `fewer-permission-prompts`
skill scans your transcripts and writes a prioritized allowlist instead of you
guessing at rules.

## 4. Meet the repo prerequisites

```bash
npx @rtorcato/repo-tooling fix github-settings --yes
```

This sets squash as the *only* merge method, auto-merge, delete-branch-on-merge,
and `required_pull_request_reviews: null` — required review deadlocks
auto-merge. You also need **at least one required status check**: that's the
gate doing the real work once merges aren't reviewed by GitHub itself. Verify:

```bash
gh api repos/$OWNER_REPO --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}'
gh api repos/$OWNER_REPO/branches/main/protection \
  --jq '{contexts: .required_status_checks.contexts, reviews: .required_pull_request_reviews}'
```

**The `release` environment** is separate and only matters if you want
`autoMerge: true` (step 2) to merge a fully-passed issue PR unattended — every
other setup always hands issue PRs to you at Pass 1. If you want it, add a
`release` environment in the repo's Settings → Environments with
`required_reviewers` set, so a human still stands between the merge and
`npm publish`. Skip this and every PR waits for you regardless — the safer
default while you're starting out.

See [Repo prerequisites](./ai-loop.md#repo-prerequisites) for why each setting
matters.

## 5. Install the skills and labels

```bash
npx @infrazero/repo-ai setup
```

One guided run: writes `.repo-ai.json` (step 2), installs the `ai-loop`,
`ai-issue`, `ai-loop-status` and `ai-loop-stop` skills, creates the loop's labels
(`ai-ready`, `ai-wip`, `ai-review`, …) with `gh label create`, runs
`fix ai-loop-identity` if you give it an agent user, and installs the
statusline segment — asking before each step, then running `doctor` to
confirm. `--yes` skips the prompts. See [Commands](./commands.md#setup) for
each piece run alone.

## 6. Run it on one trivial issue

File something small enough to sanity-check by eye — a typo fix, a missing
test — labelled for the loop:

```bash
/ai-issue
```

Then, in Claude Code, in the repo:

```bash
/ai-loop
```

That's the whole entry point — never `/loop /ai-loop`. The first tick claims
the issue, implements it in a git worktree, opens a PR, and has two agents
review it. It then keeps itself going — a watcher wakes it when the queue
changes, with a 30-minute fallback — so you don't have to retype it. Watch
the first few ticks before trusting it on a real queue — see
[the tick](./ai-loop.md#the-tick) for what each pass does.

You'll end up with a PR labelled `merge-ready` (plus `ai-notes` if a reviewer
left something to read first), assigned to you. **The loop never merges an
issue PR** — read the diff and merge it yourself.

## 7. Stopping it

```bash
/ai-loop-stop
```

That stops this repo's loop in this session — its recurring job and watcher —
and lists what is still in flight. See [Stopping](./ai-loop.md#stopping) for
exactly what it does. The alternatives:

- Say **"stop the loop"** — the same thing.
- Or just stop labelling issues `ai-ready`; an idle loop spawns no agents and
  [stops itself](./ai-loop.md#driving-it) after a quiet period (default 120
  minutes) either way.
- Closing the Claude Code session stops it immediately — ticks only fire while
  a session is running.

## 8. Merging and releasing

This part is yours; the loop never does it.

- **Merge.** Merge `merge-ready` PRs yourself. If a PR also carries
  `ai-notes`, read the reviewer's note first.
- **Release.** In a repo with repo-tooling ≥ 5.4's `release.yml`, merging to
  `main` doesn't release. Release on demand with
  `gh workflow run release.yml` (or `/release`, or close a milestone), then
  approve the `release` environment in the run. A newer dispatch supersedes
  one still waiting for approval.
- **Warnings.** `⚠release-stuck` in the loop's summary means a release run has
  sat waiting on approval for over a day; `⚠release-failed` means the newest
  release run failed. The loop only reports them — it never approves, cancels
  or re-runs a release. See [the tick](./ai-loop.md#the-tick) for why a stale
  approval is better cancelled than approved.
- **Moving to `release.yml`?** Re-point npm's trusted publisher (OIDC) for the
  package at `release.yml`, or publishing fails.

## What's next

- [The AI Loop](./ai-loop.md) — the label state machine, the tick's five
  passes, and the limits it runs against.
- [Commands](./commands.md) — every `loop`/`doctor`/`fix` command.
- [Risks and responsibilities](./risks.md) — what running it costs and exposes.
