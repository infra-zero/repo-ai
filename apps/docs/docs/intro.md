---
title: Introduction
slug: /
sidebar_position: 0
description: What repo-ai is, what it ships, and where to start.
---

# repo-ai

`@infrazero/repo-ai` is the **ai-loop** pipeline: a label-driven loop that
takes an `ai-ready` GitHub issue, implements it in its own git worktree, opens a
PR, has two agents review it, and hands it to a human to merge.

issue → loop → PR → two reviews → you merge → [you release](./getting-started.md#6-merging-and-releasing).

It was split out of [`@rtorcato/repo-tooling`](https://docs.torcato.dev/repo-tooling/)
so the tooling can be used without the loop. repo-tooling still owns the
repo-side standard the loop relies on — branch protection, auto-merge, and the
`.claude/settings.json` worktree config.

:::warning

**Costs and liability.** By installing or using repo-ai, you accept these risks and responsibilities. repo-ai runs AI agents unattended, and they spend your Anthropic credits or plan limits and your GitHub Actions minutes. The loop's limits are best-effort, not a spending guarantee. Set spend limits with your provider, and stop the loop when you aren't watching it. Agents can be wrong, so you review and merge every change. Provided as is under the MIT license, with no warranty; the authors aren't liable for costs, damages or changes made by agents. Not affiliated with Anthropic or GitHub. Read the full [Risks and responsibilities](./risks.md).

:::

## What it ships

- **Claude Code skills** — `ai-loop` (the entry point and the engine),
  `ai-issue` (the on-ramp), `ai-loop-status` (a read-only view), and
  `ai-loop-stop` (stop this repo's loop).
- **`loop` commands** — the mechanics the skills call, as tested code:
  `loop tick`, `loop guard`, `loop worktree add`, `loop reap`, and more.
- **`doctor` / `fix`** — audit and repair the loop's own setup: labels, the agent
  user, and the installed skills.

Every command takes `--json`.

## Requirements

repo-ai targets **Claude Code** only for now; other agent harnesses aren't supported yet. What each part depends on:

| Part | Depends on |
|---|---|
| `repo-ai` CLI (`loop …`, `doctor`, `fix`, `setup`) | Node ≥ 22 and `gh`. Harness-neutral, so any agent or script can call it |
| Skills (`ai-loop`, `ai-issue`, `ai-loop-status`, `ai-loop-stop`) | The Claude Code skill format |
| Parallel implement/review (`ai-loop` Pass 3 and Pass 4, via the `ai-loop-recover` and `ai-loop-pickup` workflows) | The **Workflow** tool. Named reviewer types (`code-reviewer`, `security-expert`) need them in the Agent tool's registry; otherwise the reviewers run as `general-purpose`. Without Workflow, `ai-loop` falls back to background Agent calls |
| Self-scheduling (`/ai-loop` keeps itself going) | A session-scoped recurring **CronCreate** job |
| Wake on change (`loop watch`) | The **Monitor** tool |
| Statusline segment | Claude Code's statusline JSON |

Workflow runs show in `/workflows`. If you edit the scripts in `workflows/`, load `/workflow-authoring` first.

## Start here

The [Minimum path](./minimum-path.md) is three commands, with no options:

1. Run `npx @infrazero/repo-ai setup`.
2. File an issue with `/ai-issue` in Claude Code.
3. Run `/ai-loop`.

[Getting started](./getting-started.md) is the full walkthrough: the repo
settings, a bot account, the sandbox, stopping, merging and releasing.

## Installing the skills

**Use `setup`.** It runs `fix claude-skills`, which installs the four skills (`ai-loop`, `ai-issue`, `ai-loop-status`, `ai-loop-stop`) and the two Workflow scripts they run by name (`ai-loop-pickup`, `ai-loop-recover`), stamped with the npm version you ran. By default they go to `~/.claude/skills` and `~/.claude/workflows`, for every project on the machine.

**Sharing them with your team?** Install into the repo instead and commit the result:

```bash
npx @infrazero/repo-ai fix claude-skills --skills-dir .claude/skills
```

The Workflow scripts land next to them in `.claude/workflows`, so everyone who clones the repo runs the same version.

**Prefer a plugin?** In Claude Code, run `/plugin marketplace add infra-zero/repo-ai`, then `/plugin install repo-ai@repo-ai`. You get the same four skills and both Workflow scripts, registered as `repo-ai:ai-loop-pickup` and `repo-ai:ai-loop-recover`, which `ai-loop` finds on its own. The plugin is **unversioned**: it follows `main`, so it can run ahead of the npm release. Pick one way, not both.

Either way, the skills call the CLI through `npx @infrazero/repo-ai`.

**Models and reviewers.** The `ai-loop` skill pins `model: sonnet`, and its quick verification step pins `haiku`. Reviews run as `code-reviewer` and `security-expert` when you have agents with those names in `.claude/agents` or `~/.claude/agents`. Otherwise they run as `general-purpose`, with the reviewer's brief in the prompt. `doctor`'s `Reviewer agents` line tells you which you'll get.

## Optional mods

Mods are Claude Code plugins built on its early-access mod API. They need **Claude Code 2.1.292** or later and may break between Claude Code releases. Neither `setup` nor `fix` installs them. Add the marketplace once with `/plugin marketplace add infra-zero/repo-ai`, then install any of these:

| Mod | Install | What it does | Needs |
|---|---|---|---|
| `release-guard` | `/plugin install release-guard@repo-ai` | Stops an agent from releasing outside CI: npm publish, version bumps, a local semantic-release run, git tags and tag pushes, force pushes, `git push --tags` or `--follow-tags`, release workflow dispatches (and any dispatch by numeric workflow ID), milestone closes (they fire the release workflow), GitHub releases and `package.json` `"version"` edits. It tells the agent to have you run the command yourself with `! <command>`. | Nothing else |
| `loop-watch` (experimental) | `/plugin install loop-watch@repo-ai` | A live view of the loop: a status line segment (`🤖 <summary> · next 9m · 2 agents · 1 ready to merge`), a `/loop-watch` pane of the open PRs and issues with `ai-*` labels, a toast and chime when a PR passes both reviews, and a dock with one tile per running subagent. | `gh` |
| `repo-ai-rainbow` | `/plugin install repo-ai-rainbow@repo-ai` | A colourful band above the prompt with the open `ai-*` label counts and the loop status. `/repo-ai` refreshes it. | `gh` |

`release-guard` matches command text rather than parsing the shell, so it catches an agent's slip, not an adversary. It deliberately allows `gh pr merge`. Required checks and the `release` environment remain the real gates.

`loop-watch` reads the same `.claude/ai-loop-status` as the statusline segment and polls `gh` every 2 minutes. It sees only this session's agents; agents in other sessions show up through their labels and the status file.

`release-guard` follows `main`. `loop-watch` and `repo-ai-rainbow` are pinned to a release commit, so a push to `main` never changes what you have installed.

Read [The AI Loop](./ai-loop.md) for how the pipeline works, and
[Commands](./commands.md) for every command.
