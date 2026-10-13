---
title: Getting started
description: Prerequisites, setup, a first issue and the loop, then stopping, merging and releasing. Optional bot account and sandbox notes included.
---

# Getting started

Everything below gets a new repo from nothing to a first PR the loop has
implemented, reviewed and handed to you to merge. If you only want to see it
work, the [Minimum path](./minimum-path.md) is three commands. This page is the
full walkthrough. [The AI Loop](./ai-loop.md) is the reference for how the
pipeline itself works, and [Risks and responsibilities](./risks.md) is what
you're accepting by running it.

:::warning

**Costs and liability.** repo-ai runs AI agents unattended, and they spend your
Anthropic credits or plan limits and your GitHub Actions minutes. Read the full
[Risks and responsibilities](./risks.md) before continuing.

:::

## 0. Prerequisites

- **Node ≥ 22** and **`gh`**, authenticated (`gh auth status`).
- **Claude Code**, since the loop is a skill it drives.
- A GitHub repo you can push to and label.

**Repo settings.** The loop works best with squash as the only merge method,
auto-merge allowed, delete-branch-on-merge, no required pull request reviews,
and at least one required status check. One command sets them:

```bash
npx @infrazero/repo-ai fix repo-settings
```

It shows a plan and asks before changing anything; `--yes` applies it. It sets
only what the loop needs. A required review deadlocks the loop, because its one
identity can't approve its own PRs. It never adds a ruleset or CodeQL, and it
keeps every required status check you already have. It needs a repo admin.

The required status check is the gate that does the real work once GitHub
isn't reviewing merges itself. When the default branch has none,
`fix repo-settings` lists the checks from its last CI run and asks which to
require. Pick the job that gates your CI. Under `--yes` it requires none and
says so, rather than guess. A required check that never runs on a PR (a
renamed job, say) leaves it `BLOCKED` with every check green; the loop hands
such a PR to you with a comment naming the check, rather than sending it to a
fixer. Verify:

```bash
gh api repos/$OWNER_REPO --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}'
gh api repos/$OWNER_REPO/branches/main/protection \
  --jq '{contexts: .required_status_checks.contexts, reviews: .required_pull_request_reviews}'
```

See [Repo prerequisites](./ai-loop.md#repo-prerequisites) for why each setting
matters.

## 1. Run `setup`

```bash
npx @infrazero/repo-ai setup
```

One guided run. It shows the cost notice once per machine, then:

- writes `.repo-ai.json` with its defaults (`fix config`),
- installs the `ai-loop`, `ai-issue`, `ai-loop-status` and `ai-loop-stop`
  skills and their Workflow scripts (`fix claude-skills`),
- allows the loop's own shell calls in this checkout (`fix allow-rules`),
- creates the loop's labels without asking and reports them in one line,
- installs the statusline segment (`fix statusline`),

asking before each step except the labels, then runs `doctor` to confirm.
`--yes` skips the prompts. See [Commands](./commands.md#setup) for each piece
run alone.

**Allow rules.** The loop makes many `gh`, `git` and `npx @infrazero/repo-ai`
calls per tick, plus your package manager's. Without an allow rule, Claude Code
prompts you for each one, which defeats an unattended loop. `setup` adds the
missing rules to `.claude/settings.local.json`, which is gitignored and covers
only this checkout: `Bash(gh:*)`, `Bash(git *)`, `Bash(npx @infrazero/repo-ai *)`
and the package manager your lockfile names, such as `Bash(pnpm:*)`. Alongside
them it adds `permissions.deny` rules for the commands those prefixes would let
run anything, such as `git -c alias.x='!cmd' x` and `pnpm dlx <package>`. It appends
rules and never removes one. To grant them for everyone who clones the repo,
put the same rules in `.claude/settings.json` instead; see
[Claude Code permissions](./ai-loop.md#claude-code-permissions).

**Claude Code's sandbox.** If you run with the sandbox on, an allow rule only
skips the prompt; the call still runs sandboxed, where `gh` and `npx` fail. Run:

```bash
npx @infrazero/repo-ai fix sandbox
```

It adds `gh *` and `npx @infrazero/repo-ai *` to `sandbox.excludedCommands` in
whichever settings file sets `sandbox.enabled`, and `doctor` flags it when it is
missing. With the sandbox off, skip this.

Already have prompts piling up from other tools? The `fewer-permission-prompts`
skill scans your transcripts and writes a prioritized allowlist instead of you
guessing at rules.

## 2. Run the loop as a bot account (optional)

By default every agent runs as **your own `gh` login**. There's nothing to set
up, but every comment, branch and PR *is* you, and GitHub refuses
`gh pr review --approve` on your own PR (see
[the one constraint](./ai-loop.md#the-one-constraint)). A second account fixes
the attribution problem; it does not remove the human-merges rule.

1. **Give the bot write access.** Invite it as a collaborator with **push**
   access and accept the invite as the bot. Read access can't push branches or
   apply labels.
2. **Sign `gh` in as the bot too.** Run this once, completing the browser step
   in a private window signed in as the bot:

   ```bash
   gh auth login --web --scopes repo
   ```

   That adds the bot to `gh`'s keyring alongside you.
3. **Declare it.** Add `"agentUser": "<bot-login>"` to `.repo-ai.json`. From then
   on, `loop guard` halts any tick that isn't running as that account.
4. **Start the loop's session as the bot:**

   ```bash
   GH_TOKEN=$(gh auth token --user <bot-login>) claude
   ```

   Everything that session pushes, comments or labels runs as `<bot-login>`.
   Every other terminal stays you.

See [Running reviewers as a second identity](./ai-loop.md#running-reviewers-as-a-second-identity)
for a one-word alias and for what this does and doesn't buy you.

## 3. File a trivial issue

File something small enough to sanity-check by eye, such as a typo fix or a
missing test. In Claude Code, in the repo:

```bash
/ai-issue
```

It files the issue labelled `ai-ready`, the label the loop picks up.

## 4. Run the loop

```bash
/ai-loop
```

That's the whole entry point. Never wrap it as `/loop /ai-loop`. The first tick
claims the issue, implements it in a git worktree, opens a PR, and has two
agents review it. It then keeps itself going: a watcher wakes it when the queue
changes, with a 30-minute fallback, so you don't have to retype it. Watch the
first few ticks before trusting it on a real queue. See
[the tick](./ai-loop.md#the-tick) for what each pass does.

You'll end up with a PR labelled `merge-ready` (plus `ai-notes` if a reviewer
left something to read first), assigned to you. **The loop never merges an
issue PR.** Read the diff and merge it yourself.

## 5. Stopping it

```bash
/ai-loop-stop
```

That stops this repo's loop in this session, both its recurring job and its
watcher, and lists what is still in flight. See [Stopping](./ai-loop.md#stopping)
for exactly what it does. The alternatives:

- Say **"stop the loop"**, which does the same thing.
- Or just stop labelling issues `ai-ready`. An idle loop spawns no agents and
  [stops itself](./ai-loop.md#driving-it) after a quiet period (default 120
  minutes).
- Closing the Claude Code session stops it immediately, since ticks only fire
  while a session is running.

## 6. Merging and releasing

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
  release run failed. The loop only reports them. It never approves, cancels
  or re-runs a release. See [the tick](./ai-loop.md#the-tick) for why a stale
  approval is better cancelled than approved.
- **Moving to `release.yml`?** Re-point npm's trusted publisher (OIDC) for the
  package at `release.yml`, or publishing fails.
- **Unattended merges.** `autoMerge: true` in `.repo-ai.json` lets the loop
  merge a fully-passed issue PR itself, but only on a repo whose `release`
  environment has `required_reviewers`, so a human still stands between the
  merge and `npm publish`. Leave it off while you're starting out; every PR
  then waits for you.

## What's next

- [The AI Loop](./ai-loop.md): the label state machine, the tick's five
  passes, the [configuration keys](./ai-loop.md#configuration), and the limits
  it runs against.
- [Commands](./commands.md): every `loop`/`doctor`/`fix` command.
- [Risks and responsibilities](./risks.md): what running it costs and exposes.
