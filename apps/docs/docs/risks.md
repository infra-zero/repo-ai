---
title: Risks and responsibilities
description: What running repo-ai costs, what it sends where, what it does under your name, and what stays your responsibility.
---

# Risks and responsibilities

**By installing or using repo-ai, you accept these risks and responsibilities.**

repo-ai runs AI agents unattended against your repositories and accounts. This
page sets out what that costs, what it exposes, and what stays on you. It is not
legal advice.

## Costs

**You pay for everything the loop uses.** Each tick and every agent it spawns
(implementers, reviewers, fix rounds) spends your Anthropic API credits or your
Claude plan's usage limits. CI runs on the PRs it opens spend your GitHub
Actions minutes.

**The loop's limits are best-effort, not a spending guarantee.** The
[limits](./ai-loop.md#limits) (issues in flight, fix rounds, agents per
tick) are instructions an agent follows, not caps enforced outside the agent;
enforcing them in the Workflow scripts is tracked in
[#41](https://github.com/rtorcato/repo-ai/issues/41). A misbehaving agent, a
bug, or a loop left running can still spend more than you expect.

So:

- Set spend limits or budget alerts with your model provider, and on GitHub
  Actions.
- Stop the loop when you aren't watching it — ask the session to stop, or remove
  the `ai-ready` labels.

## Data sent to the model provider

Agents read issues, PR diffs and file contents, and send them to Anthropic to
process. For private or client code, check that this is allowed — by your
confidentiality obligations, your contracts, and your employer's policy — before
you run the loop on it.

## Agents act as you

Everything the loop does on GitHub — comments, labels, branches, pushes, PRs —
is done as the GitHub account it is configured with (your own `gh` login, or
`agentUser` in `.repo-ai.json`). You are responsible for those actions under GitHub's
terms, and they count against that account's API rate limits.

## Prompt injection

Issue text is written by whoever opened the issue, and an agent reads it. The
safeguards:

- **The `ai-ready` gate.** On a public repo only collaborators can apply labels.
- **An author-association check.** Only `OWNER`, `MEMBER` or `COLLABORATOR`
  issues are picked up.
- **Issue text is treated as data**, never as instructions.
- **No secrets in issue-triggered runs.**
- **A human merges.** No agent merges an issue PR.

What they don't cover: text that reaches an agent another way — a comment, a
file in the repo, a dependency, a web page it fetches — can still try to steer
it, and an agent can be fooled despite being told to treat input as data. A
collaborator's account being compromised defeats the first two checks. The
last line of defence is you reading the diff before you merge.

## AI-written code

Agents can be wrong. Code they write may have bugs, security holes, or
licensing and copyright problems. Checking correctness, licensing and
copyright is on the person who merges it.

## Local changes

On your machine the loop creates and removes `ai-*` git worktrees and branches
in a sibling `<repo>-worktrees/` directory, and installs or links dependencies
into them. `setup` and `fix` write to `~/.claude` (skills, statusline) and to
the repo's config. Don't keep your own work in an `ai-*` worktree or branch.

## Third-party terms

Anthropic's usage policies and terms, and GitHub's terms of service and
acceptable-use policies, still apply to everything the loop does.

## No warranty, not affiliated

repo-ai is provided **as is** under the MIT license, with no warranty of any
kind. The authors aren't liable for costs, damages, or changes made by agents.

repo-ai is not affiliated with or endorsed by Anthropic or GitHub. Claude and
Claude Code are trademarks of Anthropic. GitHub is a trademark of GitHub, Inc.
