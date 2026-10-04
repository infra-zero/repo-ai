import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	appCredentialsFromEnv,
	appJwt,
	ghLogin,
	mintInstallationToken,
	sameLogin,
} from '../../src/base/app-auth.js'
import type { GhExec } from '../../src/base/gh.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const creds = {
	appId: '123',
	privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
}

describe('appJwt', () => {
	it('is an RS256 JWT the public key verifies, issued by the app, ten minutes long', () => {
		const [h, p, sig] = appJwt(creds, 1_000_000_000_000).split('.')
		expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
		const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
		expect(payload).toEqual({ iat: 999_999_940, exp: 1_000_000_540, iss: '123' })
		const ok = createVerify('RSA-SHA256')
			.update(`${h}.${p}`)
			.verify(publicKey, Buffer.from(sig, 'base64url'))
		expect(ok).toBe(true)
	})
})

describe('mintInstallationToken', () => {
	it('finds the installation, scopes the token to the repo, and names the bot login', async () => {
		const calls: { url: string; method: string; body?: string }[] = []
		const fake = (async (url: string, init: RequestInit = {}) => {
			calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined })
			const json = url.endsWith('/app')
				? { slug: 'repo-ai-loop' }
				: url.endsWith('/installation')
					? { id: 42 }
					: url.includes('/users/')
						? { id: 99 }
						: { token: 'ghs_x', expires_at: '2026-10-04T12:00:00Z' }
			return new Response(JSON.stringify(json), { status: 200 })
		}) as typeof fetch
		expect(await mintInstallationToken(creds, 'rtorcato/repo-ai', fake)).toEqual({
			token: 'ghs_x',
			expiresAt: '2026-10-04T12:00:00Z',
			login: 'repo-ai-loop[bot]',
			email: '99+repo-ai-loop[bot]@users.noreply.github.com',
		})
		expect(calls.at(-1)?.url).toBe('https://api.github.com/users/repo-ai-loop%5Bbot%5D')
		expect(calls.at(-2)).toEqual({
			url: 'https://api.github.com/app/installations/42/access_tokens',
			method: 'POST',
			body: '{"repositories":["repo-ai"]}',
		})
	})

	it('names the failing call', async () => {
		const fake = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
		await expect(mintInstallationToken(creds, 'o/r', fake)).rejects.toThrow('→ 404')
	})

	it('refuses anything that is not owner/repo before it reaches a URL', async () => {
		await expect(mintInstallationToken(creds, '../x')).rejects.toThrow('not an owner/repo')
	})
})

describe('appCredentialsFromEnv', () => {
	it('reads the key from a file when one is named, and is null without an app id', async () => {
		const read = async (p: string) => `pem from ${p}`
		expect(
			await appCredentialsFromEnv(
				{ GITHUB_APP_ID: '7', GITHUB_APP_PRIVATE_KEY_FILE: '/k.pem' },
				read
			)
		).toEqual({ appId: '7', privateKeyPem: 'pem from /k.pem' })
		expect(await appCredentialsFromEnv({ GITHUB_APP_PRIVATE_KEY: 'x' }, read)).toBeNull()
	})
})

describe('ghLogin', () => {
	const gh: GhExec = async () => ({ ok: true, stdout: 'rtorcato\n', stderr: '', code: 0 })
	it('prefers the pinned App login, which GET /user cannot answer', async () => {
		expect(await ghLogin(gh, { REPO_AI_GH_LOGIN: 'repo-ai-loop[bot]' })).toBe('repo-ai-loop[bot]')
		expect(await ghLogin(gh, {})).toBe('rtorcato')
	})
})

describe('sameLogin', () => {
	it('matches a bot across GraphQL and REST spellings, and case', () => {
		expect(sameLogin('app/repo-ai-loop', 'Repo-AI-Loop[bot]')).toBe(true)
		expect(sameLogin('rtorcato', 'RTorcato')).toBe(true)
		expect(sameLogin('rtorcato', 'rtorcato-bot')).toBe(false)
		expect(sameLogin('', '')).toBe(false)
	})
})
