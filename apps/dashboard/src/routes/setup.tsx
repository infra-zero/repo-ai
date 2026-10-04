import { createFileRoute } from '@tanstack/react-router'
import { WithView } from '~/components/page'
import { Setup } from '~/components/setup'

export const Route = createFileRoute('/setup')({
	component: () => <WithView>{(view) => <Setup view={view} />}</WithView>,
})
