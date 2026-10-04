---
title: Commands
description: Every repo-ai command — the loop mechanics, the doctor audit, and the fixers.
---

# Commands

Every command takes `--json`. In JSON mode, diagnostics go to stderr and stdout
carries only the result. Configuration lives in the consuming repo's
`.repo-ai.json`: `agentUser` and `requiredSkills`. `doctor` reports it
missing; `fix config` creates it.

## Setup

| Command | What it does |
|---|---|
| `setup [--yes] [--json]` | Onboard a repo: runs `fix config`, `fix claude-skills`, creates or repairs the loop labels, `fix ai-loop-identity` (with an agent user), `fix statusline` and `fix claude-plugin` — asking before each — then `doctor`. |
| `doctor [--json]` | Audit the loop setup: the loop labels against their spec; `.repo-ai.json` present and valid against its schema; `agentUser` matches the `gh` identity; `humanUser` set on an organisation-owned repo; `autoMerge` only with a release gate; **CI runs** — default-branch push runs cancelled or pending with no jobs, or a `ciWorkflow` that does not exist; **Release approval** — a `release` run waiting on approval for over a day; **Release run** — the newest completed default-branch run whose `release` job failed. Both read `release.yml`'s runs (any event) when the repo has one, else the CI workflow's push runs; **Security alerts** — open Dependabot alerts, high/critical named and moderate/low folded into the count, silent on 403/404; installed skills, plugin skills and workflows, and whether they are current; `requiredSkills` installed; the Claude Code `permissions.allow` rules a tick needs; with Claude Code's sandbox on, `gh *` and `npx @rtorcato/repo-ai *` in `sandbox.excludedCommands`; and whether your statusline shows the loop status. `requiredSkills`, permissions and the sandbox are checked only when `agentUser` is set. All read-only. Exits 1 only on `drift` / `missing`. |
| `fix config` | Write `$schema`, and every unset key that has a default, into `.repo-ai.json`. With no file, create one, migrating any old `.repo-tooling.json` settings once. |
| `fix labels` | Repair loop label colours and descriptions with `gh label edit`. |
| `fix claude-skills` | Install or update the skills into `~/.claude/skills` (or `--skills-dir <path>`), and the Workflow scripts they run by name into the sibling `workflows/` directory. `--force-skills` overwrites a modified or newer copy. |
| `fix ai-loop-identity` | Point this checkout's Claude sessions at a `gh` profile signed in as `agentUser`. |
| `fix sandbox` | With Claude Code's sandbox on, add `gh *` and `npx @rtorcato/repo-ai *` to `sandbox.excludedCommands` in the settings file that turns it on. An allow rule only skips the prompt; a sandboxed `gh` fails TLS on macOS (no keychain) and `npx` can't write its cache, so a tick halts or needs an unsandboxed retry the auto-mode classifier may refuse. Excluding `gh *` gives `gh` your keychain and network, which the loop needs anyway to label PRs. Never sets `enabled`, never creates a `sandbox` block, and writes nothing while the sandbox is off. Chained calls (`cd x && gh …`) still run sandboxed. |
| `fix statusline` | Install the loop's status segment (`🤖 2 agents·1 to merge · next 9m`) to `~/.claude/ai-loop-statusline.sh`, replacing that file on every run (it is ours; don't edit it). Never touches an existing statusline: sets `statusLine` in `~/.claude/settings.json` only when you have none, otherwise prints the one line to add to your own script. Never prompts. |
| `fix claude-plugin` | Install the `/ai-loop-dash` pane plugin to `~/.claude/repo-ai-plugin`, replacing changed files on every run (it is ours; don't edit it), and add that path to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping any folders already listed. New sessions load it. Never prompts. |

**Moving over from repo-tooling?** Skills installed by `@rtorcato/repo-tooling`
carry that package's version stamp, so `fix claude-skills` treats them as local
edits and won't overwrite them. Run it once with `--force-skills`.

## Loop mechanics

The skills call these; you rarely need them directly.

| Command | What it does |
|---|---|
| `loop tick` | Compute one tick's whole work list (guard, cleanup, reap, verdicts, pickups). `.skippedPickups[]` names each `ai-ready` issue it passed over and why (an untrusted author, or a file an `ai-wip` issue also names); `.dependabotRecreate` lists the red or `DIRTY` Dependabot PRs in the loop that `loop apply` asks to `@dependabot recreate`. Read-only: writes no GitHub state and removes no worktree — `loop apply` does that. |
| `loop watch` | Poll `loop tick`'s work list every `pollSeconds` and print a line only when it changes: `HH:MM  <summary>  review #78 · pickup #39 …`. An `agentUser` mismatch warns on stderr instead of halting. Runs until killed. |
| `loop dash` | Live terminal dashboard of `loop tick`'s work list: redraws every `pollSeconds` with the summary, agents, and one section per non-empty list (pickups, reviews, fix rounds, handoffs, stalled, …). `--once` renders one frame (implied off a TTY); `--json` prints the tick result once with issue bodies removed. Bodies are never shown. Read-only: writes nothing to GitHub and leaves the status file alone. |
| `loop guard` | Repair a wrongly-bare main checkout, gate the `node_modules` rebuild, and assert the agent identity. |
| `loop env` | Print a tick's values (root, worktree root, owner/repo, agent and human users) for a human; the skill reads them from `loop tick --json`. |
| `loop worktree add <slug>` | Create an `ai-*` worktree off `origin/main` and link its dependencies. |
| `loop cleanup` | Remove `ai-*` worktrees whose PR has landed or closed. |
| `loop apply` | Apply a tick's deterministic writes: Pass 1's disarm, handoff, send-back, `merge-ready` strip and branch update; Pass 2's worktree removal (then the `node_modules` rebuild gate), `ai-wip` relabel and the label side of each stall. Its only merge is an `autoMerge` handoff. Reports every edit, and in `comments` each comment the caller still owes. |
| `loop reap` | Report agents stalled past 45 minutes and what to do about each. |
| `loop comment <pr>` | Upsert the loop's one decision-marker comment on a PR. |
| `loop verdict <pr>` | Read a reviewer's verdict marker for the PR's current head. |
| `loop tier <pr>` | Choose the review tier from the PR's changed paths: `both` (docs-only — one combined reviewer) or `split` (`code` + `sec`). Fails closed to `split`. |

## Skills

| Skill | Role |
|---|---|
| `/ai-loop` | **Start here.** Implements the `ai-ready` queue in parallel worktrees, then keeps itself going in this session, carrying the PRs through review, fix rounds and cleanup. Type it again to tick now. |
| `/ai-issue` | File an issue labelled `ai-ready` for the loop to pick up. |
| `/ai-loop-status` | Read-only: what the loop is doing, and what is blocked. |
| `/ai-loop-stop` | Stop this repo's loop in this session: its recurring job and `loop watch` watcher. Lists in-flight claims; never removes them. |

## Live pane in Claude Code

`loop dash` also comes as a Claude Code pane. `setup` installs it, or install it on its own:

```sh
npx @rtorcato/repo-ai fix claude-plugin
```

This copies the plugin to `~/.claude/repo-ai-plugin` and adds that path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, so every new session loads it, however you launch `claude`. Claude Code reads that variable from user settings only, not from a project's settings. To load it for one session without installing it, pass `claude --plugin-dir node_modules/@rtorcato/repo-ai/claude-plugin`.

Then type `/ai-loop-dash` to open the `ai-loop` pane. It never opens unless you ask. Once open, it runs `repo-ai loop dash --json` (via `npx --no`, so the repo's own install) every `pollSeconds` from `.repo-ai.json` (180 by default, 60 at least) and draws the same sections as `loop dash`. The JSON carries no issue bodies, so the pane cannot show one. Polling continues until the session ends.
