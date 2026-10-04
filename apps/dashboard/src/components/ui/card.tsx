import type * as React from 'react'
import { cn } from '~/lib/utils'

export const Card = ({ className, ...p }: React.ComponentProps<'div'>) => (
	<div
		className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', className)}
		{...p}
	/>
)
export const CardHeader = ({ className, ...p }: React.ComponentProps<'div'>) => (
	<div className={cn('flex flex-col gap-1.5 p-4', className)} {...p} />
)
export const CardTitle = ({ className, ...p }: React.ComponentProps<'div'>) => (
	<div className={cn('font-semibold leading-none tracking-tight', className)} {...p} />
)
export const CardContent = ({ className, ...p }: React.ComponentProps<'div'>) => (
	<div className={cn('p-4 pt-0', className)} {...p} />
)
