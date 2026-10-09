export type Snapshot = {
	/** Open items per ai-* label. */
	counts: Record<string, number>
	/** First line of .claude/ai-loop-status, or null when the file is absent or stale. */
	loop: string | null
	/** Seconds since the loop summary last changed (line 4), or null. */
	loopAge: number | null
}

declare module 'claude-code' {
	interface PluginState {
		'repo-ai-rainbow': { snapshot: Snapshot | null }
	}
}
