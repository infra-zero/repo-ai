import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'

/**
 * The cost and liability notice `setup` shows before any step (#45). The
 * README and docs carry the same paragraph as Markdown; a test keeps them
 * in sync with this one copy.
 */
export const NOTICE =
	"By installing or using repo-ai, you accept these risks and responsibilities. repo-ai runs AI agents unattended, and they spend your Anthropic credits or plan limits and your GitHub Actions minutes. The loop's limits are best-effort, not a spending guarantee. Set spend limits with your provider, and stop the loop when you aren't watching it. Agents can be wrong, so you review and merge every change. Provided as is under the MIT license, with no warranty; the authors aren't liable for costs, damages or changes made by agents. Not affiliated with Anthropic or GitHub."

export const RISKS_URL = 'https://docs.torcato.dev/repo-ai/docs/risks'

export const NOTICE_HASH = createHash('sha256').update(NOTICE).digest('hex')

/** Machine-local, not per repo: `$XDG_CONFIG_HOME/repo-ai/acknowledged`. */
export function acknowledgementPath(home: string = os.homedir()): string {
	const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
	return path.join(base, 'repo-ai', 'acknowledged')
}

/** True once this exact notice text was accepted on this machine. */
export async function isAcknowledged(file: string): Promise<boolean> {
	const saved = await fs.readJson(file).catch(() => null)
	return saved?.hash === NOTICE_HASH
}

export async function recordAcknowledgement(file: string, version: string): Promise<void> {
	await fs.outputJson(
		file,
		{ version, hash: NOTICE_HASH, acknowledgedAt: new Date().toISOString() },
		{ spaces: 2 }
	)
}
