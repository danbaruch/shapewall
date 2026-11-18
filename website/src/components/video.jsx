// Videos on the marketing pages. The rules:
// - The prerendered HTML holds only the poster (a <picture>, WebP with a JPEG fallback, with its width and height), so
//   nothing but the poster loads before someone asks for the video, and the box never changes size.
// - Films (the launch film, the tour, the quickstart) never play by themselves: a real button with the film's name and
//   length starts them inline, with sound and the browser's own controls. Close (or Escape) goes back to the poster.
// - Feature clips are silent loops: muted, playsinline, loaded and played only while on screen and paused off screen.
//   With "reduce motion" they never start by themselves: the poster shows a play button instead. Every clip has a
//   pause button (moving content longer than five seconds must be stoppable).
// - If a video cannot load, the poster stays, with a short note. The page never shows a broken player.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Pause, Play, X } from 'lucide-react'
import { MEDIA, clock, mediaUrl, orderedSources } from '../videos.js'
import { cx } from './ui.jsx'

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduce(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  return reduce
}

// Calls onFail once every <source> failed, or the video itself failed to decode.
function useVideoFailure(ref, onFail, active) {
  useEffect(() => {
    const video = ref.current
    if (!active || !video) return undefined
    const sources = [...video.querySelectorAll('source')]
    const last = sources[sources.length - 1]
    const fail = () => onFail()
    last?.addEventListener('error', fail)
    video.addEventListener('error', fail)
    // A source that failed before this effect ran: no source is left to try.
    if (video.networkState === 3 /* NETWORK_NO_SOURCE */) onFail()
    return () => {
      last?.removeEventListener('error', fail)
      video.removeEventListener('error', fail)
    }
  }, [ref, onFail, active])
}

export function Poster({ video, alt = '', sizes, eager = false, className }) {
  const { poster } = video
  return (
    <picture>
      <source
        type="image/webp"
        srcSet={poster.webp.map((image) => `${mediaUrl(image.file)} ${image.width}w`).join(', ')}
        sizes={sizes}
      />
      <img
        src={mediaUrl(poster.jpg.file)}
        alt={alt}
        width={video.width}
        height={video.height}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={eager ? 'high' : undefined}
        className={cx('block h-auto w-full', className)}
      />
    </picture>
  )
}

function Sources({ video }) {
  return orderedSources(video).map((source) => <source key={source.file} src={source.src} type={source.type} media={source.media} />)
}

// The play button and, after it is pressed, the film itself, over whatever box it is put in (a poster, or the home
// page's screenshot). `cta` is the visible label, e.g. "Watch the launch film".
export function FilmOverlay({ id, title, cta, onActiveChange, inset = 'inset-0', className, tone = 'dark' }) {
  const video = MEDIA[id]
  const [state, setState] = useState('poster') // poster | playing | failed
  const videoRef = useRef(null)
  const buttonRef = useRef(null)
  const restoreFocus = useRef(false)
  const length = clock(video.duration)

  const setActive = useCallback(
    (next) => {
      setState(next)
      onActiveChange?.(next === 'playing')
    },
    [onActiveChange],
  )
  const close = useCallback(() => {
    restoreFocus.current = true
    setActive('poster')
  }, [setActive])
  const failed = useCallback(() => setActive('failed'), [setActive])
  useVideoFailure(videoRef, failed, state === 'playing')

  useEffect(() => {
    if (state === 'playing') {
      const element = videoRef.current
      element?.focus({ preventScroll: true })
      element?.play?.().catch(() => {}) // a refused play leaves the controls up; nothing else to do
    } else if (restoreFocus.current) {
      restoreFocus.current = false
      buttonRef.current?.focus({ preventScroll: true })
    }
  }, [state])

  if (state === 'playing') {
    return (
      <div
        className={cx('absolute z-10 bg-black', inset, className)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
      >
        <video
          ref={videoRef}
          className="size-full bg-black object-contain"
          controls
          playsInline
          preload="auto"
          width={video.width}
          height={video.height}
          poster={mediaUrl(video.poster.jpg.file)}
          aria-label={title}
          onEnded={close}
        >
          <Sources video={video} />
          {(video.tracks || []).map((track) => (
            <track key={track.file} kind={track.kind} src={mediaUrl(track.file)} srcLang={track.srclang} label={track.label} />
          ))}
        </video>
        <button
          type="button"
          onClick={close}
          className="absolute top-3 right-3 grid size-9 place-items-center rounded-full bg-black/60 text-white backdrop-blur hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          aria-label={`Close ${title}`}
        >
          <X className="size-4.5" aria-hidden="true" />
        </button>
      </div>
    )
  }

  return (
    <div className={cx('absolute z-10', inset, className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setActive('playing')}
        className="film-play group absolute inset-0 grid w-full cursor-pointer place-items-center focus-visible:outline-none"
        aria-label={`Play ${title}, ${length}, with sound`}
        data-film={id}
      >
        <span
          className={cx(
            'inline-flex items-center gap-3 rounded-full py-2 pr-5 pl-2 text-[15px] font-semibold shadow-xl ring-1 backdrop-blur-md transition-transform duration-150 ease-out group-hover:scale-[1.03] group-focus-visible:outline-2 group-focus-visible:outline-offset-4 group-focus-visible:outline-wall-bright sm:text-[16px]',
            tone === 'dark' ? 'bg-night/80 text-white shadow-black/30 ring-white/15' : 'bg-card/90 text-ink shadow-black/15 ring-edge',
          )}
          aria-hidden="true"
        >
          <span className="grid size-10 place-items-center rounded-full bg-wall-bright text-night sm:size-11">
            <Play className="size-4.5 translate-x-px fill-current" />
          </span>
          <span>{cta}</span>
          <span className={tone === 'dark' ? 'font-medium text-white/60' : 'font-medium text-faint'}>{length}</span>
        </span>
      </button>
      {state === 'failed' ? (
        <p role="status" className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-night/80 px-3 py-1 text-[13px] text-white">
          The video could not load. Try again later.
        </p>
      ) : null}
    </div>
  )
}

// A film in its own frame: the poster, with the play button over it.
export function FilmFrame({ id, title, cta, sizes, eager = false, alt = '', className }) {
  const video = MEDIA[id]
  return (
    <figure className={cx('shot relative', className)} style={{ aspectRatio: `${video.width} / ${video.height}` }}>
      <Poster video={video} sizes={sizes} eager={eager} alt={alt} />
      <FilmOverlay id={id} title={title} cta={cta} />
    </figure>
  )
}

// A silent looping clip that plays while on screen.
export function Clip({ id, label, sizes = '(min-width: 1024px) 560px, 100vw', className, dark = false }) {
  const video = MEDIA[id]
  const reduce = usePrefersReducedMotion()
  const frame = useRef(null)
  const videoRef = useRef(null)
  const [near, setNear] = useState(false) // close enough to load
  const [inView, setInView] = useState(false)
  const [userChoice, setUserChoice] = useState(null) // null: follow the page; 'play' | 'pause': the visitor decided
  const [playing, setPlaying] = useState(false)
  const [shown, setShown] = useState(false) // first frame decoded: the video covers the poster
  const [failed, setFailed] = useState(false)
  const onFail = useCallback(() => setFailed(true), [])

  useEffect(() => {
    const element = frame.current
    if (!element || typeof IntersectionObserver === 'undefined') return undefined
    const loader = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '200px 0px' })
    const viewer = new IntersectionObserver((entries) => setInView(entries[entries.length - 1].isIntersecting), { threshold: 0.35 })
    loader.observe(element)
    viewer.observe(element)
    return () => {
      loader.disconnect()
      viewer.disconnect()
    }
  }, [])

  const wantsPlay = userChoice ? userChoice === 'play' && inView : inView && !reduce
  const mounted = !failed && (userChoice === 'play' || (near && !reduce))
  useVideoFailure(videoRef, onFail, mounted)

  useEffect(() => {
    const element = videoRef.current
    if (!element) return
    if (wantsPlay) element.play?.().catch(() => setPlaying(false))
    else element.pause?.()
  }, [wantsPlay, mounted])

  const toggle = () => setUserChoice(playing || wantsPlay ? 'pause' : 'play')
  const showButtonLarge = !playing && (reduce || userChoice === 'pause')

  return (
    <figure
      ref={frame}
      className={cx('shot relative', dark && 'border-night-line', className)}
      style={{ aspectRatio: `${video.width} / ${video.height}` }}
      data-clip={id}
    >
      <Poster video={video} sizes={sizes} alt={label} />
      {mounted ? (
        <video
          ref={videoRef}
          className={cx('absolute inset-0 size-full object-cover transition-opacity duration-200', shown ? 'opacity-100' : 'opacity-0')}
          muted
          loop
          playsInline
          preload="none"
          width={video.width}
          height={video.height}
          aria-hidden="true"
          tabIndex={-1}
          disablePictureInPicture
          onPlaying={() => {
            setPlaying(true)
            setShown(true)
          }}
          onPause={() => setPlaying(false)}
        >
          <Sources video={video} />
        </video>
      ) : null}
      {failed ? null : showButtonLarge ? (
        <button
          type="button"
          onClick={toggle}
          className="group absolute inset-0 grid w-full cursor-pointer place-items-center focus-visible:outline-none"
          aria-label={`Play video: ${label}`}
        >
          <span
            className="grid size-14 place-items-center rounded-full bg-night/75 text-white shadow-lg ring-1 ring-white/15 backdrop-blur-md transition-transform duration-150 group-hover:scale-105 group-focus-visible:outline-2 group-focus-visible:outline-offset-4 group-focus-visible:outline-wall-bright"
            aria-hidden="true"
          >
            <Play className="size-5 translate-x-px fill-current" />
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={toggle}
          className="absolute right-2.5 bottom-2.5 grid size-9 place-items-center rounded-full bg-night/65 text-white ring-1 ring-white/15 backdrop-blur-md hover:bg-night/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wall-bright"
          aria-label={`${playing || wantsPlay ? 'Pause' : 'Play'} video: ${label}`}
        >
          {playing || wantsPlay ? <Pause className="size-4 fill-current" aria-hidden="true" /> : <Play className="size-4 translate-x-px fill-current" aria-hidden="true" />}
        </button>
      )}
    </figure>
  )
}

// Several clips for one section, one at a time, chosen with tabs under the frame.
export function ClipTabs({ clips, dark = false, sizes }) {
  const [active, setActive] = useState(0)
  const base = useId()
  const tabs = useRef([])
  const select = (index) => {
    const next = (index + clips.length) % clips.length
    setActive(next)
    tabs.current[next]?.focus()
  }
  const current = clips[active]
  return (
    <div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active}`}>
        <Clip key={current.id} id={current.id} label={current.label} dark={dark} sizes={sizes} />
      </div>
      <div
        role="tablist"
        aria-label="Videos for this feature"
        className={cx(
          'mx-auto mt-4 flex w-fit max-w-full flex-wrap justify-center gap-1 rounded-xl p-1',
          dark ? 'bg-white/[0.06] ring-1 ring-night-line' : 'bg-sunk-2 ring-1 ring-line',
        )}
      >
        {clips.map((clip, index) => (
          <button
            key={clip.id}
            ref={(node) => {
              tabs.current[index] = node
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${index}`}
            aria-selected={index === active}
            aria-controls={`${base}-panel`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') select(active + 1)
              else if (event.key === 'ArrowLeft') select(active - 1)
              else if (event.key === 'Home') select(0)
              else if (event.key === 'End') select(clips.length - 1)
              else return
              event.preventDefault()
            }}
            className={cx(
              'rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wall',
              index === active
                ? dark
                  ? 'bg-night-2 text-white shadow-sm ring-1 ring-night-line'
                  : 'bg-card text-ink shadow-sm ring-1 ring-line'
                : dark
                  ? 'text-zinc-400 hover:text-white'
                  : 'text-slate hover:text-ink',
            )}
          >
            {clip.tab}
          </button>
        ))}
      </div>
    </div>
  )
}
