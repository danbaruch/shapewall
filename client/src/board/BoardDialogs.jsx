import { lazy, Suspense } from 'react'
import { fileUrl } from '../lib/api'
import { useOpened } from '../lib/hooks'
import { Button, Dialog } from '../components/ui'
const SettingsDialog = lazy(() => import('../settings/AgentSettings').then((module) => ({ default: module.SettingsDialog })))
const HistoryDialog = lazy(() => import('./History'))
const ShareDialog = lazy(() => import('../share/ShareDialog').then((module) => ({ default: module.ShareDialog })))
const LocalSettings = lazy(() => import('../settings/LocalSettings'))

// The board's dialogs: share, agent and local settings, page history and the
// capture confirmation. The lazy ones load the first time they open.
export function BoardDialogs({
  info,
  boardId,
  boards,
  wide,
  shareOpen,
  setShareOpen,
  refetchView,
  settingsAvailable,
  settingsOpen,
  updateParams,
  onInfoChanged,
  generalSettingsOpen,
  updates,
  historyPage,
  closeHistory,
  historyViewport,
  historyPageId,
  data,
  comments,
  filter,
  focusComment,
  onImageError,
  captureConfirm,
  setCaptureConfirm,
  busy,
  focusedPage,
  findPage,
  startCapture,
}) {
  const shareOpened = useOpened(shareOpen)
  const settingsOpened = useOpened(settingsOpen)
  return (
    <>
      {info?.shareEnabled && shareOpened ? (
        <Suspense fallback={null}>
          <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} boardId={boardId} onMoved={refetchView} />
        </Suspense>
      ) : null}
      {settingsAvailable && settingsOpened ? (
        <Suspense fallback={null}>
          <SettingsDialog
            open={settingsOpen}
            onClose={() => updateParams({ settings: null })}
            onSaved={onInfoChanged}
            touch={!wide}
            // Buzz text only on installs with the Buzz bridge on.
            buzz={info?.buzzAvailable === true}
          />
        </Suspense>
      ) : null}
      {generalSettingsOpen ? (
        <Suspense fallback={null}>
          <LocalSettings
            open
            onClose={() => updateParams({ settings: null })}
            info={info}
            boardCount={boards.length}
            onSaved={onInfoChanged}
            touch={!wide}
            onOpenUpdates={() => {
              updateParams({ settings: null })
              updates.current?.open()
            }}
          />
        </Suspense>
      ) : null}

      {historyPage ? (
        <Suspense fallback={null}>
          <HistoryDialog
            open={Boolean(historyPage)}
            onClose={closeHistory}
            page={historyPage}
            viewport={historyViewport}
            data={data}
            comments={comments.filter((comment) => comment.pageId === historyPageId && comment.viewport === historyViewport)}
            urlFor={(entry, thumb) => fileUrl(boardId, entry.kind, thumb ? entry.thumb : entry.file, entry.version)}
            onPickComment={(comment) => {
              closeHistory()
              updateParams({ filter: comment.status === 'resolved' && filter === 'open' ? 'all' : null })
              focusComment(comment)
            }}
            touch={!wide}
            onImageError={onImageError}
          />
        </Suspense>
      ) : null}

      <Dialog
        open={captureConfirm}
        onClose={() => (busy ? null : setCaptureConfirm(false))}
        title="Capture every page now?"
        footer={
          <>
            <Button size={wide ? 'md' : 'touch'} onClick={() => setCaptureConfirm(false)} disabled={busy}>
              Cancel
            </Button>
            {focusedPage && findPage(focusedPage) ? (
              <Button
                size={wide ? 'md' : 'touch'}
                onClick={() => startCapture(null, [focusedPage])}
                disabled={busy}
                data-sw-capture-only={focusedPage}
              >
                Only {findPage(focusedPage).title}
              </Button>
            ) : null}
            <Button
              size={wide ? 'md' : 'touch'}
              variant="default"
              onClick={() => startCapture()}
              disabled={busy}
              data-sw-capture-confirm="true"
            >
              Capture all
            </Button>
          </>
        }
      >
        <p className="p-5 text-sm text-muted">
          Shapewall captures all {data?.board?.pages.length || ''} pages at every viewport
          {focusedPage && findPage(focusedPage) ? ` (or only ${findPage(focusedPage).title}, the selected page)` : ''}. Comments stay where
          they are; pins on live pages follow their elements. The board updates when it finishes.
        </p>
      </Dialog>
    </>
  )
}
