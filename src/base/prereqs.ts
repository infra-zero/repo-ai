import { execFile } from 'node:child_process'
import type { GhResult } from './gh.js'
import type { CheckResult } from './types.js'

/** `package.json`'s `engines.node`. */
export const MIN_NODE_MAJOR = 22

/** Runs `cmd args` in `cwd`; never rejects. `code` is null when the binary never ran. */
export type CmdExec = (cmd: string, args: string[], cwd: string) => Promise<GhResult>

const CMD_TIMEOUT_MS = 10_000

export const realCmdExec: CmdExec = (cmd, args, cwd) =>
	new Promise((resolve) => {
		// Args are internal constants — execFile never goes through a shell.
		execFile(cmd, args, { cwd, timeout: CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === 'number' ? err.code : null) : 0
			resolve({ ok: !err, stdout, stderr: stderr || (err ? String(err) : ''), code })
		})
	})

/** Why a gh call failed, in one line: a missing binary, else gh's own first stderr line. */
export function ghFailure(r: GhResult): string {
	if (r.code === null && /ENOENT/.test(r.stderr)) return 'gh is not on PATH'
	return (
		r.stderr
			.split('\n')
			.map((l) => l.trim())
			.find(Boolean) ?? `gh exited ${r.code ?? 'abnormally'}`
	)
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

/** `git@host:o/r`, `https://host/o/r` and `ssh://git@host/o/r`, never `nothost.example`. */
const onHost = (url: string, host: string) =>
	new RegExp(`(^|[@/])${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:/]`).test(url)

/** Drops `user:token@` from a remote URL so a credential never reaches doctor's output. */
const redact = (url: string) => url.replace(/\/\/[^@/]*@/, '//')

export interface Prerequisites {
	results: CheckResult[]
	/** Set when the GitHub checks cannot run: the failing prerequisite, in a few words. */
	ghBlocked?: string
}

/**
 * The tools the loop needs before anything else can be judged (#359). A failure
 * is `missing`, and `ghBlocked` names it so the GitHub checks say "not run"
 * rather than reporting a skip as ✓.
 */
export async function checkPrerequisites(
	dir: string,
	exec: CmdExec = realCmdExec,
	nodeVersion: string = process.versions.node,
	env: NodeJS.ProcessEnv = process.env
): Promise<Prerequisites> {
	const results: CheckResult[] = []
	const missing = (check: string, detail: string, hint: string) =>
		results.push({ check, status: 'missing', detail, hint })
	const ok = (check: string, detail: string) => results.push({ check, status: 'ok', detail })

	const nodeMajor = Number(nodeVersion.split('.')[0])
	if (nodeMajor >= MIN_NODE_MAJOR) ok('Node', `v${nodeVersion}`)
	else
		missing(
			'Node',
			`v${nodeVersion} — need ≥ ${MIN_NODE_MAJOR}`,
			`Install Node ${MIN_NODE_MAJOR} or newer`
		)

	const git = await exec('git', ['--version'], dir)
	if (git.ok) ok('git', firstLine(git.stdout))
	else missing('git', 'git is not on PATH', 'Install git: https://git-scm.com/downloads')

	let ghBlocked: string | undefined
	const gh = await exec('gh', ['--version'], dir)
	if (gh.ok) {
		ok('gh', firstLine(gh.stdout))
		// `--active`: a stale second account must not fail the one gh actually uses. gh < 2.47 lacks it.
		let auth = await exec('gh', ['auth', 'status', '--active'], dir)
		if (/unknown flag/.test(auth.stderr)) auth = await exec('gh', ['auth', 'status'], dir)
		if (auth.ok) ok('gh auth', 'logged in')
		else {
			ghBlocked = 'gh is not logged in'
			missing('gh auth', ghFailure(auth), 'Run `gh auth login`')
		}
	} else {
		ghBlocked = 'gh is unavailable'
		missing(
			'gh',
			ghFailure(gh),
			'Install the GitHub CLI: https://cli.github.com, then run `gh auth login`'
		)
		results.push({
			check: 'gh auth',
			status: 'optional-missing',
			detail: 'not run because gh is unavailable',
		})
	}

	const remote = git.ok ? await exec('git', ['remote', 'get-url', 'origin'], dir) : null
	const url = remote?.ok ? remote.stdout.trim() : ''
	const host = env.GH_HOST?.trim() || 'github.com'
	if (!remote) {
		results.push({
			check: 'GitHub remote',
			status: 'optional-missing',
			detail: 'not run because git is unavailable',
		})
		ghBlocked ??= 'git is unavailable'
	} else if (!url) {
		ghBlocked ??= 'there is no GitHub origin remote'
		missing(
			'GitHub remote',
			/not a git repository/i.test(remote.stderr) ? 'not a git repository' : 'no `origin` remote',
			'Run doctor in a clone of a GitHub repo, or `git remote add origin <github-url>`'
		)
	} else if (!onHost(url, host)) {
		ghBlocked ??= 'origin is not a GitHub remote'
		missing(
			'GitHub remote',
			`origin is ${redact(url)}, not on ${host}`,
			'The loop runs on GitHub only; set GH_HOST for GitHub Enterprise'
		)
	} else ok('GitHub remote', redact(url))

	// Present and reported, never judged (#369): add a floor only with the feature that needs it, cited here.
	const claude = await exec('claude', ['--version'], dir)
	if (claude.ok) ok('Claude Code', firstLine(claude.stdout))
	else
		missing(
			'Claude Code',
			claude.code === null && /ENOENT/.test(claude.stderr)
				? 'claude is not on PATH'
				: `\`claude --version\` failed: ${firstLine(claude.stderr)}`,
			'Install Claude Code: `npm install -g @anthropic-ai/claude-code`'
		)

	return { results, ghBlocked }
}
