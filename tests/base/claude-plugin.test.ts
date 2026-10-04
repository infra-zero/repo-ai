import { delimiter, join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { installClaudePlugin, installedPlugin } from '../../src/base/claude-plugin.js'
import { FixerAbort } from '../../src/base/fixer-abort.js'
import { useTmpDir } from '../helpers/tmp-dir.js'

const newTmpDir = useTmpDir()
const settingsOf = (home: string) => join(home, '.claude', 'settings.json')

describe('installClaudePlugin', () => {
	it('copies the plugin and appends it to CLAUDE_CODE_PLUGIN_DIRS, keeping other settings', async () => {
		const home = newTmpDir()
		await fs.outputJson(settingsOf(home), {
			model: 'opus',
			env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: '/other' },
		})
		await installClaudePlugin(home)
		const plugin = installedPlugin(home)
		expect(await fs.pathExists(join(plugin, 'hooks', 'register.tsx'))).toBe(true)
		expect(await fs.pathExists(join(plugin, 'hooks', 'register.test.ts'))).toBe(false)
		expect(await fs.readJson(settingsOf(home))).toEqual({
			model: 'opus',
			env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: `/other${delimiter}${plugin}` },
		})
	})

	it('writes nothing on a second run', async () => {
		const home = newTmpDir()
		expect((await installClaudePlugin(home)).length).toBeGreaterThan(0)
		expect(await installClaudePlugin(home)).toEqual([])
	})

	it('refuses to overwrite unparseable settings', async () => {
		const home = newTmpDir()
		await fs.outputFile(settingsOf(home), '{ nope')
		await expect(installClaudePlugin(home)).rejects.toBeInstanceOf(FixerAbort)
	})
})
