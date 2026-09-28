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
| `setup [--yes] [--json]` | Onboard a repo: runs `fix config`, `fix claude-skills`, creates or repairs the loop labels, `fix ai-loop-identity` (with an agent user), and `fix statusline` — asking before each — then `doctor`. |
| `doctor [--json]` | Audit the loop setup: label spec, `.repo-ai.json` against its schema, `agentUser`, installed skills, `requiredSkills`, and whether your statusline shows the loop status. Exits 1 only on `drift` / `missing`. |
| `fix config` | Write `$schema` into `.repo-ai.json`. With no file, create one, migrating any old `.repo-tooling.json` settings once. |
| `fix labels` | Repair loop label colours and descriptions with `gh label edit`. |
| `fix claude-skills` | Install or update the skills into `~/.claude/skills` (or `--skills-dir <path>`), and the Workflow scripts they run by name into the sibling `workflows/` directory. `--force-skills` overwrites a modified or newer copy. |
| `fix ai-loop-identity` | Point this checkout's Claude sessions at a `gh` profile signed in as `agentUser`. |
| `fix statusline` | Install the loop's status segment (`🤖 2 agents·1 to merge · next 9m`) to `~/.claude/ai-loop-statusline.sh`, replacing that file on every run (it is ours; don't edit it). Never touches an existing statusline: sets `statusLine` in `~/.claude/settings.json` only when you have none, otherwise prints the one line to add to your own script. Never prompts. |

**Moving over from repo-tooling?** Skills installed by `@rtorcato/repo-tooling`
carry that package's version stamp, so `fix claude-skills` treats them as local
edits and won't overwrite them. Run it once with `--force-skills`.

## Loop mechanics

The skills call these; you rarely need them directly.

| Command | What it does |
|---|---|
| `loop tick` | Compute one tick's whole work list (guard, cleanup, reap, verdicts, pickups). Read-only: writes no GitHub state and removes no worktree — `loop apply` does that. |
| `loop watch` | Poll `loop tick`'s work list every `pollSeconds` and print a line only when it changes: `HH:MM  <summary>  review #78 · pickup #39 …`. An `agentUser` mismatch warns on stderr instead of halting. Runs until killed. |
| `loop guard` | Repair a wrongly-bare main checkout, gate the `node_modules` rebuild, and assert the agent identity. |
| `loop env` | Print a tick's values (root, worktree root, owner/repo, agent and human users) for a human; the skill reads them from `loop tick --json`. |
| `loop worktree add <slug>` | Create an `ai-*` worktree off `origin/main` and link its dependencies. |
| `loop cleanup` | Remove `ai-*` worktrees whose PR has landed or closed. |
| `loop apply` | Apply a tick's deterministic writes: Pass 1's disarm, handoff, send-back, `merge-ready` strip and branch update; Pass 2's worktree removal (then the `node_modules` rebuild gate), `ai-wip` relabel and the label side of each stall. Its only merge is an `autoMerge` handoff. Reports every edit, and in `comments` each comment the caller still owes. |
| `loop reap` | Report agents stalled past 45 minutes and what to do about each. |
| `loop comment <pr>` | Upsert the loop's one decision-marker comment on a PR. |
| `loop verdict <pr>` | Read a reviewer's verdict marker for the PR's current head. |

## Skills

| Skill | Role |
|---|---|
| `/ai-loop` | **Start here.** Implements the `ai-ready` queue in parallel worktrees, then keeps itself going in this session, carrying the PRs through review, fix rounds and cleanup. Type it again to tick now. |
| `/ai-issue` | File an issue labelled `ai-ready` for the loop to pick up. |
| `/ai-loop-status` | Read-only: what the loop is doing, and what is blocked. |
