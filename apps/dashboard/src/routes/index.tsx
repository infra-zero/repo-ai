import { createFileRoute } from '@tanstack/react-router'
import { Boards } from '~/components/board'
import { AgentCards, DecisionStream, Kpis, Leaderboard } from '~/components/floor'
import { WithView } from '~/components/page'

export const Route = createFileRoute('/')({
	validateSearch: (s: Record<string, unknown>): { repo?: string } =>
		typeof s.repo === 'string' ? { repo: s.repo } : {},
	component: Board,
})

function Board() {
	const { repo } = Route.useSearch()
	return (
		<WithView>
			{(view) => (
				<div className="flex flex-col gap-4">
					<Kpis view={view} />
					<div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
						<div className="flex min-w-0 flex-col gap-4">
							<AgentCards view={view} />
							<Boards
								view={repo ? { ...view, repos: view.repos.filter((r) => r.repo === repo) } : view}
							/>
						</div>
						<div className="flex flex-col gap-4">
							<Leaderboard view={view} />
							<DecisionStream view={view} />
						</div>
					</div>
				</div>
			)}
		</WithView>
	)
}
