import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import fs from 'fs-extra'
import { appCredentialsFromEnv, mintInstallationToken } from '../../base/app-auth.js'
import {
	type DaemonConfig,
	readDaemonConfig,
	validateConfig,
	writeDaemonConfig,
} from '../../daemon/config.js'
import { PAGE } from '../../daemon/page.js'
import { Queue, type Task } from '../../daemon/queue.js'
import { type LoopEvent, type RepoState, tickRepo } from '../../daemon/scheduler.js'

/**
 * `repo-ai dashboard` (#282): the setup screen, the only scheduler, the work
 * queue the worker containers pull from, and the view of all of it.
 *
 * Two audiences, two locks. The browser endpoints answer only a loopback
 * `Host` (no DNS rebinding) and take JSON only (a cross-site form cannot send
 * it without a preflight, which is never answered). The worker endpoints hand
 * out GitHub tokens, so they need `REPO_AI_WORKER_SECRET` — and are off
 * without one.
 */

export interface DashboardOptions {
	port: number
	host: string
	data: string
	repos: string
}

const SCAN_MS = 15_000

export async function dashboardCommand(o: DashboardOptions): Promise<Server> {
	const configFile = path.join(o.data, 'config.json')
	const eventsFile = path.join(o.data, 'events.jsonl')
	let config: DaemonConfig = await readDaemonConfig(configFile)
	const queue = new Queue()
	const states = new Map<string, RepoState>()
	const due = new Set<string>()
	const events: LoopEvent[] = []
	const creds = await appCredentialsFromEnv()
	const secret = process.env.REPO_AI_WORKER_SECRET?.trim() ?? ''

	const event = (e: Omit<LoopEvent, 't'>) => {
		const full = { t: Date.now(), ...e }
		events.push(full)
		if (events.length > 300) events.shift()
		void fs.appendFile(eventsFile, `${JSON.stringify(full)}\n`).catch(() => {})
	}
	const mint = async (repo: string) => {
		if (!creds) throw new Error('GITHUB_APP_ID and the App private key are not set')
		return mintInstallationToken(creds, repo)
	}

	// The scheduler: one repo at a time (scheduler.ts says why), each on its own cadence.
	let ticking = false
	const scan = async () => {
		if (ticking) return
		ticking = true
		try {
			for (const r of config.repos.filter((x) => x.enabled)) {
				const last = states.get(r.repo)?.lastTick ?? 0
				if (!due.has(r.repo) && Date.now() - last < config.pollSeconds * 1000) continue
				due.delete(r.repo)
				try {
					states.set(r.repo, await tickRepo(r, { reposDir: o.repos, queue, mint, event }))
				} catch (err) {
					states.set(r.repo, {
						...(states.get(r.repo) ?? { board: [], warnings: [], releaseGated: false }),
						repo: r.repo,
						summary: '⚠error',
						halt: (err as Error).message,
						errors: [],
						lastTick: Date.now(),
					})
				}
			}
		} finally {
			ticking = false
		}
	}
	const timer = setInterval(scan, SCAN_MS)
	void scan()

	const view = () => {
		const today = new Date().toDateString()
		const spent = [...queue.tasks.values()].filter(
			(t) => t.endedAt && new Date(t.endedAt).toDateString() === today
		)
		return {
			now: Date.now(),
			config,
			app: !!creds,
			workerSecret: !!secret,
			repos: config.repos.map((r) => ({
				...r,
				state: states.get(r.repo) ?? null,
				nextTick: (states.get(r.repo)?.lastTick ?? 0) + config.pollSeconds * 1000,
			})),
			workers: [...queue.workers.values()].map((w) => ({
				...w,
				online: Date.now() - w.lastSeen < 90_000,
			})),
			tasks: [...queue.tasks.values()]
				.sort((a, b) => b.createdAt - a.createdAt)
				.slice(0, 60)
				.map(({ prompt: _prompt, ...t }) => t),
			events: events.slice(-100).reverse(),
			today: {
				tasks: spent.length,
				outputTokens: spent.reduce((n, t) => n + (t.result?.outputTokens ?? 0), 0),
				costUsd: spent.reduce((n, t) => n + (t.result?.costUsd ?? 0), 0),
			},
		}
	}

	const server = createServer(async (req, res) => {
		try {
			await route(req, res)
		} catch (err) {
			send(res, 500, { error: (err as Error).message })
		}
	})

	const route = async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? '/', 'http://x')
		const parts = url.pathname.split('/').filter(Boolean)
		if (url.pathname === '/api/health') return send(res, 200, { ok: true })

		// Worker endpoints: /api/workers/:id/(heartbeat|next), /api/tasks/:id/(progress|done)
		if ((parts[1] === 'workers' || parts[1] === 'tasks') && req.method === 'POST') {
			if (!secret || !sameSecret(req.headers['x-repo-ai-worker'], secret))
				return send(res, 401, { error: 'worker secret missing or wrong' })
			const id = parts[2] ?? ''
			const body = (await readJson(req)) as Record<string, unknown>
			const assign = (w: string) => config.workers[w] ?? { role: 'any' as const, repos: [] }
			if (parts[1] === 'workers' && parts[3] === 'heartbeat') {
				const w = queue.heartbeat(id, assign, body.claudeAuth === true)
				return send(res, 200, { role: w.role, repos: w.repos })
			}
			if (parts[1] === 'workers' && parts[3] === 'next') {
				queue.heartbeat(id, assign)
				const t = queue.next(id)
				if (!t) return send(res, 204)
				try {
					const { token, login } = await mint(t.repo)
					event({ repo: t.repo, number: t.number, what: `${t.label} → ${id}` })
					return send(res, 200, { task: t, env: { GH_TOKEN: token, REPO_AI_GH_LOGIN: login } })
				} catch (err) {
					queue.done(t.id, {
						ok: false,
						summary: '',
						costUsd: 0,
						outputTokens: 0,
						error: (err as Error).message,
					})
					return send(res, 503, { error: (err as Error).message })
				}
			}
			if (parts[1] === 'tasks' && parts[3] === 'progress') {
				return send(res, queue.progress(id, String(body.line ?? '').slice(0, 300)) ? 200 : 404, {})
			}
			if (parts[1] === 'tasks' && parts[3] === 'done') {
				const t = queue.done(id, doneResult(body))
				if (!t) return send(res, 404, {})
				event({
					repo: t.repo,
					number: t.number,
					what: `${t.label} ${t.state}${t.result?.summary ? `: ${t.result.summary}` : ''}`,
				})
				// Hand off on completion: the next stage is claimable now, not at the next poll.
				due.add(t.repo)
				void scan()
				return send(res, 200, {})
			}
			return send(res, 404, {})
		}

		// Browser endpoints.
		if (!loopbackHost(req.headers.host)) return send(res, 403, { error: 'loopback only' })
		if (url.pathname === '/' && req.method === 'GET') {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'content-security-policy':
					"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
				'x-frame-options': 'DENY',
			})
			return res.end(PAGE)
		}
		if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, view())
		if (url.pathname === '/api/config' && req.method === 'POST') {
			if (!String(req.headers['content-type']).startsWith('application/json'))
				return send(res, 415, { error: 'JSON only' })
			const next = validateConfig(await readJson(req))
			if (typeof next === 'string') return send(res, 400, { error: next })
			config = next
			await writeDaemonConfig(configFile, config)
			for (const r of config.repos) due.add(r.repo)
			void scan()
			return send(res, 200, view())
		}
		return send(res, 404, { error: 'not found' })
	}

	server.on('close', () => clearInterval(timer))
	await new Promise<void>((resolve) => server.listen(o.port, o.host, resolve))
	console.error(`repo-ai dashboard on http://${o.host}:${o.port}`)
	if (!creds)
		console.error('⚠ no GitHub App credentials: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE')
	if (!secret) console.error('⚠ REPO_AI_WORKER_SECRET is unset: workers cannot connect')
	return server
}

function doneResult(b: Record<string, unknown>): NonNullable<Task['result']> {
	return {
		ok: b.ok === true,
		summary: String(b.summary ?? '').slice(0, 300),
		costUsd: Number(b.costUsd) || 0,
		outputTokens: Number(b.outputTokens) || 0,
		...(b.error ? { error: String(b.error).slice(0, 300) } : {}),
	}
}

export function loopbackHost(host: string | undefined): boolean {
	return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? '')
}

function sameSecret(given: string | string[] | undefined, secret: string): boolean {
	const a = Buffer.from(typeof given === 'string' ? given : '')
	const b = Buffer.from(secret)
	return a.length === b.length && timingSafeEqual(a, b)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	let raw = ''
	for await (const chunk of req) {
		raw += chunk
		if (raw.length > 100_000) throw new Error('body too large')
	}
	return raw ? JSON.parse(raw) : {}
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status)
		res.end()
		return
	}
	res.writeHead(status, { 'content-type': 'application/json' })
	res.end(JSON.stringify(body))
}
