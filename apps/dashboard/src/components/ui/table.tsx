import type * as React from 'react'
import { cn } from '~/lib/utils'

export const Table = ({ className, ...p }: React.ComponentProps<'table'>) => (
	<div className="relative w-full overflow-x-auto">
		<table className={cn('w-full caption-bottom text-sm', className)} {...p} />
	</div>
)
export const TableHeader = (p: React.ComponentProps<'thead'>) => (
	<thead className="[&_tr]:border-b" {...p} />
)
export const TableBody = (p: React.ComponentProps<'tbody'>) => (
	<tbody className="[&_tr:last-child]:border-0" {...p} />
)
export const TableRow = ({ className, ...p }: React.ComponentProps<'tr'>) => (
	<tr className={cn('border-b transition-colors hover:bg-muted/40', className)} {...p} />
)
export const TableHead = ({ className, ...p }: React.ComponentProps<'th'>) => (
	<th
		className={cn(
			'h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground',
			className
		)}
		{...p}
	/>
)
export const TableCell = ({ className, ...p }: React.ComponentProps<'td'>) => (
	<td className={cn('px-3 py-2 align-middle', className)} {...p} />
)
