import { createServerFn } from '@tanstack/react-start'
// Type-only: the contract lives in the CLI (src/daemon/view.ts); nothing from src/ is bundled.
import type { DaemonConfig } from '@repo-ai/daemon/config'
import type { DashboardView } from '@repo-ai/daemon/view'

export type { DaemonConfig, DashboardView }

/**
 * The only code that knows the API URL and the worker secret. It runs on the
 * server (server functions are stripped from the client bundle), so neither
 * ever reaches the browser.
 */
async function call(path: string, init?: RequestInit): Promise<DashboardView> {
	const base = process.env.REPO_AI_API_URL ?? 'http://api:8080'
	const res = await fetch(new URL(path, base), {
		...init,
		headers: {
			'x-repo-ai-worker': process.env.REPO_AI_WORKER_SECRET ?? '',
			...(init?.body ? { 'content-type': 'application/json' } : {}),
		},
		signal: AbortSignal.timeout(10_000),
	}).catch((e: unknown) => {
		throw new Error(`API unreachable: ${e instanceof Error ? e.message : String(e)}`)
	})
	const body = (await res.json().catch(() => null)) as (DashboardView & { error?: string }) | null
	if (!res.ok || !body) throw new Error(body?.error ?? `API returned ${res.status}`)
	return body
}

export const getState = createServerFn({ method: 'GET' }).handler(() => call('/api/state'))

export const saveConfig = createServerFn({ method: 'POST' })
	.validator((d: DaemonConfig) => {
		// Shape only; the API validates fully.
		if (!d || typeof d !== 'object' || !Array.isArray(d.repos) || typeof d.workers !== 'object')
			throw new Error('invalid config')
		return d
	})
	.handler(({ data }) => call('/api/config', { method: 'POST', body: JSON.stringify(data) }))
