import type { AddressInfo } from 'node:net'
import { request, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeText } from '../../src/base/sanitize.js'
import { reviewOf, stageOf } from '../../src/base/stage.js'
import { dashboardCommand, loopbackHost } from '../../src/cli/commands/dashboard.js'
import { ciOf } from '../../src/daemon/board.js'
import { commentText } from '../../src/daemon/comments.js'
import {
	credentialEnv,
	mcpEnv,
	mcpFor,
	type DaemonConfig,
	limitsFor,
	pollSecondsFor,
	presentCredentials,
	validateConfig,
} from '../../src/daemon/config.js'
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
		checkout: null,
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

	it('frees a live worker that reports itself idle while still holding a task (#289 review)', () => {
		const q = new Queue()
		const t = q.enqueue(task('fix', 3))
		q.heartbeat('a', any)
		q.next('a')
		// Its `done` never arrived (or it restarted): it beats, idle, with the task still on it.
		q.heartbeat('a', any, true, true)
		expect(q.next('a')).toBeNull()
		q.heartbeat('a', any, true, false)
		expect(q.next('a')?.id).toBe(t?.id)
	})
})

describe('validateConfig', () => {
	it('accepts a good config and refuses bad repos, roles and poll rates', () => {
		const ok = validateConfig({
			pollSeconds: 120,
			repos: [{ repo: 'rtorcato/repo-ai' }],
			workers: { 'repo-ai-worker-1': { role: 'reviewer', repos: ['rtorcato/repo-ai'] } },
		})
		// A pre-#307 config's worker profiles become agents bound to those workers.
		expect(ok).toEqual({
			pollSeconds: 120,
			repos: [{ repo: 'rtorcato/repo-ai', enabled: true, dependabotAutoReview: false }],
			agents: [
				{
					id: 'repo-ai-worker-1',
					slot: 'repo-ai-worker-1',
					role: 'reviewer',
					repos: ['rtorcato/repo-ai'],
				},
			],
		})
		// A #309 worker's daily `budgetUsd` becomes its agent's `costBudgetUsd`.
		expect(
			validateConfig({ repos: [], workers: { w: { role: 'any', repos: [], budgetUsd: 5 } } })
		).toMatchObject({ agents: [{ id: 'w', slot: 'w', costBudgetUsd: 5 }] })
		expect(validateConfig({ repos: [], maxInFlight: 3, tokenBudget: 0 })).toMatchObject({
			maxInFlight: 3,
			tokenBudget: 0,
		})
		expect(validateConfig({ repos: [], maxInFlight: 0 })).toMatch(/maxInFlight/)
		expect(validateConfig({ repos: [{ repo: '../etc' }] })).toMatch(/not an owner\/repo/)
		expect(validateConfig({ repos: [], pollSeconds: 5 })).toMatch(/pollSeconds/)
		expect(validateConfig({ repos: [], workers: { w: { role: 'root' } } })).toMatch(/role/)
		// Removing a repo prunes it from every worker's list instead of refusing the save.
		expect(
			validateConfig({
				repos: [{ repo: 'o/r' }],
				workers: { w: { role: 'any', repos: ['x/y', 'o/r'] } },
			})
		).toMatchObject({ agents: [{ id: 'w', role: 'any', repos: ['o/r'] }] })
	})

	it('validates agents: one per slot, unique ids, sane overrides (#307)', () => {
		const cfg = (...agents: Record<string, unknown>[]) =>
			validateConfig({
				repos: [],
				agents: agents.map((a, i) => ({ id: `a${i}`, slot: `worker-${i}`, role: 'any', ...a })),
			})
		expect(cfg({ pollSeconds: 30, tokenBudget: 1000, costBudgetUsd: 2.5 })).toMatchObject({
			agents: [
				{ id: 'a0', slot: 'worker-0', pollSeconds: 30, tokenBudget: 1000, costBudgetUsd: 2.5 },
			],
		})
		expect(cfg({}, { slot: 'worker-0' })).toMatch(/already a0's/)
		expect(cfg({}, { id: 'a0' })).toMatch(/listed twice/)
		expect(cfg({ slot: '../x' })).toMatch(/slot/)
		expect(cfg({ id: 'a b' })).toMatch(/agent id/)
		expect(cfg({ pollSeconds: 0 })).toMatch(/pollSeconds/)
		expect(cfg({ tokenBudget: -1 })).toMatch(/tokenBudget/)
		expect(cfg({ costBudgetUsd: '5' })).toMatch(/costBudgetUsd/)
		expect(validateConfig({ repos: [], agents: [null] })).toMatch(/object/)
	})

	it('takes per-repo poll and limit overrides, else the global default (#305)', () => {
		const c = validateConfig({
			pollSeconds: 300,
			maxInFlight: 4,
			tokenBudget: 1000,
			repos: [
				{ repo: 'o/a', pollSeconds: 90, limits: { maxInFlight: 2, maxFixRounds: 0 } },
				{ repo: 'o/b', pollSeconds: null, limits: {} },
			],
		}) as DaemonConfig
		const [a, b] = c.repos
		expect(b).toEqual({ repo: 'o/b', enabled: true, dependabotAutoReview: false })
		expect(pollSecondsFor(c, a)).toBe(90)
		expect(pollSecondsFor(c, b)).toBe(300)
		expect(limitsFor(c, a)).toEqual({ maxInFlight: 2, maxFixRounds: 0, tokenBudget: 1000 })
		expect(limitsFor(c, b)).toEqual({ maxInFlight: 4, maxFixRounds: undefined, tokenBudget: 1000 })
		const one = (r: Record<string, unknown>) => validateConfig({ repos: [{ repo: 'o/r', ...r }] })
		expect(one({ pollSeconds: 30 })).toMatch(/o\/r: pollSeconds/)
		expect(one({ limits: { maxInFlight: 0 } })).toMatch(/o\/r: maxInFlight/)
		expect(one({ limits: { tokenBudget: 1.5 } })).toMatch(/tokenBudget/)
		expect(one({ limits: 'x' })).toMatch(/limits must be an object/)
	})

	it('validates a worker profile as untrusted input (#295)', () => {
		const cfg = (w: Record<string, unknown>) =>
			validateConfig({ repos: [], workers: { w: { role: 'any', ...w } } })
		expect(
			cfg({
				name: 'Ada',
				color: '#ff8800',
				avatar: '🦊',
				runner: 'claude',
				model: 'sonnet',
				credentials: ['ANTHROPIC_API_KEY_TEAM'],
				tools: ['Read', 'Bash(git *)', 'mcp__gh__issue'],
			})
		).toMatchObject({
			agents: [{ name: 'Ada', model: 'sonnet', credentials: ['ANTHROPIC_API_KEY_TEAM'] }],
		})
		// Blank fields drop out rather than being stored.
		expect(cfg({ name: '', model: '', tools: [] })).toEqual({
			pollSeconds: 180,
			repos: [],
			agents: [{ id: 'w', slot: 'w', role: 'any', repos: [] }],
		})
		// A profile can never name a secret that is not a model credential.
		expect(cfg({ credentials: ['REPO_AI_WORKER_SECRET'] })).toMatch(/model credential/)
		expect(cfg({ credentials: ['GITHUB_APP_PRIVATE_KEY_FILE'] })).toMatch(/model credential/)
		expect(cfg({ credentials: ['ANTHROPIC_API_KEY_A', 'ANTHROPIC_API_KEY_B'] })).toMatch(
			/at most one/
		)
		expect(cfg({ tools: ['--dangerously-skip-permissions'] })).toMatch(/tool rule/)
		expect(cfg({ tools: ['Bash(a, b)'] })).toMatch(/tool rule/)
		expect(cfg({ model: '--help' })).toMatch(/model/)
		expect(cfg({ runner: 'sh' })).toMatch(/runner/)
		expect(cfg({ color: 'red;' })).toMatch(/color/)
		expect(cfg({ avatar: 'https://x' })).toMatch(/avatar/)
	})
})

describe('models section (#306)', () => {
	const cfg = (models: unknown) => validateConfig({ repos: [], models })
	const gh = {
		name: 'github',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-github'],
		env: ['MCP_GITHUB_TOKEN'],
		enabled: true,
		agents: ['w1'],
	}

	it('validates each runner entry as untrusted input', () => {
		const ok = cfg({
			claude: {
				models: ['sonnet', 'opus'],
				defaultModel: 'sonnet',
				tools: ['Read'],
				notes: 'no network',
				accounts: [{ name: 'Team', credential: 'ANTHROPIC_API_KEY_TEAM' }],
				mcp: [gh, { name: 'docs', url: 'https://mcp.example.com/sse', enabled: false, agents: [] }],
			},
			codex: { accounts: [{ name: 'Work', credential: 'OPENAI_API_KEY_WORK' }] },
		})
		expect(ok).toMatchObject({ models: { claude: { defaultModel: 'sonnet', mcp: [gh, {}] } } })
		expect(cfg({ sh: {} })).toMatch(/not a runner/)
		expect(cfg({ codex: { tools: ['Read'] } })).toMatch(/cannot enforce/)
		expect(cfg({ gemini: { mcp: [gh] } })).toMatch(/cannot take MCP/)
		expect(cfg({ claude: { accounts: [{ name: 'x', credential: 'OPENAI_API_KEY' }] } })).toMatch(
			/not a claude credential/
		)
		const mcp = (s: Record<string, unknown>) => cfg({ claude: { mcp: [{ ...gh, ...s }] } })
		// The command is an executable, never a shell line or a flag.
		expect(mcp({ command: 'sh -c "curl x | sh"' })).toMatch(/not a command/)
		expect(mcp({ command: '--help' })).toMatch(/not a command/)
		expect(mcp({ url: 'https://x' })).toMatch(/command or a URL/)
		expect(mcp({ command: undefined, url: 'file:///etc/passwd' })).toMatch(/http/)
		// An MCP server can never be handed a worker, App or model secret.
		expect(mcp({ env: ['REPO_AI_WORKER_SECRET'] })).toMatch(/MCP_/)
		expect(mcp({ env: ['ANTHROPIC_API_KEY'] })).toMatch(/MCP_/)
		expect(mcp({ agents: ['../x'] })).toMatch(/agent id/)
		expect(cfg({ claude: { mcp: [gh, gh] } })).toMatch(/twice/)
	})

	it('hands a worker only the enabled servers it may use, with their credentials', () => {
		const c = cfg({
			claude: {
				mcp: [gh, { ...gh, name: 'off', enabled: false }, { ...gh, name: 'other', agents: ['w2'] }],
			},
		})
		if (typeof c === 'string') throw new Error(c)
		expect(mcpFor(c, 'claude', 'w1').map((s) => s.name)).toEqual(['github'])
		expect(mcpFor(c, 'codex', 'w1')).toEqual([])
		const servers = mcpFor(c, 'claude', 'w1')
		expect(mcpEnv(servers, { MCP_GITHUB_TOKEN: 't', OTHER: 'x' })).toEqual({
			MCP_GITHUB_TOKEN: 't',
		})
		expect(() => mcpEnv(servers, {})).toThrow(/not set/)
	})
})

describe('credentialEnv', () => {
	it('hands a task only the named credentials, under the name the runner reads', () => {
		const env = {
			ANTHROPIC_API_KEY_TEAM: 'k',
			CLAUDE_CODE_OAUTH_TOKEN: 'o',
			REPO_AI_WORKER_SECRET: 's',
		}
		expect(credentialEnv(['ANTHROPIC_API_KEY_TEAM'], env)).toEqual({ ANTHROPIC_API_KEY: 'k' })
		expect(credentialEnv(undefined, env)).toEqual({})
		expect(() => credentialEnv(['ANTHROPIC_API_KEY'], env)).toThrow(/not set/)
		expect(() => credentialEnv(['REPO_AI_WORKER_SECRET'], env)).toThrow(/not a model credential/)
		expect(presentCredentials(env)).toEqual(['ANTHROPIC_API_KEY_TEAM', 'CLAUDE_CODE_OAUTH_TOKEN'])
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

	it('serves state to loopback, or to a non-loopback caller with the secret', async () => {
		expect((await fetch(`${base}/`)).status).toBe(404)
		// fetch drops a custom Host (a forbidden header), so ask with node:http.
		const ask = (headers: Record<string, string>) =>
			new Promise<number>((resolve) =>
				request(`${base}/api/state`, { headers }, (res) => {
					res.resume()
					resolve(res.statusCode ?? 0)
				}).end()
			)
		expect(await ask({ host: 'api:8080' })).toBe(403)
		expect(await ask({ host: 'api:8080', 'x-repo-ai-worker': 'nope!!' })).toBe(403)
		expect(await ask({ host: 'api:8080', 'x-repo-ai-worker': 's3cret' })).toBe(200)
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
		expect(await (await beat('s3cret')).json()).toEqual({ role: 'any', repos: [], agent: null })
		const next = await fetch(`${base}/api/workers/w1/next`, {
			method: 'POST',
			headers: { 'x-repo-ai-worker': 's3cret' },
		})
		expect(next.status).toBe(204)
		// Bind an agent to the slot: the worker learns it, with its poll override (#307).
		await fetch(`${base}/api/config`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				repos: [],
				agents: [{ id: 'ada', slot: 'w1', role: 'reviewer', repos: [], pollSeconds: 20 }],
			}),
		})
		expect(await (await beat('s3cret')).json()).toEqual({
			role: 'reviewer',
			repos: [],
			agent: 'ada',
			pollSeconds: 20,
		})
	})
})
