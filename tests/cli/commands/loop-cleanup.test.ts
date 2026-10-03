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

function fakeGh(prs: Record<string, { number: number; state: string; closedAt?: string }>): GhExec {
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
		squash(root, 'feat: landed (#11)')

		const result = await runLoopCleanup({
			root,
			gh: fakeGh({
				'ai-1-landed': { number: 11, state: 'MERGED' },
				'ai-2-unlanded': { number: 12, state: 'MERGED' },
				'ai-3-closed': { number: 13, state: 'CLOSED' },
				'ai-4-open': { number: 14, state: 'OPEN' },
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
		})
		expect(result.removed).toBe(true)
		expect(result.exitCode).toBe(0)
		expect(fs.existsSync(join(wt, 'ai-1-landed'))).toBe(false)
		expect(fs.existsSync(join(wt, 'ai-2-unlanded'))).toBe(true)
		expect(git(root, 'branch', '--list', 'ai-1-landed')).toBe('')
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

	it('dryRun marks what it would remove and removes nothing (#149)', async () => {
		const root = checkout(newTmpDir())
		const wt = join(`${root}-worktrees`, 'ai-3-closed')
		git(root, 'worktree', 'add', '-q', wt, '-b', 'ai-3-closed')
		const result = await runLoopCleanup({
			root,
			dryRun: true,
			gh: fakeGh({ 'ai-3-closed': { number: 13, state: 'CLOSED' } }),
		})
		expect(result).toMatchObject({ removed: false, worktrees: [{ action: 'to-remove' }] })
		expect(fs.existsSync(wt)).toBe(true)
	})

	it('keeps a worktree created after its PR closed, and prefers an open PR (#269)', async () => {
		const root = checkout(newTmpDir())
		const wt = `${root}-worktrees`
		git(root, 'worktree', 'add', '-q', join(wt, 'ai-6-repick'), '-b', 'ai-6-repick')
		git(root, 'worktree', 'add', '-q', join(wt, 'ai-7-open'), '-b', 'ai-7-open')
		const gh: GhExec = async (args) => {
			const head = args[args.indexOf('--head') + 1]
			const old = { number: 20, state: 'CLOSED', closedAt: '2020-01-01T00:00:00Z' }
			const prs = head === 'ai-7-open' ? [old, { number: 21, state: 'OPEN' }] : [old]
			return { ok: true, stdout: JSON.stringify(prs), stderr: '' }
		}
		const result = await runLoopCleanup({ root, dryRun: true, gh })
		expect(result.worktrees.map((w) => w.action)).toEqual(['kept', 'kept'])
	})
})
