import path from 'node:path'
import fs from 'fs-extra'
import { type GhExec, realGhExec } from '../base/gh.js'
import { safeText } from '../base/sanitize.js'
import { realGitExec } from '../base/git.js'
import { type LoopApplyResult, runLoopApply } from '../cli/commands/loop-apply.js'
import { runLoopComment } from '../cli/commands/loop-marker.js'
import { type LoopTickResult, runLoopTick } from '../cli/commands/loop-tick.js'
import { type BoardItem, fetchBoard } from './board.js'
import { commentText } from './comments.js'
import type { GlobalLimits, RepoSettings } from './config.js'
import { fixPrompt, implementPrompt, reviewPrompt } from './prompts.js'
import type { Queue } from './queue.js'

/**
 * One repo's tick in the container (#282): what `/ai-loop` Passes 0–4 do,
 * minus the agents — those become queue tasks the workers run. The dashboard
 * is the only process that ticks, so no two claims race.
 */

export interface RepoState {
	repo: string
	board: BoardItem[]
	summary: string
	halt: string | null
	warnings: string[]
	errors: string[]
	lastTick: number
	releaseGated: boolean
}

export interface LoopEvent {
	t: number
	repo: string
	number: number | null
	what: string
}

export interface SchedulerDeps {
	reposDir: string
	queue: Queue
	/** The env that puts gh and git on the App for this repo (`appEnv`). */
	mint: (repo: string) => Promise<Record<string, string>>
	event: (e: Omit<LoopEvent, 't'>) => void
	/** This repo's effective limits (`limitsFor`, #305). */
	limits?: GlobalLimits
	/** Test seams. */
	tick?: (root: string) => Promise<LoopTickResult>
	apply?: (root: string) => Promise<LoopApplyResult>
	board?: (gh: GhExec) => Promise<BoardItem[]>
	gh?: GhExec
	comment?: (n: number, text: string, root: string) => Promise<void>
	clone?: (url: string, root: string) => Promise<boolean>
	now?: () => number
}

export const rootFor = (reposDir: string, repo: string) => path.join(reposDir, ...repo.split('/'))

export async function tickRepo(r: RepoSettings, deps: SchedulerDeps): Promise<RepoState> {
	const now = deps.now ?? Date.now
	const state: RepoState = {
		repo: r.repo,
		board: [],
		summary: '',
		halt: null,
		warnings: [],
		errors: [],
		lastTick: now(),
		releaseGated: false,
	}
	// ponytail: process-wide env, so repos tick one at a time; pass env through the gh/git seams to tick them in parallel.
	Object.assign(process.env, await deps.mint(r.repo))
	const root = rootFor(deps.reposDir, r.repo)
	const gh: GhExec = deps.gh ?? ((args, stdin) => realGhExec(args, stdin, root))

	if (!(await fs.pathExists(path.join(root, '.git')))) {
		const clone =
			deps.clone ??
			(async (url: string, dest: string) =>
				(await realGitExec(['clone', url, dest], deps.reposDir, 600_000)) !== null)
		await fs.ensureDir(path.dirname(root))
		if (!(await clone(`https://github.com/${r.repo}.git`, root))) {
			state.halt = `could not clone ${r.repo}`
			return state
		}
		deps.event({ repo: r.repo, number: null, what: 'cloned' })
	}

	try {
		state.board = await (deps.board ?? fetchBoard)(gh)
	} catch (err) {
		state.errors.push((err as Error).message)
	}

	const limits = { maxInFlight: deps.limits?.maxInFlight, maxFixRounds: deps.limits?.maxFixRounds }
	const tick = await (deps.tick ?? ((root) => runLoopTick({ root, limits })))(root)
	state.warnings = tick.warnings
	state.releaseGated = tick.releaseGated
	if (tick.halt) {
		state.halt = tick.halt
		state.summary = '⚠halt'
		return state
	}
	const edit = async (n: number, args: string[], what: string) => {
		const res = await gh(['pr', 'edit', String(n), ...args])
		if (res.ok) deps.event({ repo: r.repo, number: n, what })
		else state.errors.push(`#${n} ${what}: ${res.stderr.trim()}`)
	}
	// Pass 0: the App's own PRs that lost their label.
	for (const n of tick.adopt) await edit(n, ['--add-label', 'ai-review'], 'adopted')
	if (r.dependabotAutoReview) {
		for (const n of await unlabelledDependabot(gh))
			await edit(n, ['--add-label', 'ai-review'], 'dependabot → review')
	}
	// Pass 3: verdicts a reviewer posted but never labelled.
	for (const v of tick.verdicts) {
		const claim = ['--remove-label', `ai-reviewing-${v.arm}`]
		const labels =
			v.verdict === 'CHANGES'
				? ['--add-label', 'ai-changes', '--remove-label', 'ai-review', ...claim]
				: [
						'--add-label',
						`ai-ok-${v.arm}`,
						...claim,
						...(v.verdict === 'PASS-NOTES' ? ['--add-label', 'ai-notes'] : []),
					]
		await edit(v.pr, labels, `${v.arm} ${v.verdict}`)
	}

	// Passes 1, 2 and the claims for 3 and 4.
	const apply = await (deps.apply ?? ((root) => runLoopApply({ root, limits })))(root)
	state.errors.push(...apply.errors)
	if (apply.halt) {
		state.halt = apply.halt
		state.summary = '⚠halt'
		return state
	}
	for (const a of apply.applied)
		deps.event({
			repo: r.repo,
			number: a.number,
			what: a.ok ? a.transition : `${a.transition} failed`,
		})
	const comment =
		deps.comment ??
		(async (n: number, text: string, dir: string) => {
			const res = await runLoopComment(n, { dir, text, gh })
			if (res.action === 'failed') state.errors.push(`#${n} comment: ${res.error}`)
		})
	for (const c of apply.comments) {
		await comment(
			c.kind === 'blocked' ? c.issue : c.pr,
			commentText(c, tick.env.defaultBranch),
			root
		)
	}

	// The tasks the workers run.
	const enqueue = (t: Parameters<Queue['enqueue']>[0]) => {
		if (deps.queue.enqueue(t))
			deps.event({ repo: r.repo, number: t.number, what: `queued ${t.label}` })
	}
	for (const f of apply.claimed.fixes) {
		if (!f.worktree) continue
		const conflicts = tick.sendBacks.some((s) => s.pr === f.pr && s.label === 'ai-conflicts')
		enqueue({
			repo: r.repo,
			kind: 'fix',
			number: f.pr,
			label: conflicts ? 'fix:conflicts' : 'fix',
			checkout: { pr: f.pr },
			prompt: fixPrompt({
				repo: r.repo,
				pr: f.pr,
				defaultBranch: tick.env.defaultBranch,
				conflicts,
			}),
		})
	}
	for (const v of apply.claimed.reviews) {
		enqueue({
			repo: r.repo,
			kind: 'review',
			number: v.pr,
			label: `review:${v.arm}`,
			checkout: null,
			prompt: reviewPrompt({ repo: r.repo, pr: v.pr, issue: v.issue, arm: v.arm }),
		})
	}
	for (const p of apply.claimed.pickups) {
		enqueue({
			repo: r.repo,
			kind: 'implement',
			number: p.number,
			label: 'implement',
			checkout: { branch: p.slug, from: p.base ?? tick.env.defaultBranch },
			prompt: implementPrompt({
				repo: r.repo,
				issue: p.number,
				title: safeText(p.title, 200),
				slug: p.slug,
				base: p.base,
				stackedOn: p.stackedOn,
				// The worker's clone is fresh: nothing is installed.
				install: true,
			}),
		})
	}
	state.summary = tick.summary
	return state
}

async function unlabelledDependabot(gh: GhExec): Promise<number[]> {
	const r = await gh([
		'pr',
		'list',
		'--state',
		'open',
		'--author',
		'app/dependabot',
		'--json',
		'number,labels',
	])
	if (!r.ok) return []
	const prs = JSON.parse(r.stdout || '[]') as { number: number; labels: { name: string }[] }[]
	return prs
		.filter((p) => !p.labels.some((l) => l.name.startsWith('ai-') || l.name === 'merge-ready'))
		.map((p) => p.number)
}
