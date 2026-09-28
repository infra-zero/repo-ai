import { spawn } from 'node:child_process'

/** `gh` runner copied from @rtorcato/repo-tooling (src/base/github-settings.ts), not shared: ~50 lines is cheaper than a cross-package dependency. */

export interface GhResult {
	ok: boolean
	stdout: string
	stderr: string
	/** Process exit code, or null when gh never ran / timed out. */
	code: number | null
}

/** `stdin`, when given, is written to gh's stdin (for `--input -` bodies). */
export type GhExec = (args: string[], stdin?: string) => Promise<GhResult>

const GH_TIMEOUT_MS = 10_000

/**
 * `gh api <route> --paginate --slurp` — every page of a REST list endpoint,
 * concatenated. `--slurp` wraps each page's array inside an outer array
 * instead of printing them back to back (which plain `JSON.parse` can't
 * split); a bare `--jq` would instead run once per page. Use this for any
 * REST listing whose result is treated as a complete set — `gh label list`,
 * `gh issue list` and friends cap at `--limit`, but `gh api` has no such cap.
 */
export async function ghPaginated<T>(gh: GhExec, route: string): Promise<T[] | null> {
	const r = await gh(['api', route, '--paginate', '--slurp'])
	if (!r.ok) return null
	try {
		return (JSON.parse(r.stdout) as T[][]).flat()
	} catch {
		return null
	}
}

/**
 * Real `gh` runner — never rejects; a missing/failing gh resolves ok:false.
 * `cwd` scopes gh's repo resolution to the target dir so `-d/--directory` is
 * honored (gh otherwise resolves the remote from process.cwd()). Not annotated
 * `: GhExec` so the optional cwd stays callable; still assignable where GhExec
 * is expected.
 */
export const realGhExec = (
	args: string[],
	stdin?: string,
	cwd?: string,
	env?: NodeJS.ProcessEnv
): Promise<GhResult> =>
	new Promise((resolve) => {
		let settled = false
		const done = (r: GhResult) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(r)
		}
		// gh args are internal/derived from gh itself (never user free-text), so
		// shell:false + an args array keeps this injection-safe.
		const child = spawn('gh', args, {
			cwd,
			env: env && { ...process.env, ...env },
			stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		const timer = setTimeout(() => {
			child.kill()
			done({ ok: false, stdout: '', stderr: 'gh timed out', code: null })
		}, GH_TIMEOUT_MS)
		child.stdout?.on('data', (d) => {
			stdout += d
		})
		child.stderr?.on('data', (d) => {
			stderr += d
		})
		child.on('close', (code) => done({ ok: code === 0, stdout, stderr, code }))
		child.on('error', (err) => done({ ok: false, stdout: '', stderr: String(err), code: null }))
		if (stdin !== undefined && child.stdin) {
			child.stdin.write(stdin)
			child.stdin.end()
		}
	})
