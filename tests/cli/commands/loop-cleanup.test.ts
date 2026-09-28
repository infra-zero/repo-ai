import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import type { GhExec } from '../../../src/base/gh.js'
import { runLoopCleanup } from '../../../src/cli/commands/loop-cleanup.js'
import { useTmpDir } from '../../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		.toString()
		.trim()

/**
 * A checkout of a bare origin whose default branch is `branch`, with a real
 * `origin/HEAD` — the bare repo is empty at clone time, so `git clone` never
 * records it on its own; `remote set-head --auto` sets it once the branch has
 * been pushed, the way a real clone of a populated repo would already have it.
 */
function checkout(parent: string, branch = 'main'): string {
	const origin = join(parent, 'origin.git')
	git(parent, 'init', '-q', '--bare', '-b', branch, origin)
	const dir = join(parent, 'repo')
	git(parent, 'clone', '-q', origin, dir)
	git(dir, 'config', 'user.email', 'test@example.com')
	git(dir, 'config', 'user.name', 'Test')
	git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
	git(dir, 'push', '-q', 'origin', branch)
	git(dir, 'remote', 'set-head', 'origin', '--auto')
	return fs.realpathSync(dir)
}

/** Lands a squash subject on the default branch, the way GitHub would. */
function squash(root: string, subject: string, branch = 'main') {
	git(root, 'commit', '-q', '--allow-empty', '-m', subject)
	git(root, 'push', '-q', 'origin', branch)
}

function fakeGh(prs: Record<string, { number: number; state: string }>): GhExec {
	return async (args) => {
		const head = args[args.indexOf('--head') + 1] as string
		const pr = prs[head]
		return { ok: true, stdout: JSON.stringify(pr ? [pr] : []), stderr: '' }
	}
}

describe('runLoopCleanup', () => {
	it('removes landed and closed worktrees, keeps open and unlanded ones', async () => {
		const tmp = newTmpDir()
		const root = checkout(tmp)
		const wt = `${root}-worktrees`
		for (const slug of ['ai-1-landed', 'ai-2-unlanded', 'ai-3-closed', 'ai-4-open', 'ai-5-nopr']) {
			git(root, 'worktree', 'add', '-q', join(wt, slug), '-b', slug)
		}
		// Legacy root and legacy `worktree-` branch prefix.
		git(
			root,
			'worktree',
			'add',
			'-q',
			join(root, '.claude/worktrees/ai-6-legacy'),
			'-b',
			'worktree-ai-6-legacy'
		)
		squash(root, 'feat: landed (#11)')
		squash(root, 'feat: legacy (#16)')

		const result = await runLoopCleanup({
			root,
			gh: fakeGh({
				'ai-1-landed': { number: 11, state: 'MERGED' },
				'ai-2-unlanded': { number: 12, state: 'MERGED' },
				'ai-3-closed': { number: 13, state: 'CLOSED' },
				'ai-4-open': { number: 14, state: 'OPEN' },
				'worktree-ai-6-legacy': { number: 16, state: 'MERGED' },
			}),
		})

		const actions = Object.fromEntries(
			result.worktrees.map((w) => [w.path.split('/').pop(), w.action])
		)
		expect(actions).toEqual({
			'ai-1-landed': 'removed',
			'ai-2-unlanded': 'kept',
			'ai-3-closed': 'removed',
			'ai-4-open': 'kept',
			'ai-5-nopr': 'kept',
			'ai-6-legacy': 'removed',
		})
		expect(result.removed).toBe(true)
		expect(result.exitCode).toBe(0)
		expect(result.worktrees.find((w) => w.pr === 16)).toMatchObject({
			issue: 6,
			branch: 'worktree-ai-6-legacy',
		})
		expect(fs.existsSync(join(wt, 'ai-1-landed'))).toBe(false)
		expect(fs.existsSync(join(wt, 'ai-2-unlanded'))).toBe(true)
		expect(git(root, 'branch', '--list', 'ai-1-landed', 'worktree-ai-6-legacy')).toBe('')
		expect(git(root, 'branch', '--list', 'ai-2-unlanded')).not.toBe('')
	})

	it('reports removed: false when nothing is on disk', async () => {
		const root = checkout(newTmpDir())
		const result = await runLoopCleanup({ root, gh: fakeGh({}) })
		expect(result).toMatchObject({ removed: false, worktrees: [], exitCode: 0 })
	})

	it('reads a non-main default branch from origin/HEAD instead of assuming origin/main', async () => {
		const root = checkout(newTmpDir(), 'trunk')
		const wt = `${root}-worktrees`
		git(root, 'worktree', 'add', '-q', join(wt, 'ai-1-landed'), '-b', 'ai-1-landed')
		squash(root, 'feat: landed (#11)', 'trunk')

		const result = await runLoopCleanup({
			root,
			gh: fakeGh({ 'ai-1-landed': { number: 11, state: 'MERGED' } }),
		})

		expect(result.worktrees).toMatchObject([{ action: 'removed' }])
		expect(fs.existsSync(join(wt, 'ai-1-landed'))).toBe(false)
	})
})
