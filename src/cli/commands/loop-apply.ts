import path from 'node:path'
import chalk from 'chalk'
import type { GitExec } from '../../base/git.js'
import { type GhExec, realGhExec } from '../../base/gh.js'
import { type CleanupEntry, runLoopCleanup } from './loop-cleanup.js'
import { type InstallExec, type RebuildOutcome, runLoopGuard } from './loop-guard.js'
import type { ReapEntry } from './loop-reap.js'
import { type Handoff, type LoopTickResult, runLoopTick, type SendBack } from './loop-tick.js'

/**
 * `repo-ai loop apply` — the writes `loop tick` no longer makes. It reads the
 * same state as `loop tick` and performs every deterministic Pass 1 and Pass 2
 * edit (#147):
 *
 * - Pass 1: `disarm`, `handoffs` (merge-ready, assignees, label removals),
 *   `stripMergeReady`, `updateBranches`, `sendBacks`.
 * - Pass 2: removes the `toClean` worktrees (re-checking each: PR closed, or its
 *   `(#<PR>)` squash landed, #149), runs `loop guard --removed` for the
 *   `node_modules` rebuild, relabels every cleaned issue, and applies the label
 *   side of `stalled`.
 *
 * It is the loop's only merge call site: `gh pr merge --squash --auto`, and only
 * for a handoff `loop tick` marked `autoMerge` (the repo's `.repo-ai.json`
 * opt-in *and* a `release` environment with required reviewers, #142).
 *
 * Comments need judgement, so they stay with the model: `comments` lists each
 * one owed. Removing a stalled agent's worktree stays with the model too.
 *
 * Exit non-zero only to halt the tick, with `loop tick`'s or `loop guard`'s own
 * code. A failed edit is not a halt: it lands in `errors` and the next apply
 * retries it — every edit here is idempotent against the state it re-reads.
 */

export interface Applied {
	pass: 1 | 2
	transition:
		| 'disarm'
		| 'handoff'
		| 'merge'
		| 'strip-merge-ready'
		| 'update-branch'
		| 'send-back'
		| 'relabel'
		| 'stall'
	/** The issue or PR the edit touched. */
	number: number
	/** The `gh` arguments run. */
	args: string[]
	ok: boolean
}

export type CommentOwed =
	| { kind: 'notes'; pr: number; handoff: Handoff }
	| { kind: 'send-back'; pr: number; sendBack: SendBack }
	| { kind: 'blocked'; issue: number; stall: ReapEntry }

export interface LoopApplyResult {
	applied: Applied[]
	/** Comments owed: `notes` and `send-back` through `loop comment`, `blocked` on the issue. */
	comments: CommentOwed[]
	/** Worktrees removed. */
	removed: CleanupEntry[]
	rebuild: RebuildOutcome
	halt: string | null
	errors: string[]
	exitCode: 0 | 1 | 2
}

export interface LoopApplyOptions {
	root?: string
	worktreeRoot?: string
	json?: boolean
	/** Test seams. `tick` skips the read and applies that work list. */
	tick?: LoopTickResult
	git?: GitExec
	gh?: GhExec
	install?: InstallExec
	env?: NodeJS.ProcessEnv
	now?: Date
}

/** A passed PR's in-flight labels; `merge-ready` supersedes them, a send-back drops them. */
const PASS_LABELS = ['ai-review', 'ai-ok-code', 'ai-ok-sec'].flatMap((l) => ['--remove-label', l])
const flag = (name: string, value: string) => (value ? [name, value] : [])

export async function runLoopApply(options: LoopApplyOptions = {}): Promise<LoopApplyResult> {
	const tick =
		options.tick ??
		(await runLoopTick({
			root: options.root,
			git: options.git,
			gh: options.gh,
			install: options.install,
			env: options.env,
			now: options.now,
		}))
	const result: LoopApplyResult = {
		applied: [],
		comments: [],
		removed: [],
		rebuild: 'not-requested',
		halt: tick.halt,
		errors: [],
		exitCode: tick.exitCode,
	}
	if (tick.halt) return result

	const root = tick.env.root || path.resolve(options.root ?? process.cwd())
	const gh: GhExec = options.gh ?? ((args, stdin) => realGhExec(args, stdin, root))
	const { agentUser, humanUser } = tick.env
	const run = async (
		pass: 1 | 2,
		transition: Applied['transition'],
		n: number,
		args: string[],
		quiet = false
	) => {
		const r = await gh(args)
		result.applied.push({ pass, transition, number: n, args, ok: r.ok })
		if (!r.ok && !quiet)
			result.errors.push(`gh ${args.slice(0, 2).join(' ')} ${n} failed: ${r.stderr.trim()}`)
		return r.ok
	}
	const sendBack = async (s: SendBack) => {
		const ok = await run(1, 'send-back', s.pr, [
			'pr',
			'edit',
			String(s.pr),
			'--add-label',
			s.label,
			...PASS_LABELS,
			'--remove-label',
			'ai-notes',
			'--remove-label',
			'merge-ready',
		])
		// The fixer reads the PR's comments as its instructions: a send-back without one is a dead end.
		if (ok) result.comments.push({ kind: 'send-back', pr: s.pr, sendBack: s })
	}

	// Pass 1 — disarm first, so no merge beats a review.
	for (const n of tick.disarm)
		await run(1, 'disarm', n, ['pr', 'merge', String(n), '--disable-auto'])

	for (const h of tick.handoffs) {
		// `ai-notes` is never stripped here: it must survive to the merge.
		const ok = await run(1, 'handoff', h.pr, [
			'pr',
			'edit',
			String(h.pr),
			...flag('--add-assignee', humanUser),
			'--add-label',
			'merge-ready',
			...PASS_LABELS,
			...flag('--remove-assignee', agentUser),
		])
		if (!ok) continue
		if (h.notes) result.comments.push({ kind: 'notes', pr: h.pr, handoff: h })
		// The one unattended merge: `loop tick` sets `autoMerge` only with the opt-in and the release gate.
		if (h.autoMerge)
			await run(1, 'merge', h.pr, ['pr', 'merge', String(h.pr), '--squash', '--auto'])
	}

	for (const n of tick.stripMergeReady)
		await run(1, 'strip-merge-ready', n, ['pr', 'edit', String(n), '--remove-label', 'merge-ready'])

	for (const u of tick.updateBranches) {
		const ok = await run(1, 'update-branch', u.pr, ['pr', 'update-branch', String(u.pr)], true)
		// A failed update is a conflict, really `DIRTY`: send it back for a rebase (#51).
		if (!ok)
			await sendBack({
				pr: u.pr,
				issue: u.issue,
				reason: 'DIRTY',
				label: 'ai-conflicts',
				failing: [],
			})
	}

	for (const s of tick.sendBacks) await sendBack(s)

	// Pass 2 — remove worktrees before relabelling, so a failed removal keeps its issue in flight.
	const seams = { root, worktreeRoot: options.worktreeRoot, git: options.git, gh: options.gh }
	const cleanup = await runLoopCleanup(seams)
	result.removed = cleanup.worktrees.filter((w) => w.action === 'removed')
	result.errors.push(
		...cleanup.worktrees
			.filter((w) => w.action === 'remove-failed')
			.map((w) => `could not remove ${w.path}`)
	)
	if (cleanup.removed) {
		const guard = await runLoopGuard({ ...seams, install: options.install, removed: true })
		result.rebuild = guard.rebuild
		if (guard.exitCode !== 0) {
			result.halt =
				guard.messages.filter((m) => m.startsWith('⚠')).join('; ') || 'loop guard failed'
			result.exitCode = guard.exitCode
			return result
		}
	}

	const relabel = new Set(
		[...result.removed, ...tick.toClean.filter((w) => w.action === 'relabel')]
			.map((w) => w.issue)
			.filter((n): n is number => n !== null)
	)
	for (const n of relabel) {
		// Still OPEN means the PR said only `Refs #N`: what is left is the human's.
		let open = false
		if (humanUser) {
			const r = await gh(['issue', 'view', String(n), '--json', 'state', '-q', '.state'])
			open = r.ok && r.stdout.trim() === 'OPEN'
		}
		await run(2, 'relabel', n, [
			'issue',
			'edit',
			String(n),
			'--remove-label',
			'ai-wip',
			...flag('--remove-assignee', agentUser),
			...(open ? ['--add-assignee', humanUser] : []),
		])
	}

	for (const s of tick.stalled) {
		if (s.action === 'drop-label' && s.pr !== null && s.label) {
			// That claim, not a fixed one.
			await run(2, 'stall', s.pr, ['pr', 'edit', String(s.pr), '--remove-label', s.label])
		} else if (s.action === 'block') {
			if (s.issue === null) {
				result.errors.push(`stall on #${s.pr} has no linked issue to block`)
				continue
			}
			const ok = await run(2, 'stall', s.issue, [
				'issue',
				'edit',
				String(s.issue),
				'--add-label',
				'ai-blocked',
				'--remove-label',
				'ai-wip',
				...flag('--add-assignee', humanUser),
				...flag('--remove-assignee', agentUser),
			])
			// Every `ai-blocked` is label + assign + comment, together.
			if (ok) result.comments.push({ kind: 'blocked', issue: s.issue, stall: s })
		}
		// ponytail: `remove-worktree` and a blocked implementer's worktree stay with the model — no label side.
	}
	return result
}

export async function loopApplyCommand(options: {
	root?: string
	worktreeRoot?: string
	json?: boolean
}): Promise<void> {
	const result = await runLoopApply(options)
	if (options.json) {
		console.log(JSON.stringify(result, null, 2))
	} else {
		if (result.halt) console.error(chalk.red(`✖ halt: ${result.halt}`))
		for (const a of result.applied)
			console.log(`  ${a.ok ? '✓' : chalk.red('✖')} ${a.transition} #${a.number}`)
		for (const w of result.removed) console.log(`  removed ${path.basename(w.path)} — ${w.reason}`)
		for (const c of result.comments)
			console.log(`  comment owed: ${c.kind} on #${c.kind === 'blocked' ? c.issue : c.pr}`)
		for (const e of result.errors) console.log(`  ${chalk.red(`error: ${e}`)}`)
		if (result.rebuild !== 'not-requested') console.log(`  rebuild: ${result.rebuild}`)
	}
	process.exitCode = result.exitCode
}
