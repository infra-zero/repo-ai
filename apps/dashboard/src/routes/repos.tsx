import { createFileRoute } from '@tanstack/react-router'
import { Repos } from '~/components/repos'
import { WithView } from '~/components/page'

export const Route = createFileRoute('/repos')({
	component: () => <WithView>{(view) => <Repos view={view} />}</WithView>,
})
