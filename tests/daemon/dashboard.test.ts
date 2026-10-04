import type { AddressInfo } from 'node:net'
import { request, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeText } from '../../src/base/sanitize.js'
import { reviewOf, stageOf } from '../../src/base/stage.js'
import { dashboardCommand, loopbackHost } from '../../src/cli/commands/dashboard.js'
import { ciOf } from '../../src/daemon/board.js'
import { commentText } from '../../src/daemon/comments.js'
import { validateConfig } from '../../src/daemon/config.js'
import { Queue } from '../../src/daemon/queue.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

describe('stageOf / reviewOf', () => {
	it('reads the stage from labels, blocked first', () => {
		expect(stageOf(['ai-ready'], false)).toBe('ready')
		expect(stageOf(['ai-ready', 'ai-wip'], false)).toBe('wip')
		expect(stageOf(['ai-wip', 'ai-blocked'], false)).toBe('blocked')
		expect(stageOf(['bug'], false)).toBeNull()
		expect(stageOf(['ai-review', 'ai-ok-code'], true)).toBe('review')
		expect(stageOf(['ai-changes', 'ai-fixing'], true)).toBe('fixing')
		expect(stageOf(['ai-conflicts'], true)).toBe('conflicts')
		expect(stageOf(['merge-ready', 'ai-notes'], true)).toBe('merge-ready')
		expect(stageOf(['dependencies'], true)).toBeNull()
	})
	it('reads each review arm', () => {
		expect(reviewOf(['ai-ok-code', 'ai-reviewing-sec'], 'code')).toBe('pass')
		expect(reviewOf(['ai-ok-code', 'ai-reviewing-sec'], 'sec')).toBe('running')
		expect(reviewOf(['ai-changes', 'ai-ok-sec'], 'code')).toBe('changes')
		expect(reviewOf(['merge-ready'], 'sec')).toBe('pass')
		expect(reviewOf(['ai-review'], 'sec')).toBe('pending')
	})
})

describe('safeText', () => {
	it('strips escapes, links and bidi overrides, and bounds the length', () => {
		// The ESCs go, so the OSC 8 link is inert text; the printable rest stays.
		const out = safeText('fix \u001b]8;;https://evil\u001b\\click\u001b]8;;\u001b\\ now')
		expect(out).not.toContain('\u001b')
		expect(out).toBe('fix ]8;;https://evil \\click ]8;; \\ now')
		expect(safeText('a‮gnp.exe')).toBe('a gnp.exe')
		expect(safeText('x'.repeat(10), 5)).toBe('xxxx…')
		expect(safeText(null)).toBe('')
	})
})

describe('ciOf', () => {
	it('is red on any failure, pending while anything runs, green when all pass', () => {
		expect(ciOf([])).toBe('none')
		expect(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'FAILURE' }])).toBe('red')
		expect(ciOf([{ status: 'IN_PROGRESS', conclusion: null }])).toBe('pending')
		expect(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe(
			'green'
		)
	})
})

describe('Queue', () => {
	const task = (kind: 'implement' | 'review' | 'fix', number: number, repo = 'o/r') => ({
		repo,
		kind,
		number,
		label: kind,
		prompt: 'p',
		cwd: '/w',
	})
	const any = () => ({ role: 'any' as const, repos: [] })

	it('dedupes live work and hands each task to one worker whose role fits', () => {
		let t = 0
		const q = new Queue(90_000, () => ++t)
		expect(q.enqueue(task('review', 9))).not.toBeNull()
		expect(q.enqueue(task('review', 9))).toBeNull()
		q.enqueue(task('implement', 5))
		q.heartbeat('rev', () => ({ role: 'reviewer', repos: [] }))
		q.heartbeat('w2', any)
		expect(q.next('rev')?.kind).toBe('review')
		expect(q.next('rev')).toBeNull() // busy
		expect(q.next('w2')?.kind).toBe('implement')
		expect(q.next('w3')).toBeNull() // never beat
	})

	it('respects a worker repo list', () => {
		const q = new Queue()
		q.enqueue(task('fix', 1, 'o/other'))
		q.heartbeat('w', () => ({ role: 'any', repos: ['o/r'] }))
		expect(q.next('w')).toBeNull()
	})

	it('re-queues a running task whose worker went silent', () => {
		let now = 0
		const q = new Queue(1000, () => now)
		const t = q.enqueue(task('fix', 3))
		q.heartbeat('a', any)
		q.next('a')
		now = 5000
		q.heartbeat('b', any)
		expect(q.next('b')?.id).toBe(t?.id)
		expect(q.done(t?.id ?? '', { ok: true, summary: '', costUsd: 0, outputTokens: 0 })?.state).toBe(
			'done'
		)
	})
})

describe('validateConfig', () => {
	it('accepts a good config and refuses bad repos, roles and poll rates', () => {
		const ok = validateConfig({
			pollSeconds: 120,
			repos: [{ repo: 'rtorcato/repo-ai' }],
			workers: { 'repo-ai-worker-1': { role: 'reviewer', repos: ['rtorcato/repo-ai'] } },
		})
		expect(ok).toEqual({
			pollSeconds: 120,
			repos: [{ repo: 'rtorcato/repo-ai', enabled: true, dependabotAutoReview: false }],
			workers: { 'repo-ai-worker-1': { role: 'reviewer', repos: ['rtorcato/repo-ai'] } },
		})
		expect(validateConfig({ repos: [{ repo: '../etc' }] })).toMatch(/not an owner\/repo/)
		expect(validateConfig({ repos: [], pollSeconds: 5 })).toMatch(/pollSeconds/)
		expect(validateConfig({ repos: [], workers: { w: { role: 'root' } } })).toMatch(/role/)
		expect(validateConfig({ repos: [], workers: { w: { role: 'any', repos: ['x/y'] } } })).toMatch(
			/not a configured repo/
		)
	})
})

describe('commentText', () => {
	it('names failing and missing checks without quoting any log', () => {
		const text = commentText(
			{
				kind: 'send-back',
				pr: 4,
				sendBack: {
					pr: 4,
					issue: 1,
					reason: 'ci-red',
					label: 'ai-changes',
					failing: [{ name: 'verify', link: 'https://github.com/o/r/runs/1' }],
					missing: ['test'],
				},
			},
			'main'
		)
		expect(text).toMatch(/^🤖 \*Automated/)
		expect(text).toContain('`verify` failed')
		expect(text).toContain('required check `test` never reported')
	})
})

describe('dashboard HTTP', () => {
	let server: Server
	let base: string
	const env = { ...process.env }
	beforeEach(async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		process.env.REPO_AI_WORKER_SECRET = 's3cret'
		delete process.env.GITHUB_APP_ID
		server = await dashboardCommand({
			port: 0,
			host: '127.0.0.1',
			data: newTmpDir(),
			repos: newTmpDir(),
		})
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterEach(() => {
		server.close()
		process.env = { ...env }
	})

	it('serves the page and state to loopback only', async () => {
		expect((await fetch(`${base}/`)).status).toBe(200)
		// fetch drops a custom Host (a forbidden header), so ask with node:http.
		const status = await new Promise<number>((resolve) =>
			request(`${base}/api/state`, { headers: { host: 'evil.example' } }, (res) => {
				res.resume()
				resolve(res.statusCode ?? 0)
			}).end()
		)
		expect(status).toBe(403)
		expect(loopbackHost('localhost:8080')).toBe(true)
		expect(loopbackHost('dashboard:8080')).toBe(false)
	})

	it('takes config as JSON only, and validates it', async () => {
		const post = (body: string, type: string) =>
			fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': type }, body })
		expect((await post('repos=x', 'application/x-www-form-urlencoded')).status).toBe(415)
		expect((await post('{"repos":[{"repo":"../x"}]}', 'application/json')).status).toBe(400)
		const ok = await post(
			'{"pollSeconds":60,"repos":[{"repo":"o/r","enabled":false}]}',
			'application/json'
		)
		expect(ok.status).toBe(200)
		expect((await ok.json()).config.repos[0].repo).toBe('o/r')
	})

	it('lets a worker in only with the secret', async () => {
		const beat = (secret?: string) =>
			fetch(`${base}/api/workers/w1/heartbeat`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(secret ? { 'x-repo-ai-worker': secret } : {}),
				},
				body: '{"claudeAuth":true}',
			})
		expect((await beat()).status).toBe(401)
		expect((await beat('wrong!')).status).toBe(401)
		expect(await (await beat('s3cret')).json()).toEqual({ role: 'any', repos: [] })
		const next = await fetch(`${base}/api/workers/w1/next`, {
			method: 'POST',
			headers: { 'x-repo-ai-worker': 's3cret' },
		})
		expect(next.status).toBe(204)
	})
})
