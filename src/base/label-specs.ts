/**
 * The ai-loop label set, dependency-free so the docs site can import it and
 * render the same colours `doctor` enforces (#272). Behaviour lives in labels.ts.
 */

export interface LabelSpec {
	name: string
	/** Six hex digits, no leading `#`, lowercase — what `gh` writes. */
	color: string
	description: string
}

export const LOOP_LABELS: readonly LabelSpec[] = [
	{
		name: 'holding',
		color: '5319e7',
		description: 'Gate/holding issue — human judgement, never auto-picked',
	},
	{ name: 'ai-ready', color: '0e8a16', description: 'Eligible for an AI agent to implement' },
	{ name: 'ai-wip', color: 'fbca04', description: 'Claimed by an agent; worktree exists' },
	{ name: 'ai-blocked', color: 'b60205', description: 'Agent gave up; needs a human' },
	{ name: 'ai-review', color: '1d76db', description: 'PR awaiting agent review' },
	{ name: 'ai-reviewing-code', color: 'c5def5', description: 'code-reviewer claimed and running' },
	{ name: 'ai-reviewing-sec', color: 'c5def5', description: 'security-expert claimed and running' },
	{ name: 'ai-ok-code', color: '0e8a16', description: 'code-reviewer passed' },
	{ name: 'ai-ok-sec', color: '0e8a16', description: 'security-expert passed' },
	{ name: 'ai-changes', color: 'd93f0b', description: 'Reviewer requested changes' },
	{
		name: 'ai-conflicts',
		color: 'e99695',
		description: 'Branch conflicts with the default branch — needs main merged in',
	},
	{
		name: 'ai-fixing',
		color: '006b75',
		description: 'Fix-round implementer claimed and running',
	},
	{
		name: 'ai-notes',
		color: 'fbca04',
		description: 'Passed, but a reviewer left something to read before merging',
	},
	{
		name: 'merge-ready',
		color: '8250df',
		description: 'Both agent reviews passed and the PR is mergeable — waiting on a human',
	},
	{
		name: 'ai-suggested',
		color: 'c2e0c6',
		description: 'Follow-up surfaced by an agent review — triage queue, never auto-picked',
	},
]
