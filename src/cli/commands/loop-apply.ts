import path from 'node:path'
import chalk from 'chalk'
import type { GitExec } from '../../base/git.js'
import { type GhExec, realGhExec } from '../../base/gh.js'
import { safeText } from '../../base/sanitize.js'
import { type CleanupEntry, runLoopCleanup } from './loop-cleanup.js'
import { type InstallExec, type RebuildOutcome, runLoopGuard } from './loop-guard.js'
import { type Target, upsertMarked } from './loop-marker.js'
import type { ReapEntry } from './loop-reap.js'
import {
	type FixRound,
	type Handoff,
	type LoopTickOptions,
	type LoopTickResult,
	namedFiles,
	recreateMarker,
	stalledMarker,
	runLoopTick,
	STACKED,
	type SendBack,
} from './loop-tick.js'
import { runLoopWorktreeAdd } from './loop-worktree.js'

/**
 * `repo-ai loop apply` — the writes `loop tick` no longer makes. It reads the
 * same state as `loop tick` and performs every deterministic Pass 1 and Pass 2
 * edit (#147):
 *
 * - Pass 1: `disarm`, `handoffs` (merge-ready, assignees, label removals),
 *   `stripMergeReady`, `updateBranches`, `rerunFailed` (`gh run rerun --failed`,
 *   #202), `resync` (an empty commit on a branch its PR lags, #219), `sendBacks`.
 * - Pass 2: removes the `toClean` worktrees (re-checking each: PR closed, or its
 *   `(#<PR>)` squash landed, #149), runs `loop guard --removed` for the
 *   `node_modules` rebuild, relabels every cleaned issue, and applies the label
 *   side of `stalled`.
 * - Pass 3: claims `reviewsToSpawn` (`ai-reviewing-*`) and spawnable `fixRounds`
 *   (`ai-fixing`) within `maxTasksPerTick`, fixes first; blocks a round-capped or
 *   worktree-less fix round (#148).
 * - Pass 4: claims `pickups` up to `slots` (`ai-wip`, `ai-ready` dropped), then
 *   `loop worktree add`; a failed worktree returns the issue to `ai-ready`.
 *   `claimed` lists what the model launches Workflows for.
 *
 * It is the loop's only merge call site: `gh pr merge --squash --auto`, and only
 * for a handoff `loop tick` marked `autoMerge` (the repo's `.repo-ai.json`
 * opt-in *and* a `release` environment with required reviewers, #142).
 *
 * Every label edit is preceded by a transition comment naming the agent and the
 * next owner (#332). Comments that need judgement stay with the model:
 * `comments` lists each one owed. Removing a stalled agent's worktree stays
 * with the model too.
 *
 * Exit non-zero only to halt the tick, with `loop tick`'s or `loop guard`'s own
 * code. A failed edit is not a halt: it lands in `errors` and the next apply
 * retries it — every edit here is idempotent against the state it re-reads.
 */

export interface Applied {
	pass: 1 | 2 | 3 | 4
	transition:
		| 'disarm'
		| 'handoff'
		| 'merge'
		| 'strip-merge-ready'
		| 'update-branch'
		| 'rerun'
		| 'resync'
		| 'retarget'
		| 'dependabot-recreate'
		| 'dependabot-stalled'
		| 'send-back'
		| 'relabel'
		| 'stall'
		| 'claim-review'
		| 'claim-fix'
		| 'round-cap'
		| 'claim-pickup'
		| 'return-pickup'
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
	| { kind: 'round-cap'; pr: number; fixRound: FixRound }

export interface Claimed {
	reviews: LoopTickResult['reviewsToSpawn']
	fixes: FixRound[]
	pickups: {
		number: number
		title: string
		slug: string
		worktree: string
		needsInstall: boolean
		/** Stacked (#253): open the PR with `--base <base>` and a `Stacked on #<stackedOn>` line. */
		base?: string
		stackedOn?: number
	}[]
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with'])

/** `ai-<N>-<up to 4 kebab words>` from the title, Conventional Commit prefix dropped. */
export function pickupSlug(n: number, title: string): string {
	const words = (
		title
			.replace(/^\w+(\([^)]*\))?!?:\s*/, '')
			.toLowerCase()
			.match(/[a-z0-9]+/g) ?? []
	)
		.filter((w) => !STOP_WORDS.has(w))
		.slice(0, 4)
	return `ai-${n}-${words.join('-') || 'issue'}`
}

export interface LoopApplyResult {
	applied: Applied[]
	/** Comments owed: `notes` and `send-back` through `loop comment`, `blocked` on the issue. */
	comments: CommentOwed[]
	/** Pass 3 and 4 claims taken: one review, fix or pickup task each for the Workflows. */
	claimed: Claimed
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
	limits?: LoopTickOptions['limits']
	/** Test seams. `tick` skips the read and applies that work list. */
	tick?: LoopTickResult
	git?: GitExec
	gh?: GhExec
	install?: InstallExec
	env?: NodeJS.ProcessEnv
	now?: Date
}

/**
 * The first visible line of a transition comment (#332). `REPO_AI_AGENT` names
 * the agent making the change; `REPO_AI_AGENT_TAG` (e.g. `🐝 (Buzz agent)`)
 * follows the name. Both are one bounded line, backticks dropped.
 */
export function agentHeader(env: NodeJS.ProcessEnv): string {
	const name = safeText(env.REPO_AI_AGENT, 60).replaceAll('`', '')
	if (!name) return '🤖 *Automated — `ai-loop` label change.*'
	const tag = safeText(env.REPO_AI_AGENT_TAG, 60).replaceAll('`', '')
	return `🤖 *Automated — \`@${name}\`${tag ? ` ${tag}` : ''} via ai-loop.*`
}

/** `+\`a\`, −\`b\`` from an edit's label flags; empty when it changes none. */
export function labelDiff(args: string[]): string {
	return args
		.flatMap((a, i) =>
			a === '--add-label'
				? `+\`${args[i + 1]}\``
				: a === '--remove-label'
					? `−\`${args[i + 1]}\``
					: []
		)
		.join(', ')
}

/**
 * Upsert the transition comment that must precede a label edit on `n` (#332):
 * one marker per transition type, so a long-lived PR collects one comment per
 * kind of change, not one per tick. Returns the error, or null.
 */
export async function announce(
	target: Target,
	header: string,
	n: number,
	transition: string,
	handoff: string,
	args: string[]
): Promise<string | null> {
	const r = await upsertMarked(
		target,
		n,
		`<!-- ai-issue-loop:transition:${transition} -->`,
		`${header}\n${handoff} Labels: ${labelDiff(args)}.`
	)
	return 'error' in r ? r.error : null
}

/** What a transition means and who owns the issue or PR next. */
function handoffLine(t: Applied['transition'], args: string[], human: string): string {
	switch (t) {
		case 'handoff':
			return `Ready to merge, handing off to ${human}.`
		case 'strip-merge-ready':
			return 'No longer ready to merge; back with the loop.'
		case 'send-back':
			return 'Sent back to a fixer: the why is in the loop decision comment.'
		case 'dependabot-recreate':
			return 'Asked Dependabot to recreate; the reviews run again on its new head.'
		case 'dependabot-stalled':
			return `Dependabot never recreated, handing off to ${human}.`
		case 'relabel':
			return 'The PR is closed and its worktree removed; the loop is done here.'
		case 'stall':
			return args.includes('ai-blocked')
				? `Blocked, needs ${human}: the agent stalled.`
				: 'A stalled claim was dropped; the next tick spawns a fresh agent.'
		case 'round-cap':
			return `Blocked, needs ${human}: out of fix rounds, or nowhere to fix.`
		case 'claim-fix':
			return 'Claimed the fix round.'
		case 'claim-review':
			return 'Claimed the review.'
		case 'claim-pickup':
			return 'Claimed, working in a worktree.'
		case 'return-pickup':
			return 'Could not create the worktree; back in the `ai-ready` queue.'
		default:
			return `Label change (${t}).`
	}
}

/** A passed PR's in-flight labels; `merge-ready` supersedes them, a send-back drops them. */
const PASS_LABELS = ['ai-review', 'ai-ok-code', 'ai-ok-sec'].flatMap((l) => ['--remove-label', l])
const flag = (name: string, value: string) => (value ? [name, value] : [])

export async function runLoopApply(options: LoopApplyOptions = {}): Promise<LoopApplyResult> {
	const tick =
		options.tick ??
		(await runLoopTick({
			root: options.root,
			limits: options.limits,
			git: options.git,
			gh: options.gh,
			install: options.install,
			env: options.env,
			now: options.now,
		}))
	const result: LoopApplyResult = {
		applied: [],
		comments: [],
		claimed: { reviews: [], fixes: [], pickups: [] },
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
	const target: Target = { ownerRepo: tick.env.ownerRepo, me: tick.env.me, gh }
	const header = agentHeader(options.env ?? process.env)
	const human = humanUser ? `\`@${humanUser}\`` : 'a human'
	const run = async (
		pass: Applied['pass'],
		transition: Applied['transition'],
		n: number,
		args: string[],
		quiet = false
	) => {
		// No label moves without its comment first (#332): a failed comment skips the edit, and the next apply retries both.
		if (labelDiff(args)) {
			const line = handoffLine(transition, args, human)
			const err = await announce(target, header, n, transition, line, args)
			if (err) {
				result.applied.push({ pass, transition, number: n, args, ok: false })
				result.errors.push(`comment before ${transition} on #${n} failed: ${err}`)
				return false
			}
		}
		const r = await gh(args)
		result.applied.push({ pass, transition, number: n, args, ok: r.ok })
		if (!r.ok && !quiet)
			result.errors.push(`gh ${args.slice(0, 2).join(' ')} ${n} failed: ${r.stderr.trim()}`)
		return r.ok
	}
	const sendBack = async (s: SendBack, passed = true) => {
		// A passed PR going `DIRTY` keeps its pass (re-granting what `merge-ready` superseded)
		// so a conflict fix that leaves the diff unchanged skips re-review (#217). Only a
		// retargeted stacked PR (#253) can conflict unpassed: it grants nothing.
		const labels =
			s.label !== 'ai-conflicts'
				? [...PASS_LABELS, '--remove-label', 'ai-notes']
				: passed
					? ['--add-label', 'ai-ok-code', '--add-label', 'ai-ok-sec', '--remove-label', 'ai-review']
					: ['--remove-label', 'ai-review']
		const ok = await run(1, 'send-back', s.pr, [
			'pr',
			'edit',
			String(s.pr),
			'--add-label',
			s.label,
			...labels,
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
		// A failed update is a conflict, really `DIRTY`: send it back to merge the default branch in (#51).
		if (!ok)
			await sendBack({
				pr: u.pr,
				issue: u.issue,
				reason: 'DIRTY',
				label: 'ai-conflicts',
				failing: [],
			})
	}

	// A first-attempt ci-red gets one free rerun instead of spending a fix round (#202).
	for (const f of tick.rerunFailed)
		for (const id of f.runIds) await run(1, 'rerun', f.pr, ['run', 'rerun', String(id), '--failed'])

	// An empty commit on the lagging head: the new push event makes GitHub resync the PR (#219).
	// The ref update is fast-forward only, so a branch that moved since the tick is left alone.
	const repo = `repos/${tick.env.ownerRepo}`
	for (const x of tick.resync) {
		const c = await gh([
			'api',
			`${repo}/git/commits`,
			'-f',
			'message=chore: resync PR head [ai-loop]',
			'-f',
			`tree=${x.tree}`,
			'-f',
			`parents[]=${x.sha}`,
			'--jq',
			'.sha',
		])
		const sha = c.stdout.trim()
		if (!c.ok || !sha) {
			result.errors.push(`resync #${x.pr}: could not create the empty commit: ${c.stderr.trim()}`)
			continue
		}
		await run(1, 'resync', x.pr, [
			'api',
			'-X',
			'PATCH',
			`${repo}/git/refs/heads/${x.branch}`,
			'-f',
			`sha=${sha}`,
		])
	}

	// Its parent merged: target the default branch and merge it in — never a rebase or force-push (#253).
	// Flipping the marker makes this run once; a squash conflict is an `ai-conflicts` send-back.
	for (const x of tick.retarget) {
		const ok = await run(1, 'retarget', x.pr, [
			'pr',
			'edit',
			String(x.pr),
			'--base',
			tick.env.defaultBranch,
			'--body',
			x.body.replace(STACKED, 'Was stacked on #$1'),
		])
		if (!ok) continue
		const merged = await run(1, 'update-branch', x.pr, ['pr', 'update-branch', String(x.pr)], true)
		if (!merged)
			await sendBack(
				{ pr: x.pr, issue: x.issue, reason: 'DIRTY', label: 'ai-conflicts', failing: [] },
				x.passed
			)
	}

	for (const s of tick.sendBacks) await sendBack(s)

	// Agents can't push to Dependabot branches: ask it to rebase, and drop the verdicts on the old head (#240).
	for (const { pr: n, head } of tick.dependabotRecreate) {
		await run(1, 'dependabot-recreate', n, [
			'pr',
			'comment',
			String(n),
			'--body',
			`@dependabot recreate\n${recreateMarker(head)}`,
		])
		await run(1, 'dependabot-recreate', n, [
			'pr',
			'edit',
			String(n),
			'--remove-label',
			'ai-ok-code',
			'--remove-label',
			'ai-ok-sec',
			'--remove-label',
			'merge-ready',
		])
	}

	// Dependabot never answered the recreate: the human resolves the conflict, with no pass claimed (#255).
	for (const { pr: n, head } of tick.dependabotStalled) {
		const ok = await run(1, 'dependabot-stalled', n, [
			'pr',
			'edit',
			String(n),
			...flag('--add-assignee', humanUser),
			...flag('--remove-assignee', agentUser),
			'--remove-label',
			'ai-ok-code',
			'--remove-label',
			'ai-ok-sec',
			'--remove-label',
			'merge-ready',
		])
		if (ok)
			await run(1, 'dependabot-stalled', n, [
				'pr',
				'comment',
				String(n),
				'--body',
				`🤖 Dependabot did not answer \`@dependabot recreate\` with a new head, so this PR needs a human: merge the default branch in (keep Dependabot's lockfile, then \`--lockfile-only\`) or close it.\n${stalledMarker(head)}`,
			])
	}

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

	// Pass 3 — claim before the Workflow spawns, or a later tick duplicates the task.
	let tasks = tick.env.maxTasksPerTick
	for (const f of tick.fixRounds) {
		if (f.action === 'block') {
			// The round cap, or nowhere to fix: the human's now, with a comment.
			if (f.issue !== null)
				await run(3, 'round-cap', f.issue, [
					'issue',
					'edit',
					String(f.issue),
					'--add-label',
					'ai-blocked',
					'--remove-label',
					'ai-wip',
					...flag('--add-assignee', humanUser),
					...flag('--remove-assignee', agentUser),
				])
			const ok = await run(3, 'round-cap', f.pr, [
				'pr',
				'edit',
				String(f.pr),
				'--remove-label',
				'ai-review',
				...flag('--add-assignee', humanUser),
				...flag('--remove-assignee', agentUser),
			])
			if (ok) result.comments.push({ kind: 'round-cap', pr: f.pr, fixRound: f })
			continue
		}
		// Fixes first: past the cap, leave it unclaimed for the next tick.
		if (tasks <= 0) continue
		const ok = await run(3, 'claim-fix', f.pr, [
			'pr',
			'edit',
			String(f.pr),
			'--add-label',
			'ai-fixing',
			...flag('--add-assignee', agentUser),
		])
		if (ok) {
			tasks--
			result.claimed.fixes.push(f)
		}
	}
	for (const r of tick.reviewsToSpawn) {
		if (tasks <= 0) break
		// `both` is one docs-only reviewer carrying both lenses: one task, both claims.
		let arms: ('code' | 'sec')[] = r.arm === 'both' ? ['code', 'sec'] : [r.arm]
		// Re-read the labels: a pickup workflow may have reviewed since the tick (#243).
		const cur = await gh(['pr', 'view', String(r.pr), '--json', 'labels', '-q', '.labels[].name'])
		if (cur.ok) {
			const have = new Set(cur.stdout.split('\n').map((l) => l.trim()))
			arms = arms.filter((a) => !have.has(`ai-ok-${a}`) && !have.has(`ai-reviewing-${a}`))
			if (!arms.length) continue
		}
		const ok = await run(3, 'claim-review', r.pr, [
			'pr',
			'edit',
			String(r.pr),
			...arms.flatMap((a) => ['--add-label', `ai-reviewing-${a}`]),
			...flag('--add-assignee', agentUser),
		])
		if (ok) {
			tasks--
			// Record the narrowed arm, so Pass 3 doesn't re-review one that already passed.
			result.claimed.reviews.push({ ...r, arm: arms.length === 2 ? 'both' : (arms[0] ?? r.arm) })
		}
	}

	// Pass 4 — dropping `ai-ready` is half the claim, or it re-enters the queue when `ai-wip` clears.
	const picked = new Set<string>()
	for (const p of tick.pickups) {
		if (result.claimed.pickups.length >= tick.slots) break
		// Sharing a named file with one already picked: waiting its turn, not declined (#594).
		const files = namedFiles(p.body)
		if (files.some((f) => picked.has(f))) continue
		const ok = await run(4, 'claim-pickup', p.number, [
			'issue',
			'edit',
			String(p.number),
			'--add-label',
			'ai-wip',
			'--remove-label',
			'ai-ready',
			...flag('--add-assignee', agentUser),
		])
		if (!ok) continue
		const slug = pickupSlug(p.number, p.title)
		const wt = await runLoopWorktreeAdd(slug, {
			...seams,
			base: p.base
				? `origin/${p.base}`
				: tick.env.defaultBranch
					? `origin/${tick.env.defaultBranch}`
					: undefined,
			git: options.git,
			gh: options.gh,
		})
		if (wt.exitCode !== 0) {
			result.errors.push(
				`worktree ${slug}: ${wt.messages.filter((m) => m.startsWith('⚠')).join('; ')}`
			)
			await run(4, 'return-pickup', p.number, [
				'issue',
				'edit',
				String(p.number),
				'--add-label',
				'ai-ready',
				'--remove-label',
				'ai-wip',
				...flag('--remove-assignee', agentUser),
			])
			continue
		}
		for (const f of files) picked.add(f)
		result.claimed.pickups.push({
			number: p.number,
			title: p.title,
			slug,
			worktree: wt.worktree,
			needsInstall: wt.needsInstall,
			...(p.base ? { base: p.base, stackedOn: p.stackedOn } : {}),
		})
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
		for (const r of result.claimed.reviews) console.log(`  claimed review ${r.arm}:#${r.pr}`)
		for (const f of result.claimed.fixes) console.log(`  claimed fix:#${f.pr}`)
		for (const p of result.claimed.pickups) console.log(`  claimed #${p.number} → ${p.worktree}`)
		for (const e of result.errors) console.log(`  ${chalk.red(`error: ${e}`)}`)
		if (result.rebuild !== 'not-requested') console.log(`  rebuild: ${result.rebuild}`)
	}
	process.exitCode = result.exitCode
}
