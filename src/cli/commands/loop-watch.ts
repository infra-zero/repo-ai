import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import chalk from 'chalk'
import { DEFAULT_POLL_SECONDS, readConfig } from '../../base/config.js'
import { type GhExec, realGhExec } from '../../base/gh.js'
import { checkAgentIdentity, configuredAgentUser } from './loop-guard.js'
import { type LoopTickResult, runLoopTick } from './loop-tick.js'

/**
 * `repo-ai loop watch` — poll `loop tick`'s work list every `pollSeconds` and
 * print one line only when its actionable part changes (#62). A tick is a full
 * LLM turn; a poll is a few `gh` calls, so the skill runs this under the
 * Monitor tool and each stdout line wakes the session.
 *
 * Like `loop tick` it removes nothing (#149): worktrees whose PR landed or
 * closed come back in `toClean`, for the next tick's `loop apply`.
 *
 * Each line is `HH:MM  <summary>  review #78 · pickup #39 #41 …`: numbers only,
 * never an issue or PR body — the line wakes a Claude session, and bodies are
 * untrusted. `--json` prints the full structured work list instead.
 *
 * Watching writes nothing to GitHub, so an `agentUser` mismatch warns once on
 * stderr instead of halting (#82); `loop tick` itself still halts on it.
 *
 * It also keeps line 1 of `$ROOT/.claude/ai-loop-status` (the statusline's
 * summary) current between ticks (#114), writing only when it changes so the
 * file's age stays the loop's liveness signal.
 *
 * Runs until killed. A halt prints once, until it clears. A poll with `errors`
 * or one that throws is skipped: a transient `gh` failure must neither kill the
 * watcher nor wake the session.
 */

export interface LoopWatchOptions {
	root?: string
	json?: boolean
	/** Test seams. `poll` gets the `gh` the tick would run with. */
	poll?: (gh: GhExec) => Promise<LoopTickResult>
	gh?: GhExec
	now?: () => Date
	sleep?: (ms: number) => Promise<void>
	write?: (line: string) => void
	/** Writes the status file; only called when its line 1 changes. */
	writeStatus?: (file: string, text: string) => void
	/** Stop after this many polls; unset runs forever. */
	polls?: number
}

/**
 * What a tick would act on. Content, not `idle`: a PR that stays blocked (a
 * `fixRounds` `block`) must not wake the session every poll, and a stall's
 * `minutes` grow every poll without anything new to do.
 */
export function actionable(r: LoopTickResult) {
	return {
		adopt: r.adopt,
		disarm: r.disarm,
		handoffs: r.handoffs,
		sendBacks: r.sendBacks,
		stripMergeReady: r.stripMergeReady,
		toClean: r.toClean,
		stalled: r.stalled.map(({ issue, pr, label, action }) => ({ issue, pr, label, action })),
		decay: r.decay,
		verdicts: r.verdicts,
		reviewsToSpawn: r.reviewsToSpawn,
		fixRounds: r.fixRounds.filter((f) => f.action === 'spawn'),
		updateBranches: r.updateBranches,
		// Only what a free slot would take; a queue longer than the slots is not news.
		pickups: r.pickups.slice(0, r.slots).map((p) => p.number),
	}
}

type Work = ReturnType<typeof actionable>

/** Each category's identity numbers, shared by `describeWork` and `hasNewWork` below. */
function workGroups(w: Work): [string, (number | null)[]][] {
	return [
		['adopt', w.adopt],
		['disarm', w.disarm],
		['review', w.reviewsToSpawn.map((x) => x.pr)],
		['verdict', w.verdicts.map((x) => x.pr)],
		['fix', w.fixRounds.map((x) => x.pr)],
		['update', w.updateBranches.map((x) => x.pr)],
		['sendback', w.sendBacks.map((x) => x.pr)],
		['handoff', w.handoffs.map((x) => x.pr)],
		['unready', w.stripMergeReady],
		['pickup', w.pickups],
		['clean', w.toClean.map((x) => x.issue ?? x.pr)],
		['stalled', w.stalled.map((x) => x.pr ?? x.issue)],
		['decay', w.decay],
	]
}

/** One readable line: local time, the summary, then each non-empty category by number. */
export function describeWork(summary: string, w: Work, now: Date): string {
	const items = workGroups(w)
		.map(([name, ns]) => [name, [...new Set(ns.filter((n) => n !== null))]] as const)
		.filter(([, ns]) => ns.length > 0)
		.map(([name, ns]) => `${name} ${ns.map((n) => `#${n}`).join(' ')}`)
	return [clock(now), summary, items.join(' · ')].filter(Boolean).join('  ')
}

/**
 * True when some category has an entry the previous poll's same category
 * didn't (#183): removals and unchanged entries are not news — `handoffs`
 * re-listing an already-`merge-ready` PR must not wake the session just
 * because `toClean` shrank. `prev === null` (the first poll) is news whenever
 * any category is non-empty, matching the old first-poll behaviour.
 */
function hasNewWork(curr: Work, prev: Work | null): boolean {
	const prevGroups = prev ? workGroups(prev) : null
	return workGroups(curr).some(([, ns], i) => {
		const prevNs = new Set(prevGroups?.[i]?.[1] ?? [])
		return ns.some((n) => n !== null && !prevNs.has(n))
	})
}

const clock = (now: Date) => now.toTimeString().slice(0, 5)
const epoch = (now: Date) => Math.floor(now.getTime() / 1000)

/**
 * Replace line 1 of the status file with `summary`, keeping lines 2–3 (the
 * `ai-suggested` numbers and next-tick epoch) and stamping line 4 with `nowSec`,
 * the epoch the summary last changed (#124) — Pass 5 stops the loop once it is
 * `quietStopMinutes` old. No-op when line 1 already matches, or when `.claude/`
 * doesn't exist — it is never created.
 */
export function updateStatusSummary(
	root: string,
	summary: string,
	writeStatus: (file: string, text: string) => void,
	nowSec: number
): void {
	const dir = path.join(root, '.claude')
	const file = path.join(dir, 'ai-loop-status')
	let text: string
	try {
		text = fs.readFileSync(file, 'utf8')
	} catch (err) {
		// Only a missing file starts from blank; any other read error would wipe lines 2-3.
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			console.error(chalk.yellow(`status read failed: ${(err as Error).message}`))
			return
		}
		if (!fs.existsSync(dir)) return
		text = ''
	}
	const [prev, suggested = '', next = ''] = text.split('\n')
	if (prev === summary) return
	try {
		writeStatus(file, `${summary}\n${suggested}\n${next}\n${nowSec}\n`)
	} catch (err) {
		console.error(chalk.yellow(`status write failed: ${(err as Error).message}`))
	}
}

/**
 * The `gh` a watch's ticks run with. On an `agentUser` mismatch it warns once
 * and answers the login probe with `agentUser`, so the guard passes and the work
 * list is the one the agent's own tick would act on. Every other call is real.
 */
export async function watchGh(root: string, gh: GhExec): Promise<GhExec> {
	const agentUser = await configuredAgentUser(root)
	const { verdict, message } = await checkAgentIdentity(agentUser, gh)
	if (verdict !== 'mismatch' || !agentUser) return gh
	console.error(
		chalk.yellow(`${message}\n  loop watch writes nothing to GitHub, so it keeps polling.`)
	)
	return (args, stdin) =>
		args.join(' ') === 'api user --jq .login'
			? Promise.resolve({ ok: true, stdout: `${agentUser}\n`, stderr: '', code: 0 })
			: gh(args, stdin)
}

export async function runLoopWatch(options: LoopWatchOptions = {}): Promise<void> {
	const root = path.resolve(options.root ?? process.cwd())
	const poll = options.poll ?? ((gh: GhExec) => runLoopTick({ root, gh }))
	const now = options.now ?? (() => new Date())
	const sleep = options.sleep ?? ((ms: number) => delay(ms))
	const write = options.write ?? ((line: string) => console.log(line))
	const writeStatus = options.writeStatus ?? ((file, text) => fs.writeFileSync(file, text))
	const seconds = (await readConfig(root)).pollSeconds ?? DEFAULT_POLL_SECONDS
	const gh = await watchGh(root, options.gh ?? ((args, stdin) => realGhExec(args, stdin, root)))

	let last: Work | null = null
	let lastHalt: string | null = null
	for (let i = 0; options.polls === undefined || i < options.polls; i++) {
		if (i > 0) await sleep(seconds * 1000)
		let r: LoopTickResult
		try {
			r = await poll(gh)
		} catch (err) {
			console.error(chalk.yellow(`poll failed: ${(err as Error).message}`))
			continue
		}
		if (r.halt) {
			if (r.halt !== lastHalt)
				write(
					options.json
						? JSON.stringify({ halt: r.halt, exitCode: r.exitCode })
						: `${clock(now())}  ⚠halt: ${r.halt}`
				)
			lastHalt = r.halt
			updateStatusSummary(root, '⚠halt', writeStatus, epoch(now()))
			continue
		}
		lastHalt = null
		for (const e of r.errors) console.error(chalk.yellow(e))
		// Partial lists would read as a change, so keep the last good baseline.
		if (r.errors.length > 0) continue
		updateStatusSummary(root, r.summary, writeStatus, epoch(now()))
		const work = actionable(r)
		if (hasNewWork(work, last))
			write(
				options.json
					? JSON.stringify({ summary: r.summary, ...work })
					: describeWork(r.summary, work, now())
			)
		last = work
	}
}

export async function loopWatchCommand(options: { root?: string; json?: boolean }): Promise<void> {
	await runLoopWatch(options)
}
