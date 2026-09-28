import { describe, expect, it } from 'vitest'
import { ciRunWarning } from '../../src/base/ci-runs.js'
import type { GhExec, GhResult } from '../../src/base/gh.js'

const NOW = Date.parse('2026-06-01T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

const run = (
	over: Partial<{
		id: number
		status: string
		conclusion: string | null
		created_at: string
		path: string
	}> = {}
) => ({
	id: 1,
	status: 'completed',
	conclusion: 'success',
	html_url: `https://github.com/acme/widget/actions/runs/${over.id ?? 1}`,
	created_at: minutesAgo(5),
	path: '.github/workflows/ci.yml',
	...over,
})

/** `runs`: the `workflow_runs` list. `jobs`: run id → job total_count. */
function fakeGh(runs: ReturnType<typeof run>[], jobs: Record<number, number> = {}): GhExec {
	return async (args): Promise<GhResult> => {
		const ok = (v: unknown) => ({ ok: true, stdout: JSON.stringify(v), stderr: '', code: 0 })
		const path = args[1] ?? ''
		if (path.includes('/actions/runs?')) return ok({ workflow_runs: runs })
		const jobsMatch = path.match(/\/actions\/runs\/(\d+)\/jobs/)
		if (jobsMatch) return ok({ total_count: jobs[Number(jobsMatch[1])] ?? 0 })
		return { ok: false, stdout: '', stderr: 'unexpected', code: 1 }
	}
}

describe('ciRunWarning (#153)', () => {
	it('warns when the latest completed run was cancelled with no jobs', async () => {
		const gh = fakeGh([run({ id: 9, status: 'completed', conclusion: 'cancelled' })], { 9: 0 })
		const w = await ciRunWarning(gh, 'acme/widget', NOW)
		expect(w).toContain('cancelled with no jobs')
		expect(w).toContain('runs/9')
	})

	it('does not warn on a cancelled run that actually ran jobs', async () => {
		const gh = fakeGh([run({ id: 9, status: 'completed', conclusion: 'cancelled' })], { 9: 3 })
		expect(await ciRunWarning(gh, 'acme/widget', NOW)).toBeNull()
	})

	it('warns when the latest run has sat pending with no jobs past 30 minutes', async () => {
		const gh = fakeGh(
			[run({ id: 10, status: 'in_progress', conclusion: null, created_at: minutesAgo(45) })],
			{ 10: 0 }
		)
		const w = await ciRunWarning(gh, 'acme/widget', NOW)
		expect(w).toContain('pending with no jobs')
		expect(w).toContain('runs/10')
	})

	it('does not warn on a pending run still inside the grace window', async () => {
		const gh = fakeGh(
			[run({ id: 10, status: 'in_progress', conclusion: null, created_at: minutesAgo(10) })],
			{ 10: 0 }
		)
		expect(await ciRunWarning(gh, 'acme/widget', NOW)).toBeNull()
	})

	it('does not warn on a pending run that already has jobs running', async () => {
		const gh = fakeGh(
			[run({ id: 10, status: 'in_progress', conclusion: null, created_at: minutesAgo(45) })],
			{ 10: 2 }
		)
		expect(await ciRunWarning(gh, 'acme/widget', NOW)).toBeNull()
	})

	it('checks the latest completed run even when a fresh run is already in flight', async () => {
		const gh = fakeGh(
			[
				run({ id: 11, status: 'in_progress', conclusion: null, created_at: minutesAgo(2) }),
				run({ id: 9, status: 'completed', conclusion: 'cancelled' }),
			],
			{ 9: 0, 11: 0 }
		)
		const w = await ciRunWarning(gh, 'acme/widget', NOW)
		expect(w).toContain('runs/9')
	})

	it('is healthy on a normal green history', async () => {
		const gh = fakeGh([run({ id: 9, status: 'completed', conclusion: 'success' })])
		expect(await ciRunWarning(gh, 'acme/widget', NOW)).toBeNull()
	})

	it('ignores runs from other workflows', async () => {
		const gh = fakeGh([
			run({
				id: 9,
				status: 'completed',
				conclusion: 'cancelled',
				path: '.github/workflows/deploy.yml',
			}),
		])
		expect(await ciRunWarning(gh, 'acme/widget', NOW)).toBeNull()
	})

	it('fails open when gh cannot list runs', async () => {
		const gh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'offline', code: 1 })
		expect(await ciRunWarning(gh, 'acme/widget', NOW)).toBeNull()
	})

	it('fails open when the jobs count is unreadable', async () => {
		const gh: GhExec = async (args) => {
			const path = args[1] ?? ''
			if (path.includes('/actions/runs?'))
				return {
					ok: true,
					stdout: JSON.stringify({
						workflow_runs: [run({ id: 9, status: 'completed', conclusion: 'cancelled' })],
					}),
					stderr: '',
					code: 0,
				}
			return { ok: false, stdout: '', stderr: 'rate limited', code: 1 }
		}
		expect(await ciRunWarning(gh, 'acme/widget', NOW)).toBeNull()
	})
})
