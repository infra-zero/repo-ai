import { describe, expect, it } from 'vitest'
import type { GhResult } from '../../src/base/gh.js'
import {
	type CmdExec,
	checkPrerequisites,
	ghFailure,
	versionAtLeast,
} from '../../src/base/prereqs.js'

const ok = (stdout: string): GhResult => ({ ok: true, stdout, stderr: '', code: 0 })
const fail = (stderr: string, code: number | null = 1): GhResult => ({
	ok: false,
	stdout: '',
	stderr,
	code,
})
const enoent = (cmd: string) => fail(`Error: spawn ${cmd} ENOENT`, null)

/** A healthy machine; `over` replaces the answer for `"<cmd> <args>"`. */
function machine(over: Record<string, GhResult> = {}): CmdExec {
	const base: Record<string, GhResult> = {
		'git --version': ok('git version 2.50.0\n'),
		'gh --version': ok('gh version 2.80.0 (2026-01-01)\n'),
		'gh auth status --active': ok(''),
		'git remote get-url origin': ok('git@github.com:acme/widget.git\n'),
		'claude --version': ok('2.1.0 (Claude Code)\n'),
	}
	return async (cmd, args) => {
		const key = `${cmd} ${args.join(' ')}`
		return over[key] ?? base[key] ?? fail(`unexpected ${key}`)
	}
}

const byCheck = (results: { check: string }[], check: string) =>
	results.find((r) => r.check === check)

describe('checkPrerequisites (#359)', () => {
	it('is all ok on a healthy machine', async () => {
		const { results, ghBlocked } = await checkPrerequisites('/x', machine(), '22.1.0', {})
		expect(results.every((r) => r.status === 'ok')).toBe(true)
		expect(ghBlocked).toBeUndefined()
	})

	it('reports a missing gh as ✗ with an install hint, and skips auth as not run', async () => {
		const { results, ghBlocked } = await checkPrerequisites(
			'/x',
			machine({ 'gh --version': enoent('gh'), 'gh auth status --active': fail('should not run') }),
			'22.1.0',
			{}
		)
		expect(byCheck(results, 'gh')).toMatchObject({
			status: 'missing',
			hint: expect.stringContaining('https://cli.github.com'),
		})
		expect(byCheck(results, 'gh auth')).toMatchObject({
			status: 'optional-missing',
			detail: 'not run because gh is unavailable',
		})
		expect(ghBlocked).toBe('gh is unavailable')
	})

	it("surfaces gh's own stderr when logged out", async () => {
		const { results, ghBlocked } = await checkPrerequisites(
			'/x',
			machine({
				'gh auth status --active': fail(
					'You are not logged into any GitHub hosts. To log in, run: gh auth login\n'
				),
			}),
			'22.1.0',
			{}
		)
		expect(byCheck(results, 'gh auth')).toMatchObject({
			status: 'missing',
			detail: expect.stringContaining('not logged into any GitHub hosts'),
		})
		expect(ghBlocked).toBe('gh is not logged in')
	})

	it('flags a non-GitHub origin and never prints its credentials', async () => {
		const { results, ghBlocked } = await checkPrerequisites(
			'/x',
			machine({
				'git remote get-url origin': ok('https://user:s3cret@gitlab.com/acme/widget.git\n'),
			}),
			'22.1.0',
			{}
		)
		const remote = byCheck(results, 'GitHub remote')
		expect(remote).toMatchObject({ status: 'missing' })
		expect(JSON.stringify(results)).not.toContain('s3cret')
		expect(ghBlocked).toBe('origin is not a GitHub remote')
	})

	it('does not take a lookalike host for github.com', async () => {
		const { results } = await checkPrerequisites(
			'/x',
			machine({ 'git remote get-url origin': ok('https://notgithub.com/acme/widget\n') }),
			'22.1.0',
			{}
		)
		expect(byCheck(results, 'GitHub remote')?.status).toBe('missing')
	})

	it('accepts a GH_HOST remote for GitHub Enterprise', async () => {
		const { results } = await checkPrerequisites(
			'/x',
			machine({ 'git remote get-url origin': ok('git@ghe.acme.io:acme/widget.git\n') }),
			'22.1.0',
			{ GH_HOST: 'ghe.acme.io' }
		)
		expect(byCheck(results, 'GitHub remote')?.status).toBe('ok')
	})

	it('reports outside a git repository', async () => {
		const { results, ghBlocked } = await checkPrerequisites(
			'/x',
			machine({
				'git remote get-url origin': fail(
					'fatal: not a git repository (or any of the parent directories): .git\n',
					128
				),
			}),
			'22.1.0',
			{}
		)
		expect(byCheck(results, 'GitHub remote')).toMatchObject({
			status: 'missing',
			detail: 'not a git repository',
		})
		expect(ghBlocked).toBe('there is no GitHub origin remote')
	})

	it('fails an old Node, a missing claude and an old claude', async () => {
		const old = await checkPrerequisites('/x', machine(), '20.11.0', {})
		expect(byCheck(old.results, 'Node')?.status).toBe('missing')

		const none = await checkPrerequisites(
			'/x',
			machine({ 'claude --version': enoent('claude') }),
			'22.1.0',
			{}
		)
		expect(byCheck(none.results, 'Claude Code')).toMatchObject({
			status: 'missing',
			hint: expect.stringContaining('npm install -g @anthropic-ai/claude-code'),
		})
		// Claude Code is not a GitHub prerequisite.
		expect(none.ghBlocked).toBeUndefined()

		const stale = await checkPrerequisites(
			'/x',
			machine({ 'claude --version': ok('1.0.9 (Claude Code)\n') }),
			'22.1.0',
			{}
		)
		expect(byCheck(stale.results, 'Claude Code')?.status).toBe('missing')
	})
})

it('falls back to plain `gh auth status` on a gh without --active', async () => {
	const { results } = await checkPrerequisites(
		'/x',
		machine({
			'gh auth status --active': fail('unknown flag: --active\n'),
			'gh auth status': ok(''),
		}),
		'22.1.0',
		{}
	)
	expect(results.find((r) => r.check === 'gh auth')?.status).toBe('ok')
})

describe('ghFailure', () => {
	it('names a missing binary, else the first stderr line', () => {
		expect(ghFailure(enoent('gh'))).toBe('gh is not on PATH')
		expect(ghFailure(fail('\n  HTTP 401: Bad credentials\nmore\n'))).toBe(
			'HTTP 401: Bad credentials'
		)
		expect(ghFailure(fail('', 4))).toBe('gh exited 4')
	})
})

describe('versionAtLeast', () => {
	it('compares numerically, not as strings', () => {
		expect(versionAtLeast('2.10.0', '2.9.0')).toBe(true)
		expect(versionAtLeast('2.0.0', '2.0.0')).toBe(true)
		expect(versionAtLeast('1.99.99', '2.0.0')).toBe(false)
	})
})
