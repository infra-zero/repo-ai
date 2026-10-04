import { createFileRoute } from '@tanstack/react-router'
import { Activity } from '~/components/activity'
import { WithView } from '~/components/page'

export const Route = createFileRoute('/activity')({
	component: () => <WithView>{(view) => <Activity view={view} />}</WithView>,
})
