import type { DashboardView } from '~/lib/api'
import { Card, CardContent } from './ui/card'
import { clock, short } from './common'

export function Activity({ view }: { view: DashboardView }) {
	const events = view.events // the API sends newest first
	return (
		<Card>
			<CardContent className="p-0">
				{events.length === 0 && (
					<p className="p-4 text-sm text-muted-foreground">No activity yet.</p>
				)}
				<ul className="divide-y font-mono text-xs">
					{events.map((e) => (
						<li key={`${e.t}-${e.repo}-${e.number}-${e.what}`} className="flex gap-3 px-4 py-1.5">
							<span className="shrink-0 text-muted-foreground">{clock(e.t)}</span>
							<span className="w-32 shrink-0 truncate">{short(e.repo)}</span>
							<span className="w-12 shrink-0 text-primary">{e.number ? `#${e.number}` : ''}</span>
							<span className="break-words">{e.what}</span>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	)
}
