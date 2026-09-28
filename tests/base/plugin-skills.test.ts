import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { checkPluginSkills } from '../../src/base/checks.js'
import { PLUGIN_NAME, readShippedSkill } from '../../src/cli/generators/claude-skills.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()

/** A HOME with a plugin cache for `repo-ai@repo-ai`, one skill's content overridable. */
async function pluginHome(content: Partial<Record<string, string>> = {}): Promise<string> {
	const dir = newTmpDir()
	const installPath = join(dir, '.claude', 'plugins', 'cache', PLUGIN_NAME, PLUGIN_NAME, 'abc123')
	const shipped = await readShippedSkill('ai-loop')
	await fs.outputFile(
		join(installPath, 'skills', 'ai-loop', 'SKILL.md'),
		content['ai-loop'] ?? shipped.content
	)
	await fs.outputJson(join(dir, '.claude', 'plugins', 'installed_plugins.json'), {
		version: 2,
		plugins: { [`${PLUGIN_NAME}@${PLUGIN_NAME}`]: [{ scope: 'user', installPath }] },
	})
	return dir
}

describe('checkPluginSkills (#154)', () => {
	it('is optional-missing when the plugin was never installed', async () => {
		const r = await checkPluginSkills(newTmpDir())
		expect(r.status).toBe('optional-missing')
		expect(r.detail).toContain('not installed via the Claude Code plugin')
	})

	it('is ok when the cached copy matches what this package ships', async () => {
		const r = await checkPluginSkills(await pluginHome())
		expect(r.status).toBe('ok')
		expect(r.detail).toContain('matches what this package ships')
	})

	it('is optional-missing, never failing, when the cached copy is stale — never a fork', async () => {
		const r = await checkPluginSkills(await pluginHome({ 'ai-loop': 'stale content\n' }))
		expect(r.status).toBe('optional-missing')
		expect(r.detail).toContain('ai-loop')
		expect(r.hint).toContain('/plugin update repo-ai@repo-ai')
	})
})
