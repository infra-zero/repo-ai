/** What the pane last read: `repo-ai loop dash --json`'s result, or why it failed. */
export type Dash = { tick?: Tick; error?: string }

/** The fields of `LoopTickResult` the pane draws (bodies already stripped by `--json`). */
export type Tick = {
	summary: string
	halt?: string | null
	liveAgents: number
	slots: number
	[list: string]: unknown
}

declare module 'claude-code' {
	interface PluginState {
		'repo-ai': { dash: Dash }
	}
}
