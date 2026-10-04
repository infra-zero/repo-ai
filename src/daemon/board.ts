import type { GhExec } from '../base/gh.js'
import { safeText } from '../base/sanitize.js'
import { type Review, reviewOf, STAGES, type Stage, stageOf } from '../base/stage.js'

/**
 * The dashboard's board (#282): every open issue and PR the loop owns, with
 * its stage. Two `gh` calls, read alongside the tick rather than inside it,
 * so the interactive loop is untouched. Titles are sanitized; bodies are
 * never fetched.
 */

export interface BoardItem {
	kind: 'issue' | 'pr'
	number: number
	title: string
	url: string
	stage: Stage
	reviews: { code: Review; sec: Review } | null
	ci: 'green' | 'red' | 'pending' | 'none' | null
	merge: string | null
	assignees: string[]
	ageMinutes: number
	dependabot: boolean
}

interface Item {
	number: number
	title: string
	url: string
	labels: { name: string }[]
	assignees: { login: string }[]
	createdAt: string
	headRefName?: string
	mergeStateStatus?: string
	statusCheckRollup?: { status?: string; conclusion?: string | null; state?: string }[]
}

const RED = new Set([
	'FAILURE',
	'ERROR',
	'CANCELLED',
	'TIMED_OUT',
	'ACTION_REQUIRED',
	'STARTUP_FAILURE',
])

export function ciOf(rollup: Item['statusCheckRollup']): BoardItem['ci'] {
	if (!rollup?.length) return 'none'
	// A CheckRun has status/conclusion; a commit StatusContext has state.
	const results = rollup.map((c) => c.conclusion ?? c.state ?? null)
	if (results.some((r) => r && RED.has(r))) return 'red'
	if (
		rollup.some(
			(c, i) => (c.status && c.status !== 'COMPLETED') || !results[i] || results[i] === 'PENDING'
		)
	)
		return 'pending'
	return 'green'
}

async function list(gh: GhExec, args: string[]): Promise<Item[]> {
	const r = await gh(args)
	if (!r.ok) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${r.stderr.trim()}`)
	return JSON.parse(r.stdout || '[]') as Item[]
}

export async function fetchBoard(gh: GhExec, now = Date.now()): Promise<BoardItem[]> {
	const [prs, issues] = await Promise.all([
		list(gh, [
			'pr',
			'list',
			'--state',
			'open',
			'--limit',
			'200',
			'--json',
			'number,title,url,labels,assignees,createdAt,headRefName,mergeStateStatus,statusCheckRollup',
		]),
		list(gh, [
			'issue',
			'list',
			'--state',
			'open',
			'--limit',
			'200',
			'--json',
			'number,title,url,labels,assignees,createdAt',
		]),
	])
	const items: BoardItem[] = []
	const add = (it: Item, isPr: boolean) => {
		const labels = it.labels.map((l) => l.name)
		const stage = stageOf(labels, isPr)
		if (!stage) return
		items.push({
			kind: isPr ? 'pr' : 'issue',
			number: it.number,
			title: safeText(it.title),
			url: it.url,
			stage,
			reviews: isPr ? { code: reviewOf(labels, 'code'), sec: reviewOf(labels, 'sec') } : null,
			ci: isPr ? ciOf(it.statusCheckRollup) : null,
			merge: isPr ? (it.mergeStateStatus ?? null) : null,
			assignees: it.assignees.map((a) => a.login),
			ageMinutes: Math.max(0, Math.round((now - Date.parse(it.createdAt)) / 60_000)),
			dependabot: isPr && (it.headRefName ?? '').startsWith('dependabot/'),
		})
	}
	for (const p of prs) add(p, true)
	for (const i of issues) add(i, false)
	// What needs the human first, then the pipeline back to front.
	return items.sort(
		(a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || a.number - b.number
	)
}
