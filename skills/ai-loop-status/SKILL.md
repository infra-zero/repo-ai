---
name: ai-loop-status
description: |
  Show what the ai-loop pipeline is doing right now — read-only. Use when
  the user asks "what's the loop doing", "loop status", "is anything blocked",
  or invokes `/ai-loop-status`. Never applies a label, merges a PR, or spawns
  an agent. Takes an optional `owner/repo` argument; defaults to the current
  repo. GitHub only (`gh`) — not GitLab.
---

# ai-loop-status

Show what the `ai-loop` pipeline is doing right now. Arguments: $ARGUMENTS

Read-only — this never applies a label, merges a PR, or spawns an agent. To
actually advance the pipeline, run `/ai-loop`. Because it is read-only, it
is the one loop tool allowed to point at another repo via an `owner/repo`
argument.

## Steps

1. **Resolve the repo** — if $ARGUMENTS names one (`owner/repo`), use it;
   otherwise the current directory's. GitHub only — bail in one line if the
   remote is GitLab:

   ```bash
   R=${ARG:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
   ```

2. **Read the pipeline state from labels.** The loop keeps no state anywhere
   else, so these queries are the ground truth even after a crash, a restart, or
   a missed tick:

   ```bash
   gh issue list -R "$R" --state open --label ai-wip       --json number,title
   gh pr    list -R "$R" --state open --json number,title,labels,autoMergeRequest,assignees
   gh issue list -R "$R" --state open --label ai-ready     --json number,title
   gh issue list -R "$R" --state open --label ai-blocked   --json number,title
   gh issue list -R "$R" --state open --label ai-suggested --json number,title
   ```

   Filter the PR list to those carrying an `ai-*` label — a PR without one is
   not in the pipeline and the loop will never touch it.

   **Read the assignee as "whose turn"**, when the loop is configured with an
   agent account (`AI_LOOP_AGENT`): that account assigned means an agent is
   working or reviewing, the human assigned means it is waiting on them, and
   nobody assigned means queued. Say which in the report rather than listing raw
   logins — "waiting on you" beats "assignee: someone".

3. **Work out each PR's next move** from its labels, so the report says what
   happens rather than just listing state:

   - `ai-review` alone → waiting on reviewers; name which arm is outstanding
     (`ai-ok-code` missing → `code-reviewer`, `ai-ok-sec` missing →
     `security-expert`), and whether it is claimed (`ai-reviewing-code` /
     `ai-reviewing-sec` mean a reviewer is running right now)
   - `merge-ready` (or, before the label reaches a repo, both `ai-ok-*` with
     no `ai-review`) → **waiting on the human to merge**; add
     "read the comments first" when `ai-notes` rides along. Only Dependabot
     PRs — or issue PRs on a repo whose `release` environment has
     `required_reviewers` — auto-merge.
   - `autoMergeRequest` set → queued; GitHub is holding it for required checks
   - `ai-changes` → a fix round is due. Count prior rounds, because the 3rd one
     stops the loop and marks the issue `ai-blocked`:

     ```bash
     gh api "repos/$R/issues/<N>/timeline" \
       --jq '[.[] | select(.event=="labeled" and .label.name=="ai-changes")] | length'
     ```

4. **Check the worktrees** — one per in-flight issue, removed by the loop's
   Pass 2 after its PR merges. They live in a **sibling** directory of the
   repo; flag any whose issue is no longer `ai-wip` as a stale leftover the
   next tick will clean up. Only meaningful when `$R` is the current repo:

   ```bash
   ROOT=$(git rev-parse --path-format=absolute --git-common-dir)/..; ROOT=$(cd "$ROOT" && pwd)
   find "$(dirname "$ROOT")/$(basename "$ROOT")-worktrees" \
     -maxdepth 1 -name 'ai-*' -type d 2>/dev/null
   ```

5. **Check the schedule** — `/ai-loop` keeps one recurring `CronCreate` job
   whose prompt is `/ai-loop`. In the session running it, `CronList` shows
   that job and its cadence (10 or 30 minutes); it dies with the session. A
   pipeline with labels but no job is stalled, and that is the single most
   likely reason nothing is moving.

   From any other session the job is invisible, so the evidence is the status
   file's age — ticks run at most 30 minutes apart, so a file older than about
   35 minutes means the loop has stopped:

   ```bash
   STATUS="$ROOT/.claude/ai-loop-status"
   [ -f "$STATUS" ] && echo "last tick $(( ($(date +%s) - $(stat -c %Y "$STATUS" 2>/dev/null || stat -f %m "$STATUS")) / 60 ))m ago"
   NEXT=$(sed -n 3p "$STATUS" 2>/dev/null)   # epoch seconds; empty = nothing scheduled
   ```

   Line 3 is when the next tick is due. Report it as `next tick in Nm`,
   `next tick overdue` (due but the REPL has been busy), or, when it is
   empty, `no tick scheduled`.

6. **Verify the merge gate only when something looks stuck** — skip these on a
   healthy run, they are noise:

   ```bash
   gh api "repos/$R" --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}'
   gh api "repos/$R/branches/main/protection" --jq '{contexts: .required_status_checks.contexts, reviews: .required_pull_request_reviews}'
   ```

   `required_pull_request_reviews` **must** be null. The agents authenticate as
   the user's own `gh`, and GitHub refuses self-approval, so any required-review
   rule deadlocks every PR the loop opens — the PRs sit there looking merely
   slow.

7. **Report** — format as:

   ```
   ai-loop — <repo> — <date>

   Schedule: every 10m, last tick 8m ago, next tick in 2m   (or: no tick scheduled, or: NOT RUNNING)

   In flight (2/6 slots):
     #41  add a --json flag to doctor        PR #58  ai-review, waiting on security-expert
     #43  fix the nvmrc fallback             PR #59  ready — waiting on you to merge

   Queued (ai-ready, unclaimed):  #44, #45
   Suggested (agent triage queue): #46, #47
   Blocked (needs a human):       #38  (3 fix rounds, gave up)
   Worktrees: 2                   (or: 1 stale — issue #40 closed)
   ```

   End with one line naming what the next tick will actually do — "next tick:
   picks up #44, hands #59 to you" — or `idle — nothing to do`. If nothing is
   labelled `ai-ready` at all, say so plainly: the loop is idling by design,
   not broken.
