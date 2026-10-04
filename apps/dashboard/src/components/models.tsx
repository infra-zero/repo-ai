import type { DashboardView } from '~/lib/api'
import { Badge } from './ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'

/** Minimal list; model and MCP settings are #306. Names only, never values. */
export function Models({ view }: { view: DashboardView }) {
	return (
		<Card className="max-w-2xl">
			<CardHeader>
				<CardTitle>Claude Code</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-2 text-sm">
				<p className="text-muted-foreground">
					Credentials held by the api. Values stay in <code>docker/.env</code>.
				</p>
				<div className="flex flex-wrap gap-2">
					{view.credentials.map((c) => (
						<Badge key={c} variant="muted" className="font-mono">
							{c}
						</Badge>
					))}
					{view.credentials.length === 0 && (
						<span className="text-muted-foreground">None set on the api.</span>
					)}
				</div>
			</CardContent>
		</Card>
	)
}
