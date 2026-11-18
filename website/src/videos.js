// The site's videos: the manifest the encode script writes (src/media.json: file names, sizes, dimensions, durations,
// posters) plus what people read about each film. Plain JS, used by the pages and by src/seo.js (VideoObject data).
// The files are served from /media/ (website/media/ locally, a shared folder beside the releases on the server).
import manifest from './media.json' with { type: 'json' }

export const MEDIA = manifest.videos
export const mediaUrl = (file) => manifest.base + file

// The two films with structured data. uploadDate: the day the film was first published on the site.
export const FILMS = {
  'launch-film': {
    name: 'Shapewall launch film',
    description:
      'Shapewall in 92 seconds: every page of a site on one zoomable wall, comments pinned to the element, a coding agent making the change, and the team features.',
    uploadDate: '2026-11-18',
  },
  tour: {
    name: 'Shapewall product tour',
    description:
      'A narrated tour of Shapewall: capturing a site, the wall, pinning comments, handing them to a coding agent, before and after, page checks, and the team server.',
    uploadDate: '2026-11-18',
  },
  'docs-quickstart': {
    name: 'Shapewall quickstart',
    description: 'Install Shapewall, capture a running site and open the board, step by step.',
    uploadDate: '2026-11-18',
  },
}

// 92.34 -> "1:32"
export function clock(seconds) {
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// 92.34 -> "PT1M32S"
export function isoDuration(seconds) {
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  return `PT${minutes ? `${minutes}M` : ''}${total % 60}S`
}

// The best MP4 (the format every browser plays), for structured data and download links.
export function mainMp4(video) {
  return video.sources.filter((source) => source.type.startsWith('video/mp4')).sort((a, b) => b.height - a.height)[0]
}

// The <source> list in the order a browser should try them. MP4 (H.264) comes before WebM: at these settings the H.264
// encode is the smaller file, and every browser plays it; WebM stays as the fallback for a browser without H.264.
// A film's 1080p sources carry a media query, so a phone-width screen takes the 720p ones.
export function orderedSources(video) {
  const rank = (source) => (source.type.startsWith('video/mp4') ? 0 : 1)
  return [...video.sources]
    .sort((a, b) => b.height - a.height || rank(a) - rank(b))
    .map((source) => ({
      ...source,
      src: mediaUrl(source.file),
      media:
        video.kind === 'film' && source.height >= 1080 && video.sources.some((s) => s.height < 1080) ? '(min-width: 768px)' : undefined,
    }))
}

// VideoObject for structured data (src/seo.js).
export function videoObject(id, siteUrl) {
  const video = MEDIA[id]
  const film = FILMS[id]
  if (!video || !film) return null
  return {
    '@type': 'VideoObject',
    name: film.name,
    description: film.description,
    thumbnailUrl: [siteUrl + mediaUrl(video.poster.jpg.file), ...video.poster.webp.map((image) => siteUrl + mediaUrl(image.file))],
    uploadDate: film.uploadDate,
    duration: isoDuration(video.duration),
    contentUrl: siteUrl + mediaUrl(mainMp4(video).file),
    width: video.width,
    height: video.height,
    inLanguage: 'en',
  }
}

// What a clip does, from what is true right now (pure, so the tests can walk every case):
// - mounted: the <video> exists (and so starts loading). Never before the clip reaches the screen, never with reduce
//   motion until the visitor presses play, never after it failed (the poster stays).
// - wantsPlay: it should be playing. On screen, unless reduce motion is on or the visitor paused it; a visitor's play
//   wins over reduce motion. Off screen it always pauses.
// - large: the big centred play button over the poster (reduce motion, or paused by the visitor) instead of the small
//   corner pause/play button.
export function clipState({ reduce, near, inView, userChoice, playing, failed }) {
  const wantsPlay = userChoice ? userChoice === 'play' && inView : inView && !reduce
  const mounted = !failed && (userChoice === 'play' || (near && !reduce))
  const large = !failed && !playing && (reduce || userChoice === 'pause')
  return { wantsPlay, mounted, large }
}
