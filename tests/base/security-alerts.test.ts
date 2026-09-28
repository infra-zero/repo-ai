import { describe, expect, it } from 'vitest'
import { securityAlertWarning } from '../../src/base/security-alerts.js'
import type { GhExec, GhResult } from '../../src/base/gh.js'

const alert = (severity: string) => ({ security_vulnerability: { severity } })

/** `--paginate --slurp` wraps the page array inside an outer array. */
function fakeGh(alerts: ReturnType<typeof alert>[]): GhExec {
	return async (args): Promise<GhResult> => {
		const path = args[1] ?? ''
		if (path.includes('/dependabot/alerts?'))
			return { ok: true, stdout: JSON.stringify([alerts]), stderr: '', code: 0 }
		return { ok: false, stdout: '', stderr: 'unexpected', code: 1 }
	}
}

describe('securityAlertWarning (#203)', () => {
	it('warns on an open high alert', async () => {
		const gh = fakeGh([alert('high'), alert('moderate')])
		const w = await securityAlertWarning(gh, 'acme/widget', false)
		expect(w).toContain('1 open security alerts (1 high)')
		expect(w).toContain('https://github.com/acme/widget/security/dependabot')
	})

	it('folds moderate/low into the count for doctor, not for the tick warning', async () => {
		const gh = fakeGh([alert('high'), alert('moderate'), alert('moderate')])
		expect(await securityAlertWarning(gh, 'acme/widget', false)).toContain('1 open')
		expect(await securityAlertWarning(gh, 'acme/widget', true)).toContain('3 open')
	})

	it('does not warn on only-moderate alerts', async () => {
		const gh = fakeGh([alert('moderate'), alert('low')])
		expect(await securityAlertWarning(gh, 'acme/widget', false)).toBeNull()
		expect(await securityAlertWarning(gh, 'acme/widget', true)).toBeNull()
	})

	it('does not warn with no open alerts', async () => {
		const gh = fakeGh([])
		expect(await securityAlertWarning(gh, 'acme/widget', true)).toBeNull()
	})

	it('names both severities when critical and high are both open', async () => {
		const gh = fakeGh([alert('critical'), alert('high')])
		const w = await securityAlertWarning(gh, 'acme/widget', false)
		expect(w).toContain('1 critical, 1 high')
	})

	it('fails open on a 403/404 — never an error', async () => {
		const gh: GhExec = async () => ({ ok: false, stdout: '', stderr: 'HTTP 403', code: 1 })
		expect(await securityAlertWarning(gh, 'acme/widget', true)).toBeNull()
	})
})
