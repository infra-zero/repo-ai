/**
 * The walkthrough's script: one issue (#82) and its PR (#90) through each path
 * of the label state machine. Text in backticks renders as inline code.
 */

export type Actor = 'you' | 'tick' | 'session' | 'apply' | 'agent'

export type NodeId =
	| 'ready'
	| 'wip'
	| 'review'
	| 'reviewing'
	| 'ok'
	| 'mr'
	| 'blocked'
	| 'fixing'
	| 'changes'
	| 'merged'
	| 'conflicts'
	| 'done'

export interface Step {
	/** When this happens: a tick, or the gap between two. */
	when: string
	/** The pass of the tick, when one is running. */
	pass?: 0 | 1 | 2 | 3 | 4 | 5
	actor: Actor
	node: NodeId
	title: string
	body: string
	/** The command or call that makes this step happen. */
	cmd?: string
	issue: string[]
	issueAssignee: string
	issueClosed?: boolean
	worktree: boolean
	/** Unset until the implementer opens the PR. */
	pr?: string[]
	prAssignee?: string
	prMerged?: boolean
}

export interface Scenario {
	name: string
	steps: Step[]
}

export const ACTORS: { id: Actor; name: string; does: string }[] = [
	{ id: 'you', name: 'You', does: 'label issues, merge PRs' },
	{ id: 'tick', name: 'loop tick', does: 'reads GitHub, writes nothing' },
	{ id: 'session', name: 'Claude session', does: 'triage, comments, launching agents' },
	{ id: 'apply', name: 'loop apply', does: 'every label, assignee and worktree edit' },
	{
		id: 'agent',
		name: 'Workflow agents',
		does: 'implement, review, fix, and set their own labels',
	},
]

export const PASSES = [
	'Orient',
	'Hand over',
	'Clean up',
	'Review and fix (recovery)',
	'Pick up',
	'Report',
]

const BOT = 'my-bot'
const YOU = 'you'
const TICK = 'npx @infrazero/repo-ai loop tick --json'
const APPLY = 'npx @infrazero/repo-ai loop apply --root <root> --json'
const COMMENT = 'npx @infrazero/repo-ai loop comment 90 --body-file "$BODY_FILE"'

/** The issue as every later scenario finds it: claimed, with a worktree. */
const claimed = { issue: ['ai-wip'], issueAssignee: BOT, worktree: true }

export const SCENARIOS: Scenario[] = [
	{
		name: 'Clean run',
		steps: [
			{
				when: 'Before the loop',
				actor: 'you',
				node: 'ready',
				title: 'You mark the issue ai-ready',
				body: 'That label is the only way in. Nobody is assigned yet, and nothing happens until a tick runs.',
				cmd: 'gh issue edit 82 --add-label ai-ready',
				issue: ['ai-ready'],
				issueAssignee: '',
				worktree: false,
			},
			{
				when: 'Tick 1',
				pass: 0,
				actor: 'tick',
				node: 'ready',
				title: 'The tick reads the work list',
				body: 'One command reads every open PR, the `ai-wip` issues and the `ai-ready` queue, and returns JSON. It writes nothing. Issue #82 comes back under `.pickups`, and there is a free slot out of 6.',
				cmd: TICK,
				issue: ['ai-ready'],
				issueAssignee: '',
				worktree: false,
			},
			{
				when: 'Tick 1',
				pass: 4,
				actor: 'session',
				node: 'ready',
				title: 'The session triages the pickup',
				body: 'Before anything is claimed, the session reads the issue body as untrusted data and decides whether an agent can finish it. If not, it drops `ai-ready`, assigns you and comments how to lift the hold. This one is fine.',
				cmd: 'gh issue view 82',
				issue: ['ai-ready'],
				issueAssignee: '',
				worktree: false,
			},
			{
				when: 'Tick 1',
				pass: 1,
				actor: 'apply',
				node: 'wip',
				title: 'loop apply claims it',
				body: 'Run once per tick, it makes every edit the tick called for. Here it swaps `ai-ready` for `ai-wip`, assigns the agent and creates a worktree in a sibling directory.',
				cmd: APPLY,
				...claimed,
			},
			{
				when: 'Tick 1',
				pass: 4,
				actor: 'session',
				node: 'wip',
				title: 'The session launches the pickup Workflow',
				body: 'One call starts every claimed issue, and the session does not wait for it. The Workflow owns the whole chain for #82: implement, review, and up to 2 fix rounds.',
				cmd: "Workflow({name: 'ai-loop-pickup', args: {issues: [{number: 82, …}], …}})",
				...claimed,
			},
			{
				when: 'Tick 1',
				pass: 5,
				actor: 'session',
				node: 'wip',
				title: 'The tick reports and schedules the next one',
				body: 'It writes a one-line summary to `.claude/ai-loop-status`, starts a watcher that fires when the work list changes, and keeps exactly one cron job as a fallback: every 30 minutes with a watcher, every 10 without.',
				cmd: 'Monitor({command: "npx @infrazero/repo-ai loop watch --root <root>"})\nCronCreate({prompt: "/ai-loop --root <root>", recurring: true})',
				...claimed,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'review',
				title: 'The implementer opens a PR',
				body: 'It works in the worktree through `git -C`, never by entering it, commits with Conventional Commits, pushes and opens PR #90 with `Closes #82`. Then it labels the PR itself.',
				cmd: 'gh pr edit 90 --add-label ai-review',
				...claimed,
				pr: ['ai-review'],
				prAssignee: '',
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'reviewing',
				title: 'Two reviewers claim the PR',
				body: '`loop tier` picks the reviewers from the changed paths. A docs-only diff gets one combined reviewer; anything else gets `code-reviewer` and `security-expert`. Each sets a claim label first, so a tick that fires mid-run cannot spawn a second.',
				cmd: 'gh pr edit 90 --add-label ai-reviewing-code --add-assignee my-bot\ngh pr edit 90 --add-label ai-reviewing-sec  --add-assignee my-bot',
				...claimed,
				pr: ['ai-review', 'ai-reviewing-code', 'ai-reviewing-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'ok',
				title: 'Both reviewers pass it',
				body: 'Reviewers see the diff, the PR and the issue, nothing else. Each posts a review comment with a verdict marker, then swaps its claim for a pass label. Every agent is the same GitHub login as the PR author, so a real approval is impossible: approval is a label.',
				cmd: 'gh pr review 90 --comment --body-file review-90-code.md\ngh pr edit 90 --add-label ai-ok-code --remove-label ai-reviewing-code',
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-ok-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Tick 2',
				pass: 0,
				actor: 'tick',
				node: 'ok',
				title: 'The watcher fires and the tick reads again',
				body: 'The tick knows nothing about tick 1. It reads the labels fresh: both passes, no `ai-changes`, required checks green and GitHub reports the PR `CLEAN`. PR #90 lands in `.handoffs`.',
				cmd: TICK,
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-ok-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Tick 2',
				pass: 1,
				actor: 'apply',
				node: 'mr',
				title: 'loop apply hands the PR to you',
				body: 'It adds `merge-ready`, assigns you, and drops `ai-review`, both pass labels and the agent. The loop never merges unless the repo opts in to `autoMerge` behind a gated release.',
				cmd: APPLY,
				...claimed,
				pr: ['merge-ready'],
				prAssignee: YOU,
			},
			{
				when: 'Tick 2',
				pass: 5,
				actor: 'session',
				node: 'mr',
				title: 'You get one notification',
				body: 'The summary changed since the last tick, so the session notifies once. A clean handoff gets no comment on the PR: the label and the assignee already say it.',
				cmd: '#90 ready to merge: feat(fix): add --dry-run to fix labels',
				...claimed,
				pr: ['merge-ready'],
				prAssignee: YOU,
			},
			{
				when: 'Your turn',
				actor: 'you',
				node: 'merged',
				title: 'You squash and merge',
				body: 'Required status checks are the real merge gate. The merge closes issue #82, but its `ai-wip` label and the worktree are still there.',
				cmd: 'gh pr merge 90 --squash',
				...claimed,
				issueClosed: true,
				pr: ['merge-ready'],
				prAssignee: YOU,
				prMerged: true,
			},
			{
				when: 'Tick 3',
				pass: 2,
				actor: 'apply',
				node: 'done',
				title: 'A later tick cleans up',
				body: 'It confirms the squash is on the default branch before removing anything, then removes the worktree and strips `ai-wip`. With nothing left the loop goes idle, and after 120 minutes unchanged it stops itself.',
				cmd: APPLY,
				issue: [],
				issueAssignee: '',
				issueClosed: true,
				worktree: false,
				pr: ['merge-ready'],
				prAssignee: YOU,
				prMerged: true,
			},
		],
	},
	{
		name: 'Reviewer asks for changes',
		steps: [
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'reviewing',
				title: 'The reviewers are running',
				body: 'This picks up where the clean run reaches review. The pickup Workflow from tick 1 is still alive and still owns PR #90.',
				...claimed,
				pr: ['ai-review', 'ai-reviewing-code', 'ai-reviewing-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'changes',
				title: 'Security finds a real defect',
				body: 'The code reviewer passes. The security reviewer posts a `CHANGES` verdict and, in the same command that clears its claim, pulls the PR out of review. `ai-changes` is only for something an agent could fix; a question for a human is a pass plus `ai-notes`.',
				cmd: 'gh pr edit 90 --add-label ai-changes --remove-label ai-review --remove-label ai-reviewing-sec',
				...claimed,
				pr: ['ai-ok-code', 'ai-changes'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'fixing',
				title: 'A fixer claims round 1 of 2',
				body: 'The same Workflow spawns a fixer in the same worktree. It reads the PR comments as its instructions and the issue body as data only. Two fixers on one branch would race each other, which is why the claim label comes first.',
				cmd: 'gh pr edit 90 --add-label ai-fixing --add-assignee my-bot',
				...claimed,
				pr: ['ai-ok-code', 'ai-changes', 'ai-fixing'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'review',
				title: 'The fixer pushes and resets the review',
				body: 'The diff changed, so every earlier verdict is void. One command puts the PR back in review and strips the old pass labels with it.',
				cmd: 'gh pr edit 90 --add-label ai-review --remove-label ai-changes --remove-label ai-fixing \\\n  --remove-label ai-ok-code --remove-label ai-ok-sec --remove-label ai-notes',
				...claimed,
				pr: ['ai-review'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'reviewing',
				title: 'Both reviews run again',
				body: 'Fresh reviewers, fresh claims, same diff-only view.',
				...claimed,
				pr: ['ai-review', 'ai-reviewing-code', 'ai-reviewing-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'ok',
				title: 'Both pass, one with a note',
				body: 'Security passes but wants you to know something before merging, so it adds `ai-notes` alongside its pass. The note never blocks.',
				cmd: 'gh pr edit 90 --add-label ai-ok-sec --remove-label ai-reviewing-sec\ngh pr edit 90 --add-label ai-notes',
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-ok-sec', 'ai-notes'],
				prAssignee: BOT,
			},
			{
				when: 'Tick 2',
				pass: 1,
				actor: 'apply',
				node: 'mr',
				title: 'Handed over, with the note kept',
				body: "`merge-ready` replaces the pass pair, and `ai-notes` survives to the merge. The session then writes one short comment linking the reviewer's `### Before merging` section.",
				cmd: COMMENT,
				...claimed,
				pr: ['merge-ready', 'ai-notes'],
				prAssignee: YOU,
			},
			{
				when: 'Your turn',
				actor: 'you',
				node: 'merged',
				title: 'You read the note, then merge',
				body: 'Two labels tell you to open the comments first. One label means merge freely. Cleanup happens on a later tick, as in the clean run.',
				cmd: 'gh pr merge 90 --squash',
				...claimed,
				issueClosed: true,
				pr: ['merge-ready', 'ai-notes'],
				prAssignee: YOU,
				prMerged: true,
			},
		],
	},
	{
		name: 'Conflict with main',
		steps: [
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'ok',
				title: 'Both reviews passed',
				body: 'PR #90 is waiting for a tick to hand it over. Meanwhile you merge a different PR that touches the same lines.',
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-ok-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Tick 2',
				pass: 0,
				actor: 'tick',
				node: 'ok',
				title: 'The tick finds the PR is not clean',
				body: 'GitHub reports it `DIRTY`. Had it only been `BEHIND`, `loop apply` would run `gh pr update-branch` and keep the reviews, with no agent involved.',
				cmd: TICK,
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-ok-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Tick 2',
				pass: 1,
				actor: 'apply',
				node: 'conflicts',
				title: 'loop apply sends it back as a conflict',
				body: '`ai-conflicts` is kept apart from `ai-changes` on purpose: the PR did nothing wrong, so this does not spend one of its 2 fix rounds. The pass labels stay.',
				cmd: 'gh pr edit 90 --add-label ai-conflicts --add-label ai-ok-code --add-label ai-ok-sec \\\n  --remove-label ai-review --remove-label merge-ready',
				...claimed,
				pr: ['ai-ok-code', 'ai-ok-sec', 'ai-conflicts'],
				prAssignee: BOT,
			},
			{
				when: 'Tick 2',
				pass: 1,
				actor: 'session',
				node: 'conflicts',
				title: 'The session writes the send-back comment',
				body: 'One line, because the fixer will read it as its instructions: merge the default branch in and push. Never rebase, never force-push.',
				cmd: COMMENT,
				...claimed,
				pr: ['ai-ok-code', 'ai-ok-sec', 'ai-conflicts'],
				prAssignee: BOT,
			},
			{
				when: 'Tick 2',
				pass: 3,
				actor: 'session',
				node: 'fixing',
				title: 'Pass 3 queues a fixer',
				body: 'The pickup Workflow is long gone, so this is recovery. `loop apply` has already set the `ai-fixing` claim; the session launches every claimed task in one call, fixes first, at most 8 per tick.',
				cmd: "Workflow({name: 'ai-loop-recover', args: {fixes: [{label: 'fix:#90', …}], …}})",
				...claimed,
				pr: ['ai-ok-code', 'ai-ok-sec', 'ai-conflicts', 'ai-fixing'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'ok',
				title: 'The fixer merges main in and checks its own diff',
				body: "It fingerprints the PR's own diff before and after the merge. Same fingerprint means the reviewed lines are untouched, so the reviews still hold and it only clears the conflict. A different fingerprint would send it through both reviews again.",
				cmd: 'git -C "<worktree>" merge origin/main && git -C "<worktree>" push\ngh pr edit 90 --add-label ai-review --remove-label ai-conflicts --remove-label ai-fixing',
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-ok-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Tick 3',
				pass: 1,
				actor: 'apply',
				node: 'mr',
				title: 'Clean this time, so it is handed over',
				body: 'CI ran again on the merge commit and passed. The handoff is the same as the clean run.',
				cmd: APPLY,
				...claimed,
				pr: ['merge-ready'],
				prAssignee: YOU,
			},
		],
	},
	{
		name: 'An agent dies',
		steps: [
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'reviewing',
				title: 'One reviewer finishes, the other vanishes',
				body: "The code reviewer passes. The security reviewer's process dies before it posts anything, say because the session was closed. Its claim label is still on the PR.",
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-reviewing-sec'],
				prAssignee: BOT,
			},
			{
				when: 'The next few ticks',
				pass: 0,
				actor: 'tick',
				node: 'reviewing',
				title: 'The tick sees a claim and leaves it alone',
				body: 'A claim means someone has this, so no second reviewer is spawned. Nothing can time an agent out from outside, so the loop waits on the age of the label instead.',
				cmd: TICK,
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-reviewing-sec'],
				prAssignee: BOT,
			},
			{
				when: 'A tick 45 minutes later',
				pass: 2,
				actor: 'apply',
				node: 'review',
				title: 'The stale claim is reaped',
				body: 'The label has sat for 45 minutes without its expected transition, so the tick lists it under `.stalled` and `loop apply` drops it. The code pass is kept. Nothing is respawned yet: this tick read the claim as still held.',
				cmd: 'gh pr edit 90 --remove-label ai-reviewing-sec',
				...claimed,
				pr: ['ai-review', 'ai-ok-code'],
				prAssignee: BOT,
			},
			{
				when: 'The tick after',
				pass: 3,
				actor: 'session',
				node: 'reviewing',
				title: 'Pass 3 spawns a replacement',
				body: 'Now the PR reads as in review with one verdict missing. `loop apply` claims the security arm again and the session launches it. If the same claim is applied 3 times, the loop stops retrying and hands the PR to you with a comment.',
				cmd: "Workflow({name: 'ai-loop-recover', args: {reviews: [{label: 'sec:#90', arm: 'sec', …}], …}})",
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-reviewing-sec'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'ok',
				title: 'The new reviewer passes it',
				body: 'From here the PR is indistinguishable from one that never stalled. That is the point of keeping all state in labels: a crash, a restart or a missed tick costs nothing.',
				cmd: 'gh pr edit 90 --add-label ai-ok-sec --remove-label ai-reviewing-sec',
				...claimed,
				pr: ['ai-review', 'ai-ok-code', 'ai-ok-sec'],
				prAssignee: BOT,
			},
		],
	},
	{
		name: 'Fix rounds run out',
		steps: [
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'changes',
				title: 'First ai-changes',
				body: 'A reviewer asks for a change. This is the first of 2 fix rounds the PR is allowed.',
				...claimed,
				pr: ['ai-ok-code', 'ai-changes'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'fixing',
				title: 'Round 1, then round 2',
				body: 'A fixer pushes, both reviews run again, and security objects again. A second fixer pushes. Reviewer and implementer going back and forth is the one unbounded token sink in the loop, which is why it has a cap.',
				cmd: 'gh pr edit 90 --add-label ai-fixing --add-assignee my-bot',
				...claimed,
				pr: ['ai-changes', 'ai-fixing'],
				prAssignee: BOT,
			},
			{
				when: 'Between ticks',
				actor: 'agent',
				node: 'changes',
				title: 'Third ai-changes',
				body: 'The review after round 2 still finds a defect. The Workflow has used its rounds and stops.',
				cmd: 'gh pr edit 90 --add-label ai-changes --remove-label ai-review --remove-label ai-reviewing-sec',
				...claimed,
				pr: ['ai-ok-code', 'ai-changes'],
				prAssignee: BOT,
			},
			{
				when: 'Next tick',
				pass: 0,
				actor: 'tick',
				node: 'changes',
				title: 'The tick counts the label history',
				body: 'It never kept a counter. It counts how many times `ai-changes` was applied to the PR, finds 3, and marks the fix round `block` instead of spawnable.',
				cmd: 'ai-changes applied 3× — round cap reached',
				...claimed,
				pr: ['ai-ok-code', 'ai-changes'],
				prAssignee: BOT,
			},
			{
				when: 'Next tick',
				pass: 3,
				actor: 'apply',
				node: 'blocked',
				title: 'loop apply blocks it and assigns you',
				body: 'The issue swaps `ai-wip` for `ai-blocked`, and both the issue and the PR move from the agent to you. The worktree and the PR stay as they are.',
				cmd: 'gh issue edit 82 --add-label ai-blocked --remove-label ai-wip --add-assignee <you> --remove-assignee my-bot\ngh pr edit 90 --remove-label ai-review --add-assignee <you> --remove-assignee my-bot',
				issue: ['ai-blocked'],
				issueAssignee: YOU,
				worktree: true,
				pr: ['ai-ok-code', 'ai-changes'],
				prAssignee: YOU,
			},
			{
				when: 'Next tick',
				pass: 3,
				actor: 'session',
				node: 'blocked',
				title: 'The session explains why',
				body: 'It writes one comment naming what each round changed and why the reviewer kept objecting, so a bare red label does not read as a mystery. Only you can put `ai-ready` back.',
				cmd: COMMENT,
				issue: ['ai-blocked'],
				issueAssignee: YOU,
				worktree: true,
				pr: ['ai-ok-code', 'ai-changes'],
				prAssignee: YOU,
			},
		],
	},
]
