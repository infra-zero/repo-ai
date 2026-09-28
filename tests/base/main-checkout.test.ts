import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mainCheckout } from '../../src/base/git.js'

describe('mainCheckout (#150)', () => {
	it('resolves the main checkout from a linked worktree', () => {
		const repo = realpathSync(mkdtempSync(join(tmpdir(), 'mc-')))
		const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args])
		git('init', '-q')
		git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
		git('worktree', 'add', '-q', join(repo, 'wt'))
		expect(mainCheckout(join(repo, 'wt'))).toBe(repo)
		expect(mainCheckout(repo)).toBe(repo)
	})

	it('falls back to the directory outside a repository', () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mc-')))
		expect(mainCheckout(dir)).toBe(dir)
	})
})
