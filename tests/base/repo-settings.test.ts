import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GhExec } from '../../src/base/gh.js'
import { fixRepoSettings } from '../../src/base/repo-settings.js'

const LOOP_READY = {
	allow_squash_merge: true,
	allow_merge_commit: false,
	allow_rebase_merge: false,
	allow_auto_merge: true,
	delete_branch_on_merge: true,
}

/** A repo answering reads from `w`; every write is recorded, with its JSON body. */
function stub(w: {
	repo?: Record<string, boolean>
	protection?: unknown | 'none' | 'forbidden'
	runs?: string[]
}) {
	const writes: { args: string[]; body?: unknown }[] = []
	const gh: GhExec = async (args, stdin) => {
		const ok = (v: unknown) => ({ ok: true, stdout: JSON.stringify(v), stderr: '', code: 0 })
		const route = args.find((a) => a.startsWith('repos/')) ?? ''
		if (args.includes('-X')) {
			writes.push({ args, body: stdin ? JSON.parse(stdin) : undefined })
			return ok({})
		}
		if (args[0] === 'repo')
			return ok({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } })
		if (route === 'repos/acme/widget') return ok(w.repo ?? LOOP_READY)
		if (route.endsWith('/protection')) {
			if (w.protection === 'forbidden')
				return { ok: false, stdout: '', stderr: 'HTTP 403: Resource not accessible', code: 1 }
			if (w.protection === undefined || w.protection === 'none')
				return { ok: false, stdout: '', stderr: 'HTTP 404: Branch not protected', code: 1 }
			return ok(w.protection)
		}
		if (route.includes('/check-runs')) return ok(w.runs ?? [])
		return { ok: false, stdout: '', stderr: `unexpected ${args.join(' ')}`, code: 1 }
	}
	return { gh, writes }
}

const yes = { yes: true }
const never = async () => {
	throw new Error('must not prompt')
}

describe('fixRepoSettings (#362)', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('sets only the loop settings, then asks which seen checks to require on an unprotected branch', async () => {
		const { gh, writes } = stub({
			repo: { ...LOOP_READY, allow_merge_commit: true, allow_auto_merge: false },
			runs: ['test', 'lint', 'test'],
		})
		const pickChecks = vi.fn(async () => ['test'])
		const done = await fixRepoSettings('.', {}, { gh, pickChecks, confirm: async () => true })
		expect(pickChecks).toHaveBeenCalledWith(['lint', 'test'])
		expect(writes).toEqual([
			{
				args: ['api', '-X', 'PATCH', 'repos/acme/widget', '--input', '-'],
				body: { allow_merge_commit: false, allow_auto_merge: true },
			},
			{
				args: ['api', '-X', 'PUT', 'repos/acme/widget/branches/main/protection', '--input', '-'],
				body: {
					required_status_checks: { strict: false, contexts: ['test'] },
					enforce_admins: false,
					required_pull_request_reviews: null,
					restrictions: null,
				},
			},
		])
		expect(done).toHaveLength(2)
	})

	it('keeps existing required checks and drops only a required review', async () => {
		const { gh, writes } = stub({
			protection: {
				required_status_checks: { contexts: ['ci'] },
				required_pull_request_reviews: { required_approving_review_count: 1 },
				enforce_admins: { enabled: true },
			},
		})
		await fixRepoSettings('.', yes, { gh, pickChecks: never, confirm: never })
		expect(writes).toEqual([
			{
				args: [
					'api',
					'-X',
					'DELETE',
					'repos/acme/widget/branches/main/protection/required_pull_request_reviews',
				],
				body: undefined,
			},
		])
	})

	it('adds picked checks to existing protection without replacing it', async () => {
		const { gh, writes } = stub({
			protection: { enforce_admins: { enabled: true }, required_status_checks: { contexts: [] } },
			runs: ['ci'],
		})
		await fixRepoSettings(
			'.',
			{},
			{ gh, pickChecks: async () => ['ci'], confirm: async () => true }
		)
		expect(writes.map((w) => w.args.slice(2, 4))).toEqual([
			['PATCH', 'repos/acme/widget/branches/main/protection/required_status_checks'],
		])
		expect(writes[0]?.body).toEqual({ strict: false, contexts: ['ci'] })
	})

	it('skips checks on a branch protected without a status-check rule, which would 404', async () => {
		const { gh, writes } = stub({
			protection: {
				required_status_checks: null,
				required_pull_request_reviews: { required_approving_review_count: 1 },
			},
			runs: ['ci'],
		})
		const write = gh
		const stubbed: GhExec = async (args, stdin) =>
			args.at(-3)?.endsWith('/required_status_checks')
				? { ok: false, stdout: '', stderr: 'HTTP 404: Required status checks not enabled', code: 1 }
				: write(args, stdin)
		const done = await fixRepoSettings(
			'.',
			{},
			{ gh: stubbed, pickChecks: never, confirm: async () => true }
		)
		expect(writes.map((w) => w.args[2])).toEqual(['DELETE'])
		expect(done).toEqual(['main: no required reviews'])
	})

	it('under --yes with no required checks, requires none and names the candidates', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const { gh, writes } = stub({ runs: ['build', 'test'] })
		expect(await fixRepoSettings('.', yes, { gh, pickChecks: never, confirm: never })).toEqual([])
		expect(writes).toEqual([])
		expect(error.mock.calls.flat().join('\n')).toContain(
			'requiring none. Checks seen on main: build, test'
		)
	})

	it('writes nothing when declined, or when everything already matches', async () => {
		const declined = stub({ repo: { ...LOOP_READY, delete_branch_on_merge: false } })
		await fixRepoSettings(
			'.',
			{},
			{ gh: declined.gh, pickChecks: never, confirm: async () => false }
		)
		expect(declined.writes).toEqual([])

		const ready = stub({ protection: { required_status_checks: { contexts: ['ci'] } } })
		expect(await fixRepoSettings('.', yes, { gh: ready.gh })).toEqual([])
		expect(ready.writes).toEqual([])
	})

	it('aborts cleanly, not with a stack trace, on output that is not JSON', async () => {
		const gh: GhExec = async () => ({ ok: true, stdout: 'acme/widget\n', stderr: '', code: 0 })
		await expect(fixRepoSettings('.', yes, { gh })).rejects.toThrow('could not read the repo')
	})

	it('aborts, writing nothing, when it cannot read the branch protection', async () => {
		const { gh, writes } = stub({ protection: 'forbidden' })
		await expect(fixRepoSettings('.', yes, { gh })).rejects.toThrow('HTTP 403')
		expect(writes).toEqual([])
	})
})
