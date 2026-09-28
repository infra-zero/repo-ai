import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { resolveDefaultBranch } from '../../src/base/default-branch.js'
import type { GhExec } from '../../src/base/gh.js'
import { realGitExec } from '../../src/base/git.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		.toString()
		.trim()

/**
 * A checkout of a bare origin whose default branch is `branch`. The bare repo
 * is empty at clone time, so `git clone` never records origin/HEAD on its
 * own (it only mirrors a branch that already exists on the remote) —
 * `remote set-head --auto` sets it explicitly once the branch has been
 * pushed, the way a real clone of a populated repo would already have it.
 */
function checkout(parent: string, branch: string): string {
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

const failingGh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'no repo' })

describe('resolveDefaultBranch', () => {
	it('reads a non-main default branch from origin/HEAD', async () => {
		const root = checkout(newTmpDir(), 'trunk')
		const gitExec = (args: string[]) => realGitExec(args, root)
		expect(await resolveDefaultBranch(gitExec, failingGh)).toBe('trunk')
	})

	it('falls back to gh repo view when origin/HEAD was never recorded locally', async () => {
		const gh: GhExec = async (args) =>
			args.includes('defaultBranchRef')
				? { ok: true, stdout: 'master\n', stderr: '' }
				: { ok: false, stdout: '', stderr: '' }
		expect(await resolveDefaultBranch(async () => null, gh)).toBe('master')
	})

	it('resolves empty when neither git nor gh knows', async () => {
		expect(await resolveDefaultBranch(async () => null, failingGh)).toBe('')
	})
})
