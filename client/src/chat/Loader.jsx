// Shapewall's working indicator: the mark's four page tiles, with the amber
// "page being shaped" passing from tile to tile while the agent works. It
// sizes with the text around it (1em) unless `size` (px) is given. With
// reduced motion it is the still mark: teal tiles, the top right one amber.
// The tiles are <i> elements (styles.css, .sw-loader).
import { cn } from '../lib/utils'

export default function Loader({ size, className, label, ...props }) {
  return (
    <span
      className={cn('sw-loader', className)}
      style={size ? { fontSize: size } : undefined}
      aria-hidden={label ? undefined : 'true'}
      aria-label={label}
      role={label ? 'img' : undefined}
      {...props}
    >
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
