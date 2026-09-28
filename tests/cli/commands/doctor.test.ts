import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
	checkAutoMerge,
	checkCiRuns,
	checkHumanUser,
	checkReleaseStuck,
	runDoctor,
} from '../../../src/cli/commands/doctor.js'
import { useTmpDir } from '../../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

describe('runDoctor — loop config location', () => {
	it('reports .repo-ai.json missing, even with a .repo-tooling.json (#159)', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-tooling.json'), {
			rules: { aiLoop: { agentUser: 'legacy-bot' } },
		})
		const results = await runDoctor(dir)
		expect(results).toContainEqual(
			expect.objectContaining({ check: 'Loop config', status: 'missing' })
		)
	})

	it('says nothing about loop config with .repo-ai.json in place', async () => {
		const dir = newTmpDir()
		fs.outputJsonSync(join(dir, '.repo-ai.json'), { agentUser: 'new-bot' })
		const results = await runDoctor(dir)
		expect(results.find((r) => r.check === 'Loop config')).toBeUndefined()
	})

	it('reports loop config missing with neither file', async () => {
		const results = await runDoctor(newTmpDir())
		expect(results.find((r) => r.check === 'Loop config')?.status).toBe('missing')
	})
})

describe('checkHumanUser (#162)', () => {
	it('is ok when humanUser is set', async () => {
		const r = await checkHumanUser(newTmpDir(), 'acme-owner')
		expect(r).toMatchObject({ status: 'ok', detail: expect.stringContaining('acme-owner') })
	})

	it('skips outside a git repo', async () => {
		const r = await checkHumanUser(newTmpDir(), undefined)
		expect(r.status).toBe('ok')
	})

	it('is not applicable when the repo owner is a user', async () => {
		const dir = newTmpDir()
		fs.ensureDirSync(join(dir, '.git'))
		const r = await checkHumanUser(dir, undefined, async () => ({
			ok: true,
			stdout: 'User\n',
			stderr: '',
		}))
		expect(r).toMatchObject({ status: 'ok', detail: expect.stringMatching(/not applicable/) })
	})

	it('drifts on an organisation-owned repo with no humanUser', async () => {
		const dir = newTmpDir()
		fs.ensureDirSync(join(dir, '.git'))
		const r = await checkHumanUser(dir, undefined, async () => ({
			ok: true,
			stdout: 'Organization\n',
			stderr: '',
		}))
		expect(r.status).toBe('drift')
	})

	it('self-skips when the owner cannot be verified', async () => {
		const dir = newTmpDir()
		fs.ensureDirSync(join(dir, '.git'))
		const r = await checkHumanUser(dir, undefined, async () => ({
			ok: false,
			stdout: '',
			stderr: 'connection refused',
		}))
		expect(r.status).toBe('ok')
	})
})

describe('checkAutoMerge (#142)', () => {
	it('reports off without the opt-in', async () => {
		const r = await checkAutoMerge(newTmpDir(), false)
		expect(r).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^off/) })
	})

	it('warns when on but not release-gated', async () => {
		const r = await checkAutoMerge(newTmpDir(), true)
		expect(r.status).toBe('drift')
	})

	it('is ok when on and release-gated', async () => {
		const dir = newTmpDir()
		fs.ensureDirSync(join(dir, '.git'))
		fs.outputFileSync(
			join(dir, '.github/workflows/release.yml'),
			'jobs:\n  release:\n    environment: release\n    steps:\n      - run: npx semantic-release\n'
		)
		const r = await checkAutoMerge(dir, true, async (args) => {
			if (args[0] === 'repo') return { ok: true, stdout: 'acme/widget\n', stderr: '' }
			// A literal '{owner}/{repo}' here would mean the name was never resolved.
			if (args[1] !== 'repos/acme/widget/environments')
				return { ok: false, stdout: '', stderr: '404' }
			return {
				ok: true,
				stdout: JSON.stringify({
					environments: [{ name: 'release', protection_rules: [{ type: 'required_reviewers' }] }],
				}),
				stderr: '',
			}
		})
		expect(r).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^on/) })
	})
})

describe('checkCiRuns (#153)', () => {
	it('skips outside a git repository', async () => {
		const r = await checkCiRuns(newTmpDir())
		expect(r).toMatchObject({ status: 'ok', detail: expect.stringMatching(/not a git repository/) })
	})

	it('flags a main push run cancelled with no jobs', async () => {
		const dir = newTmpDir()
		fs.ensureDirSync(join(dir, '.git'))
		const r = await checkCiRuns(dir, async (args) => {
			if (args[0] === 'repo') return { ok: true, stdout: 'acme/widget\n', stderr: '', code: 0 }
			if (args[1]?.includes('/actions/runs?'))
				return {
					ok: true,
					stdout: JSON.stringify({
						workflow_runs: [
							{
								id: 9,
								status: 'completed',
								conclusion: 'cancelled',
								html_url: 'https://github.com/acme/widget/actions/runs/9',
								created_at: new Date().toISOString(),
								path: '.github/workflows/ci.yml',
							},
						],
					}),
					stderr: '',
					code: 0,
				}
			if (args[1]?.includes('/jobs'))
				return { ok: true, stdout: JSON.stringify({ total_count: 0 }), stderr: '', code: 0 }
			return { ok: false, stdout: '', stderr: 'unexpected', code: 1 }
		})
		expect(r.status).toBe('drift')
		expect(r.detail).toContain('runs/9')
	})

	it('is ok when the repo cannot be resolved', async () => {
		const dir = newTmpDir()
		fs.ensureDirSync(join(dir, '.git'))
		const r = await checkCiRuns(dir, async () => ({ ok: false, stdout: '', stderr: '', code: 1 }))
		expect(r.status).toBe('ok')
	})
})

describe('checkReleaseStuck (#146)', () => {
	it('skips outside a git repository', async () => {
		const r = await checkReleaseStuck(newTmpDir())
		expect(r).toMatchObject({ status: 'ok', detail: expect.stringMatching(/not a git repository/) })
	})

	it('flags a release run waiting on approval past 24h', async () => {
		const dir = newTmpDir()
		fs.ensureDirSync(join(dir, '.git'))
		const r = await checkReleaseStuck(dir, async (args) => {
			if (args[0] === 'repo') return { ok: true, stdout: 'acme/widget\n', stderr: '', code: 0 }
			if (args[1]?.includes('/actions/runs?'))
				return {
					ok: true,
					stdout: JSON.stringify({
						workflow_runs: [
							{
								id: 9,
								status: 'waiting',
								conclusion: null,
								html_url: 'https://github.com/acme/widget/actions/runs/9',
								created_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
								path: '.github/workflows/ci.yml',
							},
						],
					}),
					stderr: '',
					code: 0,
				}
			return { ok: false, stdout: '', stderr: 'unexpected', code: 1 }
		})
		expect(r.status).toBe('drift')
		expect(r.detail).toContain('runs/9')
	})

	it('is ok when the repo cannot be resolved', async () => {
		const dir = newTmpDir()
		fs.ensureDirSync(join(dir, '.git'))
		const r = await checkReleaseStuck(dir, async () => ({
			ok: false,
			stdout: '',
			stderr: '',
			code: 1,
		}))
		expect(r.status).toBe('ok')
	})
})
