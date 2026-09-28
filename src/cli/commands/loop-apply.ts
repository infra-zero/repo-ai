import path from 'node:path'
import chalk from 'chalk'
import type { GitExec } from '../../base/git.js'
import type { GhExec } from '../../base/gh.js'
import { type CleanupEntry, runLoopCleanup } from './loop-cleanup.js'
import { type InstallExec, type RebuildOutcome, runLoopGuard } from './loop-guard.js'

/**
 * `repo-ai loop apply` — the local writes `loop tick` no longer makes (#149).
 * `loop tick` is read-only and reports `toClean`; this removes those worktrees
 * (re-checking each: PR closed, or its `(#<PR>)` squash landed), then runs
 * `loop guard --removed` for the `node_modules` rebuild.
 *
 * Label, assignee and merge transitions join it in #147.
 *
 * Exit non-zero only to halt the tick, with `loop guard`'s own code. A failed
 * removal is not a halt: it lands in `errors` and the next apply retries it.
 */

export interface LoopApplyResult {
	/** Worktrees removed; relabel each `issue`. */
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
	/** Test seams. */
	git?: GitExec
	gh?: GhExec
	install?: InstallExec
}

export async function runLoopApply(options: LoopApplyOptions = {}): Promise<LoopApplyResult> {
	const root = path.resolve(options.root ?? process.cwd())
	const seams = { root, worktreeRoot: options.worktreeRoot, git: options.git, gh: options.gh }
	const cleanup = await runLoopCleanup(seams)
	const result: LoopApplyResult = {
		removed: cleanup.worktrees.filter((w) => w.action === 'removed'),
		rebuild: 'not-requested',
		halt: null,
		errors: cleanup.worktrees
			.filter((w) => w.action === 'remove-failed')
			.map((w) => `could not remove ${w.path}`),
		exitCode: 0,
	}
	if (!cleanup.removed) return result
	const guard = await runLoopGuard({ ...seams, install: options.install, removed: true })
	result.rebuild = guard.rebuild
	if (guard.exitCode !== 0) {
		result.halt = guard.messages.filter((m) => m.startsWith('⚠')).join('; ') || 'loop guard failed'
		result.exitCode = guard.exitCode
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
		for (const w of result.removed) console.log(`  removed ${path.basename(w.path)} — ${w.reason}`)
		for (const e of result.errors) console.log(`  ${chalk.red(`error: ${e}`)}`)
		if (result.rebuild !== 'not-requested') console.log(`  rebuild: ${result.rebuild}`)
	}
	process.exitCode = result.exitCode
}
