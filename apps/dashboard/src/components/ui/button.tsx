import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '~/lib/utils'

const buttonVariants = cva(
	'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
	{
		variants: {
			variant: {
				default: 'bg-primary text-primary-foreground hover:bg-primary/90',
				outline: 'border bg-transparent hover:bg-muted',
				ghost: 'hover:bg-muted',
			},
			size: { default: 'h-9 px-4', sm: 'h-8 px-3 text-xs', icon: 'size-8' },
		},
		defaultVariants: { variant: 'default', size: 'default' },
	}
)

export const Button = ({
	className,
	variant,
	size,
	type = 'button',
	...p
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>) => (
	<button type={type} className={cn(buttonVariants({ variant, size }), className)} {...p} />
)
