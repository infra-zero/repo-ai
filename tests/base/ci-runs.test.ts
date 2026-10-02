import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ciRunWarning, releaseFailedWarning, releaseStuckWarning } from '../../src/base/ci-runs.js'
import type { GhExec, GhResult } from '../../src/base/gh.js'

const NOW = Date.parse('2026-06-01T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

const run = (
	over: Partial<{
		id: number
		status: string
		conclusion: string | null
		created_at: string
		head_sha: string
	}> = {}
) => ({
	id: 1,
	status: 'completed',
	conclusion: 'success',
	html_url: `https://github.com/acme/widget/actions/runs/${over.id ?? 1}`,
	created_at: minutesAgo(5),
	head_sha: 'aaaaaaa1111',
	...over,
})

/** `runs`: the `workflow_runs` list. `jobs`: run id → job total_count. */
function fakeGh(runs: ReturnType<typeof run>[], jobs: Record<number, number> = {}): GhExec {
	return async (args): Promise<GhResult> => {
		const ok = (v: unknown) => ({ ok: true, stdout: JSON.stringify(v), stderr: '', code: 0 })
		const path = args[1] ?? ''
		if (path.includes('/actions/workflows/ci.yml/runs?')) return ok({ workflow_runs: runs })
		const jobsMatch = path.match(/\/actions\/runs\/(\d+)\/jobs/)
		if (jobsMatch) return ok({ total_count: jobs[Number(jobsMatch[1])] ?? 0 })
		return { ok: false, stdout: '', stderr: 'unexpected', code: 1 }
	}
}

describe('ciRunWarning (#153)', () => {
	it('warns when the latest completed run was cancelled with no jobs', async () => {
		const gh = fakeGh([run({ id: 9, status: 'completed', conclusion: 'cancelled' })], { 9: 0 })
		const w = await ciRunWarning(gh, 'acme/widget', 'main', NOW)
		expect(w).toContain('cancelled with no jobs')
		expect(w).toContain('runs/9')
	})

	it('does not warn on a cancelled run that actually ran jobs', async () => {
		const gh = fakeGh([run({ id: 9, status: 'completed', conclusion: 'cancelled' })], { 9: 3 })
		expect(await ciRunWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})

	it('warns when the latest run has sat pending with no jobs past 30 minutes', async () => {
		const gh = fakeGh(
			[run({ id: 10, status: 'in_progress', conclusion: null, created_at: minutesAgo(45) })],
			{ 10: 0 }
		)
		const w = await ciRunWarning(gh, 'acme/widget', 'main', NOW)
		expect(w).toContain('pending with no jobs')
		expect(w).toContain('runs/10')
	})

	it('does not warn on a pending run still inside the grace window', async () => {
		const gh = fakeGh(
			[run({ id: 10, status: 'in_progress', conclusion: null, created_at: minutesAgo(10) })],
			{ 10: 0 }
		)
		expect(await ciRunWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})

	it('does not warn on a pending run that already has jobs running', async () => {
		const gh = fakeGh(
			[run({ id: 10, status: 'in_progress', conclusion: null, created_at: minutesAgo(45) })],
			{ 10: 2 }
		)
		expect(await ciRunWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})

	it('checks the latest completed run even when a fresh run is already in flight', async () => {
		const gh = fakeGh(
			[
				run({ id: 11, status: 'in_progress', conclusion: null, created_at: minutesAgo(2) }),
				run({ id: 9, status: 'completed', conclusion: 'cancelled' }),
			],
			{ 9: 0, 11: 0 }
		)
		const w = await ciRunWarning(gh, 'acme/widget', 'main', NOW)
		expect(w).toContain('runs/9')
	})

	it('is healthy on a normal green history', async () => {
		const gh = fakeGh([run({ id: 9, status: 'completed', conclusion: 'success' })])
		expect(await ciRunWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})

	it('asks for ci.yml runs only, so other push workflows cannot dilute the window (#174)', async () => {
		const paths: string[] = []
		const inner = fakeGh([run()])
		const gh: GhExec = async (args) => {
			paths.push(args[1] ?? '')
			return inner(args)
		}
		await ciRunWarning(gh, 'acme/widget', 'main', NOW)
		expect(paths[0]).toBe(
			'repos/acme/widget/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=5'
		)
	})

	it('queries a configured ciWorkflow instead of ci.yml (#201)', async () => {
		const paths: string[] = []
		const gh: GhExec = async (args) => {
			paths.push(args[1] ?? '')
			return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: '', code: 0 }
		}
		await ciRunWarning(gh, 'acme/widget', 'main', NOW, 'test.yml')
		await releaseStuckWarning(gh, 'acme/widget', 'main', NOW, 'test.yml')
		await releaseFailedWarning(gh, 'acme/widget', 'main', 'test.yml')
		expect(paths).toHaveLength(3)
		for (const p of paths) expect(p).toContain('/actions/workflows/test.yml/runs?')
	})

	it("queries the repo's default branch, not a hardcoded main (#179)", async () => {
		const paths: string[] = []
		const inner = fakeGh([run()])
		const gh: GhExec = async (args) => {
			paths.push(args[1] ?? '')
			return inner(args)
		}
		await ciRunWarning(gh, 'acme/widget', 'trunk', NOW)
		expect(paths[0]).toContain('branch=trunk&')
	})

	it('skips without calling gh when the default branch is unresolved', async () => {
		const gh: GhExec = async () => {
			throw new Error('gh should not be called')
		}
		expect(await ciRunWarning(gh, 'acme/widget', '', NOW)).toBeNull()
	})

	it('fails open when gh cannot list runs', async () => {
		const gh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'offline', code: 1 })
		expect(await ciRunWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})

	it('fails open when the jobs count is unreadable', async () => {
		const gh: GhExec = async (args) => {
			const path = args[1] ?? ''
			if (path.includes('/actions/workflows/ci.yml/runs?'))
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
		expect(await ciRunWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})
})

describe('releaseStuckWarning (#146)', () => {
	const runsGh =
		(runs: ReturnType<typeof run>[]): GhExec =>
		async (args): Promise<GhResult> => {
			const path = args[1] ?? ''
			if (path.includes('/actions/workflows/ci.yml/runs?'))
				return { ok: true, stdout: JSON.stringify({ workflow_runs: runs }), stderr: '', code: 0 }
			return { ok: false, stdout: '', stderr: 'unexpected', code: 1 }
		}

	it('warns when a run has sat waiting on approval past an hour', async () => {
		const gh = runsGh([
			run({ id: 9, status: 'waiting', conclusion: null, created_at: hoursAgo(2) }),
		])
		const w = await releaseStuckWarning(gh, 'acme/widget', 'main', NOW)
		expect(w).toContain('waiting on approval')
		expect(w).toContain('9')
		expect(w).toContain('runs/9')
	})

	it('does not warn on a run at the head still inside the hour grace window', async () => {
		const gh = runsGh([
			run({ id: 9, status: 'waiting', conclusion: null, created_at: minutesAgo(30) }),
		])
		expect(await releaseStuckWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})

	it('warns at once when a newer push run sits behind the waiting one (#220)', async () => {
		const gh = runsGh([
			run({ id: 10, status: 'completed', conclusion: 'cancelled', head_sha: 'bbbbbbb2222' }),
			run({ id: 9, status: 'waiting', conclusion: null, created_at: minutesAgo(10) }),
		])
		const w = await releaseStuckWarning(gh, 'acme/widget', 'main', NOW)
		expect(w).toContain('aaaaaaa')
		expect(w).toContain('bbbbbbb')
		expect(w).toContain('cancel it')
		expect(w).toContain('runs/9')
	})

	it('does not warn on a pending run', async () => {
		const gh = runsGh([
			run({ id: 9, status: 'in_progress', conclusion: null, created_at: hoursAgo(25) }),
		])
		expect(await releaseStuckWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})

	it('does not warn on a completed run', async () => {
		const gh = runsGh([
			run({ id: 9, status: 'completed', conclusion: 'success', created_at: hoursAgo(25) }),
		])
		expect(await releaseStuckWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})

	it('fails open when gh cannot list runs', async () => {
		const gh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'offline', code: 1 })
		expect(await releaseStuckWarning(gh, 'acme/widget', 'main', NOW)).toBeNull()
	})
})

describe('releaseFailedWarning (#204)', () => {
	/** `runs`: the `workflow_runs` list. `jobs`: run id → [{name, conclusion}]. */
	function fakeGh(
		runs: ReturnType<typeof run>[],
		jobs: Record<number, { name: string; conclusion: string | null }[]> = {}
	): GhExec {
		return async (args): Promise<GhResult> => {
			const ok = (v: unknown) => ({ ok: true, stdout: JSON.stringify(v), stderr: '', code: 0 })
			const path = args[1] ?? ''
			if (path.includes('/actions/workflows/ci.yml/runs?')) return ok({ workflow_runs: runs })
			const jobsMatch = path.match(/\/actions\/runs\/(\d+)\/jobs/)
			if (jobsMatch) return ok({ jobs: jobs[Number(jobsMatch[1])] ?? [] })
			return { ok: false, stdout: '', stderr: 'unexpected', code: 1 }
		}
	}

	it('warns when the newest completed run has a failed release job', async () => {
		const gh = fakeGh([run({ id: 9, conclusion: 'failure' })], {
			9: [{ name: 'release', conclusion: 'failure' }],
		})
		const w = await releaseFailedWarning(gh, 'acme/widget', 'main')
		expect(w).toContain('release failed')
		expect(w).toContain('runs/9')
	})

	it('goes quiet once a newer run’s release job succeeds', async () => {
		const gh = fakeGh(
			[run({ id: 10, conclusion: 'success' }), run({ id: 9, conclusion: 'failure' })],
			{
				10: [{ name: 'release', conclusion: 'success' }],
				9: [{ name: 'release', conclusion: 'failure' }],
			}
		)
		expect(await releaseFailedWarning(gh, 'acme/widget', 'main')).toBeNull()
	})

	it('does not warn when no run has a release job at all', async () => {
		const gh = fakeGh([run({ id: 9, conclusion: 'success' })], {
			9: [{ name: 'ci', conclusion: 'success' }],
		})
		expect(await releaseFailedWarning(gh, 'acme/widget', 'main')).toBeNull()
	})

	it('fails open when gh cannot list runs', async () => {
		const gh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'offline', code: 1 })
		expect(await releaseFailedWarning(gh, 'acme/widget', 'main')).toBeNull()
	})

	it('fails open when the jobs list is unreadable', async () => {
		const gh: GhExec = async (args) => {
			const path = args[1] ?? ''
			if (path.includes('/actions/workflows/ci.yml/runs?'))
				return {
					ok: true,
					stdout: JSON.stringify({ workflow_runs: [run({ id: 9, conclusion: 'failure' })] }),
					stderr: '',
					code: 0,
				}
			return { ok: false, stdout: '', stderr: 'rate limited', code: 1 }
		}
		expect(await releaseFailedWarning(gh, 'acme/widget', 'main')).toBeNull()
	})
})

describe('release probes with a release.yml (#260)', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'repo-ai-'))
	mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
	writeFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'name: release\n')

	const gh =
		(runs: ReturnType<typeof run>[], paths: string[] = []): GhExec =>
		async (args): Promise<GhResult> => {
			const p = args[1] ?? ''
			paths.push(p)
			const ok = (v: unknown) => ({ ok: true, stdout: JSON.stringify(v), stderr: '', code: 0 })
			if (p.includes('/workflows/release.yml/runs?')) return ok({ workflow_runs: runs })
			if (p.includes('/jobs?')) return ok({ jobs: [{ name: 'release', conclusion: 'failure' }] })
			return { ok: false, stdout: '', stderr: 'unexpected', code: 1 }
		}

	it('warns on a release.yml run waiting 2h, any event', async () => {
		const paths: string[] = []
		const g = gh(
			[run({ id: 9, status: 'waiting', conclusion: null, created_at: hoursAgo(2) })],
			paths
		)
		const w = await releaseStuckWarning(g, 'acme/widget', 'main', NOW, 'ci.yml', root)
		expect(w).toContain('waiting on approval for 2h')
		expect(paths[0]).toBe(
			'repos/acme/widget/actions/workflows/release.yml/runs?branch=main&per_page=5'
		)
	})

	it('never says "cancel it" for a release.yml run behind a newer one', async () => {
		const g = gh([
			run({ id: 10, head_sha: 'bbbbbbb2222' }),
			run({ id: 9, status: 'waiting', conclusion: null, created_at: minutesAgo(10) }),
		])
		expect(await releaseStuckWarning(g, 'acme/widget', 'main', NOW, 'ci.yml', root)).toBeNull()
	})

	it('warns on a failed release job in release.yml', async () => {
		const w = await releaseFailedWarning(
			gh([run({ id: 7 })]),
			'acme/widget',
			'main',
			'ci.yml',
			root
		)
		expect(w).toContain('release failed')
	})
})
