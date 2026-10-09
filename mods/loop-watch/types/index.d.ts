export type LoopStatus = { summary: string; next: string; isStale: boolean } | null
export type Item = { kind: 'pr' | 'issue'; number: number; title: string; labels: string[] }
export type AgentRow = { id: string; type: string; description: string; status: string }
export type Snapshot = {
	loop: LoopStatus
	items: Item[]
	agents: AgentRow[]
	ghError?: string
	updatedAt: number
}

declare module 'claude-code' {
	interface PluginState {
		'loop-watch': { snapshot: Snapshot | null; activity: Record<string, string> }
	}
}
