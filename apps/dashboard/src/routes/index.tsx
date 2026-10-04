import { createFileRoute } from '@tanstack/react-router'
import { Boards } from '~/components/board'
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
				<Boards
					view={repo ? { ...view, repos: view.repos.filter((r) => r.repo === repo) } : view}
				/>
			)}
		</WithView>
	)
}
