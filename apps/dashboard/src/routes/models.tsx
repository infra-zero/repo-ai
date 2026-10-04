import { createFileRoute } from '@tanstack/react-router'
import { Models } from '~/components/models'
import { WithView } from '~/components/page'

export const Route = createFileRoute('/models')({
	component: () => <WithView>{(view) => <Models view={view} />}</WithView>,
})
