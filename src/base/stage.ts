/**
 * Where an issue or PR sits in the loop, read from its labels alone (#282).
 * The tick reads these same labels piecemeal; this is the one place that
 * names the stages, for the dashboard.
 */

export const STAGES = [
	'blocked',
	'merge-ready',
	'changes',
	'conflicts',
	'fixing',
	'review',
	'wip',
	'ready',
	'holding',
] as const
export type Stage = (typeof STAGES)[number]

/** `null` when nothing marks it as the loop's. */
export function stageOf(labels: readonly string[], isPr: boolean): Stage | null {
	const has = (l: string) => labels.includes(l)
	if (has('ai-blocked')) return 'blocked'
	if (isPr) {
		if (has('merge-ready')) return 'merge-ready'
		if (has('ai-fixing')) return 'fixing'
		if (has('ai-conflicts')) return 'conflicts'
		if (has('ai-changes')) return 'changes'
		if (labels.some((l) => l.startsWith('ai-'))) return 'review'
		return null
	}
	if (has('ai-wip')) return 'wip'
	if (has('ai-ready')) return 'ready'
	if (has('holding')) return 'holding'
	return null
}

export type Review = 'pending' | 'running' | 'pass' | 'changes'

/** One review arm. `ai-changes` names no arm, so a sent-back PR shows `changes` on any arm that has not passed. */
export function reviewOf(labels: readonly string[], arm: 'code' | 'sec'): Review {
	if (labels.includes(`ai-ok-${arm}`) || labels.includes('merge-ready')) return 'pass'
	if (labels.includes(`ai-reviewing-${arm}`)) return 'running'
	if (labels.includes('ai-changes')) return 'changes'
	return 'pending'
}
