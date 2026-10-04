import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import chalk from 'chalk'
import { DEFAULT_POLL_SECONDS, readConfig } from '../../base/config.js'
import { type GhExec, realGhExec } from '../../base/gh.js'
import { watchGh } from './loop-watch.js'
import { type LoopTickResult, runLoopTick } from './loop-tick.js'

/**
 * `repo-ai loop dash` — a live, read-only terminal view of `loop tick`'s work
 * list (#274). Polls like `loop watch` but redraws a whole frame each time.
 *
 * Only numbers, label/arm names and our own `reason` strings are printed —
 * never an issue or PR body (untrusted), same rule as `loop watch`. It writes
 * nothing to GitHub and leaves the status file alone.
 */

export interface LoopDashOptions {
	root?: string
	once?: boolean
	json?: boolean
	/** Test seams. */
	poll?: (gh: GhExec) => Promise<LoopTickResult>
	gh?: GhExec
	sleep?: (ms: number) => Promise<void>
	write?: (text: string) => void
	isTTY?: boolean
	width?: number
	/** Stop after this many polls; unset runs forever. */
	polls?: number
}

const nums = (ns: (number | null | undefined)[]) =>
	ns
		.filter((n) => n != null)
		.map((n) => `#${n}`)
		.join(' ')

/** The tick result as `--json` prints it: bodies removed. */
export const stripBodies = (r: LoopTickResult) => ({
	...r,
	pickups: r.pickups.map(({ body: _body, ...p }) => p),
})

/** One frame. Pure: no clock, no I/O. `statusLine` is line 1 of the status file. */
export function renderDash(r: LoopTickResult, width: number, statusLine?: string): string {
	const rule = chalk.dim('─'.repeat(Math.max(10, width)))
	const out: string[] = []
	const header = `${chalk.bold(r.summary)}  agents ${r.liveAgents}/${r.liveAgents + r.slots}`
	out.push(header)
	if (r.halt) out.push(chalk.red.bold(`⚠ halt: ${r.halt}`))
	if (statusLine) out.push(chalk.dim(`status: ${statusLine}`))
	out.push(rule)
	const bodyStart = out.length

	const section = (title: string, rows: string[]) => {
		if (rows.length === 0) return
		out.push(chalk.cyan(`${title} (${rows.length})`), ...rows.map((x) => `  ${x}`))
	}
	const pr = (x: { pr: number | null; issue: number | null }) => nums([x.pr ?? x.issue])
	section(
		'pickups',
		r.pickups.map((p) => `#${p.number}${p.stackedOn ? ` (on #${p.stackedOn})` : ''}`)
	)
	section(
		'skipped pickups',
		r.skippedPickups.map((p) => `#${p.number}  ${chalk.dim(p.reason)}`)
	)
	section(
		'reviews to spawn',
		r.reviewsToSpawn.map((x) => `#${x.pr}  ${x.arm}`)
	)
	section(
		'fix rounds',
		r.fixRounds.map((x) => `#${x.pr}  ${x.action} (${x.applications})  ${chalk.dim(x.reason)}`)
	)
	section(
		'handoffs',
		r.handoffs.map((x) => `#${x.pr}${x.autoMerge ? '  auto-merge' : ''}${x.notes ? '  notes' : ''}`)
	)
	section(
		'send backs',
		r.sendBacks.map((x) => `#${x.pr}  ${x.reason} → ${x.label}`)
	)
	section(
		'stalled',
		r.stalled.map((x) => `${pr(x)}  ${x.kind}  ${x.label ?? ''}  ${x.action}`.replace(/ {2,}$/, ''))
	)
	section(
		'to clean',
		r.toClean.map((x) => `${pr(x)}  ${x.action}  ${chalk.dim(x.reason)}`)
	)
	section(
		'update branches',
		r.updateBranches.map((x) => `#${x.pr}`)
	)
	section(
		'dependabot recreate',
		r.dependabotRecreate.map((x) => `#${x.pr}`)
	)
	section(
		'dependabot stalled',
		r.dependabotStalled.map((x) => `#${x.pr}`)
	)

	const flags = [
		r.releaseGated && 'release-gated',
		r.releaseStuck && 'release-stuck',
		r.releaseFailed && 'release-failed',
	].filter(Boolean)
	if (flags.length > 0) out.push(chalk.yellow(flags.join(' · ')))
	for (const w of r.warnings) out.push(chalk.yellow(`warn: ${w}`))
	for (const e of r.errors) out.push(chalk.red(`error: ${e}`))
	for (const s of r.staleInstall) out.push(chalk.yellow(`stale install: ${s}`))
	if (out.length === bodyStart) out.push(chalk.dim('nothing to do'))
	return out.join('\n')
}

function statusLine(root: string): string | undefined {
	try {
		return (
			fs.readFileSync(path.join(root, '.claude', 'ai-loop-status'), 'utf8').split('\n')[0] ||
			undefined
		)
	} catch {
		return undefined
	}
}

const CLEAR = '\u001b[2J\u001b[H'

export async function runLoopDash(options: LoopDashOptions = {}): Promise<void> {
	const root = path.resolve(options.root ?? process.cwd())
	const poll = options.poll ?? ((gh: GhExec) => runLoopTick({ root, gh }))
	const sleep = options.sleep ?? ((ms: number) => delay(ms))
	const write = options.write ?? ((text: string) => console.log(text))
	const tty = options.isTTY ?? Boolean(process.stdout.isTTY)
	const width = options.width ?? process.stdout.columns ?? 80
	const once = options.once || options.json || !tty
	const seconds = (await readConfig(root)).pollSeconds ?? DEFAULT_POLL_SECONDS
	const gh = await watchGh(root, options.gh ?? ((args, stdin) => realGhExec(args, stdin, root)))

	for (let i = 0; options.polls === undefined || i < options.polls; i++) {
		if (i > 0) await sleep(seconds * 1000)
		let r: LoopTickResult
		try {
			r = await poll(gh)
		} catch (err) {
			console.error(chalk.yellow(`poll failed: ${(err as Error).message}`))
			if (once) process.exitCode = 1
			if (once) return
			continue
		}
		if (options.json) {
			write(JSON.stringify(stripBodies(r), null, 2))
			return
		}
		write((once ? '' : CLEAR) + renderDash(r, width, statusLine(root)))
		if (once) return
	}
}

export async function loopDashCommand(options: { root?: string; once?: boolean; json?: boolean }) {
	await runLoopDash(options)
}
