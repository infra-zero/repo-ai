import type { ReactNode } from 'react'
import type { DashboardView } from '~/lib/api'
import { useDashboard } from '~/lib/use-dashboard'

/** Gives a route its data, or the loading / unreachable message. */
export function WithView({ children }: { children: (view: DashboardView) => ReactNode }) {
	const { data: view, error } = useDashboard()
	if (!view)
		return (
			<p className="text-sm text-muted-foreground">
				{error ? 'Cannot reach the API.' : 'Loading…'}
			</p>
		)
	return <>{children(view)}</>
}
