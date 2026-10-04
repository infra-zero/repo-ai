import { createFileRoute } from '@tanstack/react-router'
import { WithView } from '~/components/page'
import { RepoSettings } from '~/components/repos'

export const Route = createFileRoute('/repos/$owner/$name')({
	component: function RepoPage() {
		const { owner, name } = Route.useParams()
		return <WithView>{(view) => <RepoSettings view={view} repo={`${owner}/${name}`} />}</WithView>
	},
})
