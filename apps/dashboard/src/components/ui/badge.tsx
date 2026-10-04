import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '~/lib/utils'

const badgeVariants = cva(
	'inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium',
	{
		variants: {
			variant: {
				default: 'border-transparent bg-primary text-primary-foreground',
				outline: 'text-foreground',
				muted: 'border-transparent bg-muted text-muted-foreground',
				success: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
				warning: 'border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400',
				danger: 'border-red-500/30 bg-red-500/15 text-red-600 dark:text-red-400',
				info: 'border-sky-500/30 bg-sky-500/15 text-sky-600 dark:text-sky-400',
			},
		},
		defaultVariants: { variant: 'default' },
	}
)

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>

export const Badge = ({
	className,
	variant,
	...p
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) => (
	<span className={cn(badgeVariants({ variant }), className)} {...p} />
)
