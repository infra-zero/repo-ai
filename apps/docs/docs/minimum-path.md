---
title: Minimum path
description: Three commands from nothing to a first PR the loop hands you to merge. No options.
---

# Minimum path

The shortest way to see the loop work. It assumes **Node ≥ 22**, **`gh`** signed
in (`gh auth status`), **Claude Code**, and a GitHub repo you can push to and
label. Before you start, read [Risks and responsibilities](./risks.md). The loop
spends your Anthropic credits and your GitHub Actions minutes.

In the repo, in a terminal:

```bash
npx @rtorcato/repo-ai setup
```

Then in Claude Code, in the same repo:

```bash
/ai-issue
/ai-loop
```

`setup` installs the skills, creates the loop's labels, and allows the loop's
shell calls in this checkout. It asks before each step, then runs `doctor`.
`/ai-issue` files a small issue labelled `ai-ready`. `/ai-loop` picks it up,
opens a PR, has two agents review it, and hands it to you labelled
`merge-ready`. **You** read the diff and merge it. The loop keeps itself going
until you run `/ai-loop-stop`.

That's all you need. Everything else is optional, and
[Getting started](./getting-started.md) covers it: running the loop as a bot
account, the repo settings it prefers, the sandbox, stopping, and releasing.
