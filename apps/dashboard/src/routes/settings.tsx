import { createFileRoute } from '@tanstack/react-router'
import { Settings } from '~/components/settings'
import { WithView } from '~/components/page'

export const Route = createFileRoute('/settings')({
	component: () => <WithView>{(view) => <Settings view={view} />}</WithView>,
})
