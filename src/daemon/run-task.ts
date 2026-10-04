import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { McpServer } from './config.js'

/**
 * One agent task in a Docker worker (#281): a headless agent CLI in the
 * task's worktree. Each runner (#294) streams one JSON line per event, so the
 * dashboard can show what the agent is doing while it runs and what it cost
 * when it ends.
 *
 * Every runner skips its approval prompts. That is safe only because the
 * worker container is the sandbox: no host mounts, non-root, a repo-scoped
 * one-hour App token.
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
	/** From the Models section (#306): the MCP servers this worker may use. */
	mcp?: McpServer[]
	/** One short line per agent step, for the dashboard. */
	onProgress?: (line: string) => void
	/** Which agent CLI runs the task. Default: Claude Code. */
	runner?: Runner
	/** Test seam: the executable and its leading args, in place of the runner's. */
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

/** One dashboard line for a tool call: its name and the first line of its main argument. */
function step(name: unknown, input?: Record<string, unknown>): string {
	const arg =
		input?.command ??
		input?.file_path ??
		input?.absolute_path ??
		input?.path ??
		input?.pattern ??
		''
	return `${name}${arg ? ` ${String(arg).split('\n', 1)[0]?.slice(0, 120)}` : ''}`
}

/** What the dashboard shows for one Claude stream-json event, or null to skip it. */
export function describeEvent(ev: unknown): string | null {
	const e = ev as {
		type?: string
		message?: {
			content?: { type: string; name?: string; text?: string; input?: Record<string, unknown> }[]
		}
	}
	if (e.type !== 'assistant') return null
	for (const c of e.message?.content ?? []) {
		if (c.type === 'tool_use') return step(c.name, c.input)
	}
	return null
}

/** The run's outcome so far, which a runner fills in as its events arrive. */
export interface RunOptions {
	model?: string
	tools?: string[]
	mcp?: McpServer[]
}

type Outcome = Partial<Pick<TaskResult, 'ok' | 'result' | 'costUsd' | 'outputTokens' | 'error'>>

/**
 * An agent CLI (#294): how to invoke it headless, which env vars carry its
 * credential, and how its JSON-lines output maps to progress and usage.
 * Prompts stay runner-neutral: markdown ending in a `PR:` / `VERDICT:` /
 * `PUSHED:` trailer, which `result` must carry.
 */
export interface Runner {
	bin: string
	/** `model` and `tools` come from the worker's profile (#295). */
	args: (prompt: string, o: RunOptions) => string[]
	/** It can confine the agent to `tools`; a runner that cannot refuses a task that sets them. */
	allowlist: boolean
	/** It takes MCP servers on its command line (#306); a runner that cannot refuses a task that sets them. */
	mcp: boolean
	/** Any one of these set means the worker can run tasks. */
	auth: string[]
	/** Fold one event into `out`; return a progress line, or null. */
	event: (ev: Record<string, unknown>, out: Outcome) => string | null
}

// biome-ignore lint/suspicious/noExplicitAny: event payloads are untyped JSON
type Json = any

/**
 * Claude's `--mcp-config` JSON. Credential values never go on the command
 * line: the server inherits them, by name, from the task's env.
 */
export function claudeMcp(servers: McpServer[]): string {
	return JSON.stringify({
		mcpServers: Object.fromEntries(
			servers.map((s) => [
				s.name,
				s.url ? { type: 'http', url: s.url } : { command: s.command, args: s.args ?? [] },
			])
		),
	})
}

/** Codex `-c` overrides for one server; JSON strings and arrays are valid TOML values. */
export function codexMcp(s: McpServer): string[] {
	const key = `mcp_servers.${s.name}`
	const set = (k: string, v: unknown) => ['-c', `${key}.${k}=${JSON.stringify(v)}`]
	return s.url
		? set('url', s.url)
		: [
				...set('command', s.command),
				...set('args', s.args ?? []),
				...(s.env?.length ? set('env_vars', s.env) : []),
			]
}

export const runners = {
	/** `claude -p`: one `result` event at the end carries everything. */
	claude: {
		bin: 'claude',
		args: (prompt, o) => [
			'-p',
			prompt,
			'--output-format',
			'stream-json',
			'--verbose',
			...(o.model ? ['--model', o.model] : []),
			// Only the configured servers: --strict ignores any .mcp.json the repo ships.
			...(o.mcp?.length ? ['--mcp-config', claudeMcp(o.mcp), '--strict-mcp-config'] : []),
			// An allowlist needs `dontAsk`: under `bypassPermissions` every tool is already allowed.
			...(o.tools?.length
				? ['--permission-mode', 'dontAsk', '--allowedTools', o.tools.join(',')]
				: ['--permission-mode', 'bypassPermissions']),
		],
		allowlist: true,
		mcp: true,
		auth: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
		event: (ev: Json, out) => {
			if (ev.type !== 'result') return describeEvent(ev)
			out.ok = ev.is_error !== true
			out.result = String(ev.result ?? '')
			out.costUsd = Number(ev.total_cost_usd ?? 0)
			out.outputTokens = Number(ev.usage?.output_tokens ?? 0)
			return null
		},
	},
	/** `codex exec --json`: items as they start and finish; usage on `turn.completed`, no cost. */
	codex: {
		bin: 'codex',
		args: (prompt, o) => [
			'exec',
			'--json',
			...(o.model ? ['--model', o.model] : []),
			...(o.mcp ?? []).flatMap(codexMcp),
			'--dangerously-bypass-approvals-and-sandbox',
			'--skip-git-repo-check',
			'--',
			prompt,
		],
		allowlist: false,
		mcp: true,
		auth: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
		event: (ev: Json, out) => {
			const item = ev.item ?? {}
			if (ev.type === 'item.started' && item.type === 'command_execution') return step('Bash', item)
			if (ev.type === 'item.completed') {
				if (item.type === 'agent_message') out.result = String(item.text ?? '')
				if (item.type === 'file_change') return step('Edit', item.changes?.[0])
				if (item.type === 'mcp_tool_call') return `${item.server}.${item.tool}`
				if (item.type === 'web_search') return step('WebSearch', { command: item.query })
			}
			if (ev.type === 'turn.completed') {
				out.ok ??= true
				out.outputTokens = (out.outputTokens ?? 0) + Number(ev.usage?.output_tokens ?? 0)
			}
			if (ev.type === 'turn.failed' || ev.type === 'error') {
				out.ok = false
				out.error = String(ev.error?.message ?? ev.message ?? 'codex failed')
			}
			return null
		},
	},
	/** `gemini --output-format stream-json`: streamed message deltas; token stats on `result`, no cost. */
	gemini: {
		bin: 'gemini',
		args: (prompt, o) => [
			'-p',
			prompt,
			'--output-format',
			'stream-json',
			'--yolo',
			...(o.model ? ['--model', o.model] : []),
		],
		allowlist: false,
		// ponytail: gemini reads MCP servers only from settings.json; write one per task if it is needed.
		mcp: false,
		auth: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
		event: (ev: Json, out) => {
			if (ev.type === 'message' && ev.role === 'assistant')
				out.result = (ev.delta ? (out.result ?? '') : '') + String(ev.content ?? '')
			if (ev.type === 'tool_use') {
				// The trailer is in the reply after the last tool call, as with Claude's `result`.
				out.result = ''
				return step(ev.tool_name, ev.parameters)
			}
			if (ev.type === 'result') {
				out.ok = ev.status === 'success'
				out.outputTokens = Number(ev.stats?.output_tokens ?? 0)
				if (ev.status !== 'success') out.error = String(ev.error?.message ?? 'gemini failed')
			}
			return null
		},
	},
} satisfies Record<string, Runner>

export type RunnerName = keyof typeof runners

/** Every runner's credential names: a task that brings one replaces all of the worker's (#295). */
const MODEL_KEYS: string[] = Object.values(runners).flatMap((r) => r.auth)

/**
 * The worker's environment minus what the agent must never read: the
 * worker secret (it gets tokens from the dashboard), any App credential, and
 * every model credential except `keep` — the running runner's own (#308), so
 * a codex agent never sees the Claude token. Those go too when the task
 * brings its profile's credential (#295).
 */
export function agentEnv(
	env: NodeJS.ProcessEnv,
	task?: Record<string, string>,
	keep: string[] = []
): NodeJS.ProcessEnv {
	const own = MODEL_KEYS.some((k) => task?.[k])
	return Object.fromEntries(
		Object.entries(env).filter(
			([k]) =>
				k !== 'REPO_AI_WORKER_SECRET' &&
				!k.startsWith('GITHUB_APP_') &&
				!(MODEL_KEYS.includes(k) && (own || !keep.includes(k)))
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
	const runner: Runner = t.runner ?? runners.claude
	const [bin, ...lead] = t.command ?? [runner.bin]
	const args = [...lead, ...runner.args(t.prompt, { model: t.model, tools: t.tools, mcp: t.mcp })]
	// Fail closed: a profile's tool allowlist that the runner cannot enforce must not run unconfined.
	if (t.tools?.length && !runner.allowlist)
		return Promise.resolve({
			ok: false,
			result: '',
			costUsd: 0,
			outputTokens: 0,
			durationMs: 0,
			error: `${runner.bin} cannot enforce a tool allowlist; clear the profile's tools or use claude`,
		})
	if (t.mcp?.length && !runner.mcp)
		return Promise.resolve({
			ok: false,
			result: '',
			costUsd: 0,
			outputTokens: 0,
			durationMs: 0,
			error: `${runner.bin} cannot take MCP servers; remove this worker's MCP access`,
		})
	const started = Date.now()
	return new Promise((resolve) => {
		const id = agentIdentity()
		const child = spawn(bin, args, {
			cwd: t.cwd,
			env: { ...agentEnv(process.env, t.env, runner.auth), ...(id && { HOME: id.home }), ...t.env },
			...(id && { uid: id.uid, gid: id.gid }),
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		const out: Outcome = {}
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
			const progress = runner.event(ev, out)
			if (progress) t.onProgress?.(progress)
		})
		const finish = (error?: string) => {
			clearTimeout(timer)
			const err = error ?? out.error
			resolve({
				ok: !err && out.ok === true,
				result: out.result ?? '',
				costUsd: out.costUsd ?? 0,
				outputTokens: out.outputTokens ?? 0,
				durationMs: Date.now() - started,
				...(err ? { error: err } : {}),
			})
		}
		child.on('error', (err) => finish(`could not start ${bin}: ${err.message}`))
		child.on('close', (code) => {
			if (timedOut) return finish(`timed out after ${Math.round(t.timeoutMs / 60000)}m`)
			if (code !== 0 && out.ok === undefined)
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
