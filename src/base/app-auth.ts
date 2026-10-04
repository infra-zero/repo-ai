/**
 * Running the loop as a GitHub App (#280): installation tokens instead of a
 * second user account and a swapped gh profile. The token goes to `gh` and
 * `git` as `GH_TOKEN`; it lasts an hour, so callers mint one per tick.
 *
 * An installation token cannot call `GET /user` (403), so the App's login —
 * `<slug>[bot]` — travels in `REPO_AI_GH_LOGIN`, which {@link ghLogin} reads
 * before asking gh.
 */
import { createSign } from 'node:crypto'
import type { GhExec } from './gh.js'

const API = 'https://api.github.com'

export interface AppCredentials {
	appId: string
	privateKeyPem: string
}

export interface InstallationToken {
	token: string
	expiresAt: string
	/** `<slug>[bot]` — what REST shows as the author of the App's comments and reviews. */
	login: string
}

type Fetch = typeof fetch

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')

/** The App's own JWT (RS256, 9 minutes; `iat` backdated a minute for clock drift). */
export function appJwt({ appId, privateKeyPem }: AppCredentials, now = Date.now()): string {
	const iat = Math.floor(now / 1000) - 60
	const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
		JSON.stringify({ iat, exp: iat + 600, iss: appId })
	)}`
	const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem)
	return `${unsigned}.${b64url(signature)}`
}

async function call<T>(f: Fetch, jwt: string, route: string, init: RequestInit = {}): Promise<T> {
	const res = await f(`${API}${route}`, {
		...init,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${jwt}`,
			'x-github-api-version': '2022-11-28',
		},
	})
	if (!res.ok) throw new Error(`GitHub App: ${init.method ?? 'GET'} ${route} → ${res.status}`)
	return (await res.json()) as T
}

/** A token scoped to one repo the App is installed on. */
export async function mintInstallationToken(
	creds: AppCredentials,
	ownerRepo: string,
	f: Fetch = fetch
): Promise<InstallationToken> {
	// It goes into an API path: GitHub owners are alphanumerics and hyphens; a repo is never `.`/`..`.
	if (!/^[A-Za-z0-9-]+\/(?!\.\.?$)[\w.-]+$/.test(ownerRepo))
		throw new Error(`not an owner/repo: ${ownerRepo}`)
	const repo = ownerRepo.split('/')[1]
	const jwt = appJwt(creds)
	const [{ slug }, { id }] = await Promise.all([
		call<{ slug: string }>(f, jwt, '/app'),
		call<{ id: number }>(f, jwt, `/repos/${ownerRepo}/installation`),
	])
	const { token, expires_at } = await call<{ token: string; expires_at: string }>(
		f,
		jwt,
		`/app/installations/${id}/access_tokens`,
		{ method: 'POST', body: JSON.stringify({ repositories: [repo] }) }
	)
	return { token, expiresAt: expires_at, login: `${slug}[bot]` }
}

/** `GITHUB_APP_ID` plus `GITHUB_APP_PRIVATE_KEY`, or a file at `GITHUB_APP_PRIVATE_KEY_FILE`. */
export async function appCredentialsFromEnv(
	env: NodeJS.ProcessEnv = process.env,
	readFile: (p: string) => Promise<string> = (p) =>
		import('node:fs/promises').then((fs) => fs.readFile(p, 'utf8'))
): Promise<AppCredentials | null> {
	const appId = env.GITHUB_APP_ID?.trim()
	if (!appId) return null
	const file = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim()
	const privateKeyPem = file ? await readFile(file) : env.GITHUB_APP_PRIVATE_KEY
	return privateKeyPem ? { appId, privateKeyPem } : null
}

/** Who gh acts as: `REPO_AI_GH_LOGIN` when an App token is in use, else `gh api user`. */
export async function ghLogin(gh: GhExec, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const pinned = env.REPO_AI_GH_LOGIN?.trim()
	if (pinned) return pinned
	const r = await gh(['api', 'user', '--jq', '.login'])
	return r.ok ? r.stdout.trim() : ''
}

/**
 * One account, however GitHub spells it: case-insensitive, and a bot's
 * GraphQL `app/<slug>` equals its REST `<slug>[bot]`.
 */
export function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
	const norm = (s: string) =>
		s
			.toLowerCase()
			.replace(/^app\//, '')
			.replace(/\[bot\]$/, '')
	return !!a && !!b && norm(a) === norm(b)
}
