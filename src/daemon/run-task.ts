import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * One agent task in a Docker worker (#281): headless Claude Code in the
 * task's worktree. `stream-json` gives a line per event, so the dashboard can
 * show what the agent is doing while it runs and what it cost when it ends.
 *
 * `bypassPermissions` is safe only because the worker container is the
 * sandbox: no host mounts, non-root, a repo-scoped one-hour App token.
 */

export interface TaskRun {
	prompt: string
	cwd: string
	/** Merged over the worker's environment: `GH_TOKEN`, `REPO_AI_GH_LOGIN`. */
	env?: Record<string, string>
	timeoutMs: number
	/** From the worker's profile (#295): `--model`. */
	model?: string
	/** From the worker's profile (#295): the only tools the agent may use. Unset: all. */
	tools?: string[]
	/** One short line per agent step, for the dashboard. */
	onProgress?: (line: string) => void
	/** Test seam: the executable and its leading args. */
	command?: [string, ...string[]]
}

export interface TaskResult {
	ok: boolean
	/** The agent's final reply. */
	result: string
	costUsd: number
	outputTokens: number
	durationMs: number
	error?: string
}

/** What the dashboard shows for one stream-json event, or null to skip it. */
export function describeEvent(ev: unknown): string | null {
	const e = ev as {
		type?: string
		message?: {
			content?: { type: string; name?: string; text?: string; input?: Record<string, unknown> }[]
		}
	}
	if (e.type !== 'assistant') return null
	for (const c of e.message?.content ?? []) {
		if (c.type === 'tool_use') {
			const arg = c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? ''
			return `${c.name}${arg ? ` ${String(arg).split('\n', 1)[0]?.slice(0, 120)}` : ''}`
		}
	}
	return null
}

const MODEL_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']

/**
 * The worker's environment minus what the agent must never read: the
 * worker secret (it gets tokens from the dashboard) and any App credential.
 * The worker's model credential stays — the agent cannot run without it —
 * unless the task brings its own (#295), and then none of the worker's do.
 */
export function agentEnv(env: NodeJS.ProcessEnv, task?: Record<string, string>): NodeJS.ProcessEnv {
	const own = MODEL_KEYS.some((k) => task?.[k])
	return Object.fromEntries(
		Object.entries(env).filter(
			([k]) =>
				k !== 'REPO_AI_WORKER_SECRET' &&
				!k.startsWith('GITHUB_APP_') &&
				!(own && MODEL_KEYS.includes(k))
		)
	)
}

/**
 * Spawn options that drop a child to the agent uid (#293), set only when the
 * worker runs as root. The agent then cannot read the worker's
 * `/proc/<pid>/environ`, which holds the worker secret.
 */
export function agentIdentity(
	env: NodeJS.ProcessEnv = process.env
): { uid: number; gid: number; home: string } | null {
	const uid = Number(env.REPO_AI_AGENT_UID)
	if (!Number.isInteger(uid) || uid <= 0 || process.getuid?.() !== 0) return null
	return { uid, gid: uid, home: '/home/agent' }
}

export function runTask(t: TaskRun): Promise<TaskResult> {
	const [bin, ...lead] = t.command ?? ['claude']
	const args = [
		...lead,
		'-p',
		t.prompt,
		'--output-format',
		'stream-json',
		'--verbose',
		...(t.model ? ['--model', t.model] : []),
		// An allowlist needs `dontAsk`: under `bypassPermissions` every tool is already allowed.
		...(t.tools?.length
			? ['--permission-mode', 'dontAsk', '--allowedTools', t.tools.join(',')]
			: ['--permission-mode', 'bypassPermissions']),
	]
	const started = Date.now()
	return new Promise((resolve) => {
		const id = agentIdentity()
		const child = spawn(bin, args, {
			cwd: t.cwd,
			env: { ...agentEnv(process.env, t.env), ...(id && { HOME: id.home }), ...t.env },
			...(id && { uid: id.uid, gid: id.gid }),
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let final: Partial<TaskResult> | null = null
		let stderr = ''
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGTERM')
			// One that ignores SIGTERM still has to end, or the worker waits on it forever.
			setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
		}, t.timeoutMs)
		child.stderr.on('data', (d) => {
			stderr = (stderr + d).slice(-2000)
		})
		createInterface({ input: child.stdout }).on('line', (line) => {
			let ev: Record<string, unknown>
			try {
				ev = JSON.parse(line)
			} catch {
				return
			}
			if (ev.type === 'result') {
				final = {
					ok: ev.is_error !== true,
					result: String(ev.result ?? ''),
					costUsd: Number(ev.total_cost_usd ?? 0),
					outputTokens: Number((ev.usage as { output_tokens?: number })?.output_tokens ?? 0),
				}
				return
			}
			const step = describeEvent(ev)
			if (step) t.onProgress?.(step)
		})
		const finish = (error?: string) => {
			clearTimeout(timer)
			const f: Partial<TaskResult> = final ?? {}
			resolve({
				ok: !error && f.ok === true,
				result: f.result ?? '',
				costUsd: f.costUsd ?? 0,
				outputTokens: f.outputTokens ?? 0,
				durationMs: Date.now() - started,
				...(error ? { error } : {}),
			})
		}
		child.on('error', (err) => finish(`could not start ${bin}: ${err.message}`))
		child.on('close', (code) => {
			if (timedOut) return finish(`timed out after ${Math.round(t.timeoutMs / 60000)}m`)
			if (code !== 0 && !final)
				return finish(`exited ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`)
			finish()
		})
	})
}

/** The `PR: #12` / `VERDICT: PASS` / `PUSHED: yes` line a prompt asks the agent to end with. */
export function trailer(result: string, key: string): string | null {
	const m = result.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'))
	return m?.[1] ?? null
}
