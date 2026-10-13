// ponytail: regex over the command text, not a shell parser — `bash -c "$(…)"` tricks get past it.
// It guards against an agent slipping, not an adversary.
// Each rule matches only where a command starts (line start, or after ; & | ( $( ),
// so the same words inside a heredoc or a quoted issue body don't trip it.
// A `then`/`do`/`else` after the boundary, and any `env`/`command`/`time`/`sudo`/`npx` and `VAR=value` prefixes, are skipped.
const AT = String.raw`(?:^|[;&|(]|\$\()\s*(?:(?:then|do|else)\s+)?(?:(?:env|command|time|sudo|npx)\s+|\w+=\S*\s+)*`
// `git -C <dir>` / `git -c k=v` before the subcommand, as worktree agents write it.
const GIT = String.raw`git(?:\s+-[Cc]\s+\S+)*\s+`
const rule = (body: string, flags = '') => new RegExp(AT + body, `m${flags}`)
// `gh workflow run` flags, with or without a value, before the workflow name or file. The flag name
// stops at `=` and a value can't start with `-`, so each token parses one way only: no backtracking blowup.
const RUN = String.raw`gh\s+workflow\s+run\s+(?:-[^\s=]+(?:[\s=][^-\s]\S*)?\s+)*`
// Only flags until the command ends, so a `$var` counts as the workflow only when it is the last positional.
const FLAGS = String.raw`(?:\s+-[^\s=]+(?:[\s=][^-\s]\S*)?)*\s*(?:$|[;&|)])`

const RULES: [RegExp, string][] = [
	[rule(String.raw`(npm|pnpm|yarn|bun)\b[^\n;&|]*\spublish(?![\w-])`), 'publishing to npm'],
	[
		rule(
			String.raw`(?:(npm|pnpm|yarn|bun\s+pm)\s+version\b|(npm|pnpm)\s+pkg\s+set\b[^\n;&|]*\s["']?version=)`
		),
		'bumping the version',
	],
	[
		rule(
			String.raw`(?:(?:npm|pnpm|yarn)\s+(?:dlx|exec|run)\s+|(?:pnpm|yarn|bunx)\s+)?semantic-release\b`
		),
		'running semantic-release locally',
	],
	[
		rule(
			GIT +
				String.raw`tag\s+(?!-l\b|--list\b|-n\b|--contains\b|--points-at\b|--sort\b|--merged\b|--no-merged\b|--format\b|$|[|;&)])`
		),
		'creating a tag',
	],
	[
		rule(
			GIT +
				String.raw`push\b[^\n;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S|\s--tags\b|\s--follow-tags\b|\s--mirror\b|\s--delete\b|\s:\S)`
		),
		'force pushing, pushing --tags/--follow-tags, or deleting a remote ref',
	],
	[
		// A single tag by name: `tag v1`, `refs/tags/…`, or a `v1.2.3`-shaped ref (`v2-migration` stays a branch).
		rule(
			GIT +
				String.raw`push\b[^\n;&|]*\s(?:tag\s|\S*refs/tags/|(?:\S*:)?v\d+(?:\.\d+){2}(?:[-+][\w.]+)?(?![\w./-])|(?:\S*:)?v\d+(?:\.\d+)*(?![\w./-]))`
		),
		'pushing a tag',
	],
	[rule(RUN + String.raw`\S*release`, 'i'), 'dispatching the release workflow'],
	[
		rule(String.raw`gh\s+api\b[^\n;&|]*actions/workflows/[^\s/]*release[^\s/]*/dispatches`, 'i'),
		'dispatching the release workflow',
	],
	// A numeric workflow ID, or a `$var` holding one, can't be resolved offline, so any one might be release.yml.
	[
		rule(RUN + String.raw`["']?(?:\d+["']?(?![^\s;&|)])|\$[^\s;&|)]*` + FLAGS + ')'),
		'dispatching a workflow by numeric ID or variable (it may be the release workflow)',
	],
	[
		rule(String.raw`gh\s+api\b[^\n;&|]*actions/workflows/(?:\d+|\$[^\s/]*)/dispatches`),
		'dispatching a workflow by numeric ID or variable (it may be the release workflow)',
	],
	// release.yml also fires on `milestone: closed`. ponytail: `-f`/`-F`/`--field` only; a body sent
	// with `--input` isn't seen.
	[
		rule(
			String.raw`gh\s+api\b(?=[^\n;&|]*milestones/(?:\d+|\$))[^\n;&|]*(?:\s|--(?:raw-)?field=|-[fF])["']?state=["']?closed\b`
		),
		'closing a milestone (it fires the release workflow)',
	],
	[rule(String.raw`gh\s+release\s+create\b`), 'creating a GitHub release'],
]

// Heredoc bodies are data, not commands: drop them before matching.
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?^\s*\1$/gm

export function blockedBash(command: string): string | undefined {
	const code = command.replace(HEREDOC, '')
	return RULES.find(([re]) => re.test(code))?.[1]
}

// Hand-editing package.json "version" — semantic-release owns it.
export function blockedEdit(
	filePath: string,
	oldText: string,
	newText: string
): string | undefined {
	if (!/(^|\/)package\.json$/.test(filePath)) return undefined
	const version = /"version"\s*:\s*"[^"]*"/
	const before = oldText.match(version)?.[0]
	const after = newText.match(version)?.[0]
	return before !== after ? 'changing the package.json version' : undefined
}
