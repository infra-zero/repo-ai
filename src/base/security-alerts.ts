import { type GhExec, ghPaginated } from './gh.js'

/**
 * `loop tick`/`doctor`'s open Dependabot alerts probe (#203). Open
 * high/critical alerts are otherwise invisible to both — this reports a
 * one-line warning naming the count and links to the repo's alerts page.
 * Read-only, and 403/404 (no alerts access, alerts disabled on the repo)
 * is not an error: `ghPaginated` already turns any non-ok `gh` call into
 * `null`, so it fails open the same way `ciRunWarning` does.
 */

type Severity = 'critical' | 'high' | 'moderate' | 'low'
const SEVERITIES: Severity[] = ['critical', 'high', 'moderate', 'low']

interface AlertApi {
	security_vulnerability?: { severity?: string }
}

async function severityCounts(gh: GhExec, nwo: string): Promise<Record<Severity, number> | null> {
	const alerts = await ghPaginated<AlertApi>(
		gh,
		`repos/${nwo}/dependabot/alerts?state=open&per_page=100`
	)
	if (alerts === null) return null
	const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0 }
	for (const a of alerts) {
		const sev = a.security_vulnerability?.severity
		if (sev && (SEVERITIES as string[]).includes(sev)) counts[sev as Severity]++
	}
	return counts
}

/**
 * `null` when there is no open high/critical alert, or on any gh failure.
 * `includeLowSeverity` (`doctor`) folds moderate/low into the reported
 * count too; the `loop tick` warning counts only high+critical.
 */
export async function securityAlertWarning(
	gh: GhExec,
	nwo: string,
	includeLowSeverity: boolean
): Promise<string | null> {
	const counts = await severityCounts(gh, nwo)
	if (!counts) return null
	const bad = counts.critical + counts.high
	if (bad === 0) return null
	const total = includeLowSeverity ? bad + counts.moderate + counts.low : bad
	const breakdown = SEVERITIES.filter((s) => s === 'critical' || s === 'high')
		.filter((s) => counts[s] > 0)
		.map((s) => `${counts[s]} ${s}`)
		.join(', ')
	return `${total} open security alerts (${breakdown}): https://github.com/${nwo}/security/dependabot`
}
