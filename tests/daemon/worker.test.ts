import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareCheckout, summarize, workerCommand } from '../../src/cli/commands/worker.js'
import type { Task } from '../../src/daemon/queue.js'
import { useTmpDir } from '../helpers/tmp-dir.js'
import type { TaskRun } from '../../src/daemon/run-task.js'

const newTmpDir = useTmpDir()

const result = (over = {}) => ({
	ok: true,
	result: '',
	costUsd: 0.1,
	outputTokens: 50,
	durationMs: 1,
	...over,
})

describe('summarize', () => {
	it('reads the trailer each kind of task ends with', () => {
		expect(summarize('implement', result({ result: 'done\nPR: #42' }))).toBe('PR #42')
		expect(summarize('review', result({ result: 'VERDICT: CHANGES' }))).toBe('VERDICT CHANGES')
		expect(summarize('fix', result({ ok: false, error: 'timed out after 40m' }))).toBe(
			'timed out after 40m'
		)
		expect(summarize('fix', result({ result: 'no trailer here' }))).toBe('no trailer here')
	})
})

describe('workerCommand', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		process.env.REPO_AI_WORKER_SECRET = 's'
	})

	it('pulls a task, runs it with the minted env, and reports the result', async () => {
		const calls: { path: string; body: unknown; secret: string }[] = []
		const fake = (async (url: string, init: RequestInit) => {
			const path = url.replace('http://dash', '')
			calls.push({
				path,
				body: JSON.parse(String(init.body)),
				secret: (init.headers as Record<string, string>)['x-repo-ai-worker'] ?? '',
			})
			if (path.endsWith('/next'))
				return new Response(
					JSON.stringify({
						task: {
							id: 't1',
							repo: 'o/r',
							kind: 'implement',
							number: 5,
							label: 'implement',
							prompt: 'P',
							checkout: null,
						},
						env: { GH_TOKEN: 'ghs_x', REPO_AI_GH_LOGIN: 'loop[bot]' },
					}),
					{ status: 200 }
				)
			return new Response('{}', { status: 200 })
		}) as unknown as typeof fetch
		let ran: TaskRun | undefined
		const work = newTmpDir()
		let prepared = ''
		await workerCommand({
			url: 'http://dash',
			id: 'worker-1',
			work,
			fetch: fake,
			prepare: async (task, dir) => {
				prepared = dir
				return dir
			},
			sleep: async () => {},
			turns: 1,
			run: async (t) => {
				ran = t
				t.onProgress?.('Bash gh issue view 5')
				return result({ result: 'PR: #9' })
			},
		})
		expect(prepared).toBe(join(work, 't1'))
		expect(ran).toMatchObject({
			prompt: 'P',
			cwd: join(work, 't1'),
			env: { GH_TOKEN: 'ghs_x', REPO_AI_GH_LOGIN: 'loop[bot]', GH_REPO: 'o/r' },
		})
		// The clone is gone once the task is reported.
		expect(existsSync(join(work, 't1'))).toBe(false)
		expect(calls[0]?.body).toEqual({ claudeAuth: false, busy: false })
		expect(calls.map((c) => c.path)).toEqual([
			'/api/workers/worker-1/heartbeat',
			'/api/workers/worker-1/next',
			'/api/tasks/t1/progress',
			'/api/tasks/t1/done',
		])
		expect(calls.every((c) => c.secret === 's')).toBe(true)
		expect(calls.at(-1)?.body).toEqual({
			ok: true,
			summary: 'PR #9',
			costUsd: 0.1,
			outputTokens: 50,
		})
	})

	it('waits and carries on when there is no work or no dashboard', async () => {
		const sleeps: number[] = []
		let n = 0
		const fake = (async () => {
			n++
			if (n === 1) throw new Error('ECONNREFUSED')
			return new Response(null, { status: 204 })
		}) as unknown as typeof fetch
		await workerCommand({
			url: 'http://dash',
			id: 'w',
			fetch: fake,
			sleep: async (ms) => void sleeps.push(ms),
			turns: 2,
		})
		expect(sleeps).toEqual([10_000, 5_000])
	})
})

describe('prepareCheckout', () => {
	const task = (checkout: Task['checkout']): Task => ({
		id: 't',
		repo: 'o/r',
		kind: 'implement',
		number: 1,
		label: 'implement',
		prompt: '',
		checkout,
		state: 'running',
		createdAt: 0,
	})
	it('needs no clone for a review, and refuses an option-shaped branch before cloning', async () => {
		const dir = join(newTmpDir(), 'x')
		expect(await prepareCheckout(task(null), dir, {})).toBe(dir)
		await expect(
			prepareCheckout(task({ branch: '--upload-pack=evil', from: 'main' }), dir, {})
		).rejects.toThrow('unsafe branch name')
	})
})
