import type { Register } from 'claude-code'

import { blockedBash, blockedEdit } from './rules'

function deny(what: string) {
	return {
		deny: `release-guard: blocked ${what}. Releases are CI-only and need the user's explicit ask. If they asked, have them run it themselves with \`! <command>\`.`,
	}
}

export const register: Register = (on) => {
	on('tool.call', { tool: 'Bash' }, (_, e, next) => {
		const what = blockedBash(e.command)
		return what ? deny(what) : next(e)
	}).catch((_, e, next) => (next.called ? next(e) : { deny: 'release-guard: its guard failed.' }))

	on('tool.call', { tool: 'Edit' }, (_, e, next) => {
		const what = blockedEdit(e.file_path, e.old_string, e.new_string)
		return what ? deny(what) : next(e)
	}).catch((_, e, next) => (next.called ? next(e) : { deny: 'release-guard: its guard failed.' }))

	on('tool.call', { tool: 'Write' }, (_, e, next) =>
		// ponytail: Write has no old text; any Write of a package.json that carries a version is blocked.
		/(^|\/)package\.json$/.test(e.file_path) && /"version"\s*:/.test(e.content)
			? deny("rewriting package.json (use Edit; the version is semantic-release's)")
			: next(e)
	).catch((_, e, next) => (next.called ? next(e) : { deny: 'release-guard: its guard failed.' }))
}
