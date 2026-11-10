import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import { cn } from '../../lib/utils'
import { tabItemClass, tabListClass } from './tabs'
import { Tooltip } from './tooltip'

// One choice out of a few (a segmented control). Arrow keys move between the
// options. Picking the current option again keeps it (never "nothing").
// options: [{ id, label, count?, tooltip? }] (tooltip: for an icon-only label). variant: segmented (default) or underline,
// the same two looks as Tabs.
export function ToggleGroup({
  label,
  options,
  value,
  onChange,
  large = false,
  disabled = false,
  variant = 'segmented',
  className,
  itemClassName,
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      disabled={disabled}
      onValueChange={(next) => (next ? onChange(next) : null)}
      aria-label={label}
      className={cn(tabListClass[variant], className)}
      data-sw-tabs-variant={variant}
    >
      {options.map((option) => (
        <Tooltip key={option.id} content={option.tooltip} side="bottom">
          <ToggleGroupPrimitive.Item
            value={option.id}
            className={cn(tabItemClass(variant, large, 'on'), itemClassName)}
            data-sw-option={option.id}
          >
            {option.label}
            {option.count !== undefined ? <span className="tabular ml-1 text-faint">{option.count}</span> : null}
          </ToggleGroupPrimitive.Item>
        </Tooltip>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}
