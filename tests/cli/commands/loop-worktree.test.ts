import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
	runLoopWorktreeAdd,
	runLoopWorktreeInstall,
} from '../../../src/cli/commands/loop-worktree.js'
import { useTmpDir } from '../../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		.toString()
		.trim()

function checkout(parent: string, symlinkDirectories?: unknown[]): string {
	const dir = join(parent, 'repo')
	fs.ensureDirSync(join(dir, 'node_modules'))
	fs.ensureDirSync(join(dir, 'apps', 'docs', 'node_modules'))
	git(dir, 'init', '-q', '-b', 'main')
	git(dir, 'config', 'user.email', 'test@example.com')
	git(dir, 'config', 'user.name', 'Test')
	fs.writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
	if (symlinkDirectories) {
		fs.outputJsonSync(join(dir, '.claude', 'settings.json'), { worktree: { symlinkDirectories } })
	}
	git(dir, 'add', '-A')
	git(dir, 'commit', '-qm', 'init')
	return fs.realpathSync(dir)
}

describe('runLoopWorktreeAdd', () => {
	it('creates the worktree, links every entry, and excludes the links from git', async () => {
		const root = checkout(newTmpDir(), [
			'node_modules',
			'apps/docs/node_modules',
			'packages/gone/node_modules',
			'../escape',
		])
		const r = await runLoopWorktreeAdd('ai-7-add-thing', { root, base: 'main' })
		expect(r.exitCode).toBe(0)
		expect(r.worktree).toBe(join(`${root}-worktrees`, 'ai-7-add-thing'))
		// an entry with nothing behind it, and one escaping the tree, are neither
		expect(r).toMatchObject({ linked: ['node_modules', 'apps/docs/node_modules'], missing: [] })
		expect(fs.lstatSync(join(r.worktree, 'apps/docs/node_modules')).isSymbolicLink()).toBe(true)
		expect(git(r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ai-7-add-thing')
		expect(git(r.worktree, 'status', '--porcelain')).toBe('')
		// idempotent: a second worktree does not append the line again
		await runLoopWorktreeAdd('ai-8-other', { root, base: 'main' })
		const exclude = fs.readFileSync(join(root, '.git/info/exclude'), 'utf8')
		expect(exclude.split('\n').filter((l) => l === 'node_modules')).toHaveLength(1)
	})

	it('reports needsInstall when the repo declares no symlink list', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopWorktreeAdd('ai-7-add-thing', { root, base: 'main' })
		expect(r).toMatchObject({ exitCode: 0, needsInstall: true, linked: [] })
		// #363: `fix ai` is repo-tooling's command; a bare `repo-ai fix ai` is an unknown target.
		expect(r.messages).toContain(
			'no worktree.symlinkDirectories — run a real install in the worktree (optional: `npx @rtorcato/repo-tooling fix ai` writes the list and restores the fast path)'
		)
	})

	it('fails when an entry cannot be linked', async () => {
		const root = checkout(newTmpDir(), ['node_modules'])
		// something already sits where the link must go
		const r = await runLoopWorktreeAdd('ai-7-add-thing', {
			root,
			base: 'main',
			git: async (args) => {
				const out = git(root, ...args)
				fs.ensureDirSync(join(args[2] as string, 'node_modules'))
				return out
			},
		})
		expect(r).toMatchObject({ exitCode: 1, missing: ['node_modules'] })
	})

	it('fails when the branch already exists', async () => {
		const root = checkout(newTmpDir())
		git(root, 'branch', 'ai-7-add-thing')
		const r = await runLoopWorktreeAdd('ai-7-add-thing', { root, base: 'main' })
		expect(r.exitCode).toBe(1)
		expect(fs.existsSync(r.worktree)).toBe(false)
	})

	it.each(['../ai-7-x', 'ai-7', 'ai-x-thing', '--force'])('rejects slug %s', async (slug) => {
		const root = checkout(newTmpDir())
		const r = await runLoopWorktreeAdd(slug, { root, base: 'main', git: async () => '' })
		expect(r.exitCode).toBe(1)
	})

	it('rejects a base that git would read as an option', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopWorktreeAdd('ai-7-x', { root, base: '--detach', git: async () => '' })
		expect(r.exitCode).toBe(1)
		expect(r.messages[0]).toMatch(/not a ref/)
	})

	it('resolves the default branch itself when no --base is given', async () => {
		const tmp = newTmpDir()
		const origin = join(tmp, 'origin.git')
		git(tmp, 'init', '-q', '--bare', '-b', 'trunk', origin)
		const root = join(tmp, 'repo')
		git(tmp, 'clone', '-q', origin, root)
		git(root, 'config', 'user.email', 'test@example.com')
		git(root, 'config', 'user.name', 'Test')
		git(root, 'commit', '-q', '--allow-empty', '-m', 'init')
		git(root, 'push', '-q', 'origin', 'trunk')
		// The bare origin is empty at clone time, so `clone` never set origin/HEAD on its own.
		git(root, 'remote', 'set-head', 'origin', '--auto')

		const r = await runLoopWorktreeAdd('ai-7-add-thing', { root: fs.realpathSync(root) })
		expect(r.exitCode).toBe(0)
		expect(git(r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ai-7-add-thing')
	})

	it('reports failure when no --base is given and the default branch cannot be resolved', async () => {
		const root = checkout(newTmpDir())
		const r = await runLoopWorktreeAdd('ai-7-add-thing', {
			root,
			gh: async () => ({ ok: false, stdout: '', stderr: 'no repo' }),
		})
		expect(r.exitCode).toBe(1)
		expect(r.messages[0]).toMatch(/could not resolve the default branch/)
	})
})

describe('runLoopWorktreeInstall (#394)', () => {
	function setup(files: Record<string, string>) {
		const root = join(fs.realpathSync(newTmpDir()), 'repo')
		const worktree = join(`${root}-worktrees`, 'ai-1-x')
		for (const [file, body] of Object.entries(files)) {
			fs.outputFileSync(join(root, file), body)
			fs.outputFileSync(join(worktree, file), body)
		}
		const calls: [string[], string][] = []
		const run = (args: string[], cwd: string) => {
			calls.push([args, cwd])
			return 0
		}
		return { root, worktree, calls, run }
	}

	it('runs the Yarn 2+ install with the worktree as its working directory', async () => {
		const { root, worktree, calls, run } = setup({ 'yarn.lock': '', '.yarnrc.yml': '' })
		expect((await runLoopWorktreeInstall(worktree, { root, run })).exitCode).toBe(0)
		expect(calls).toEqual([[['install', '--mode=skip-build'], worktree]])
	})

	it("passes yarn's exit code through", async () => {
		const { root, worktree } = setup({ 'yarn.lock': '', '.yarnrc.yml': '' })
		expect((await runLoopWorktreeInstall(worktree, { root, run: () => 2 })).exitCode).toBe(2)
	})

	it('refuses the main checkout, the worktree root and a path outside it', async () => {
		const { root, worktree, calls, run } = setup({ 'yarn.lock': '', '.yarnrc.yml': '' })
		for (const dir of [root, `${root}-worktrees`, join(worktree, '..', '..', 'repo'), newTmpDir()])
			expect((await runLoopWorktreeInstall(dir, { root, run })).exitCode).toBe(1)
		expect(calls).toEqual([])
	})

	it('refuses a Yarn 1 checkout and a missing worktree', async () => {
		const { root, worktree, calls, run } = setup({ 'yarn.lock': '' })
		expect((await runLoopWorktreeInstall(worktree, { root, run })).exitCode).toBe(1)
		expect((await runLoopWorktreeInstall(`${worktree}-gone`, { root, run })).exitCode).toBe(1)
		expect(calls).toEqual([])
	})
})
