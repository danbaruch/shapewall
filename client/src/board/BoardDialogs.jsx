import { Suspense } from 'react'
import { fileUrl } from '../lib/api'
import { useOpened } from '../lib/hooks'
import { Button, Dialog } from '../components/ui'
import { PanelBoundary, PanelFailed, lazyPanel } from '../components/chunk-boundary'
const SettingsDialog = lazyPanel(() => import('../settings/AgentSettings').then((module) => ({ default: module.SettingsDialog })))
const HistoryDialog = lazyPanel(() => import('./History'))
const ShareDialog = lazyPanel(() => import('../share/ShareDialog').then((module) => ({ default: module.ShareDialog })))
const LocalSettings = lazyPanel(() => import('../settings/LocalSettings'))

// A dialog whose code did not load: the same place, a small dialog with the retry.
const failedDialog =
  (title, open, onClose) =>
  ({ error, retry }) => (
    <Dialog open={open} onClose={onClose} title={title}>
      <PanelFailed error={error} onRetry={retry} compact />
    </Dialog>
  )

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
        <PanelBoundary retry={ShareDialog} fallback={failedDialog('Share', shareOpen, () => setShareOpen(false))}>
          <Suspense fallback={null}>
            <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} boardId={boardId} onMoved={refetchView} />
          </Suspense>
        </PanelBoundary>
      ) : null}
      {settingsAvailable && settingsOpened ? (
        <PanelBoundary
          retry={SettingsDialog}
          fallback={failedDialog('Agent settings', settingsOpen, () => updateParams({ settings: null }))}
        >
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
        </PanelBoundary>
      ) : null}
      {generalSettingsOpen ? (
        <PanelBoundary retry={LocalSettings} fallback={failedDialog('Settings', true, () => updateParams({ settings: null }))}>
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
        </PanelBoundary>
      ) : null}

      {historyPage ? (
        <PanelBoundary retry={HistoryDialog} fallback={failedDialog('History', Boolean(historyPage), closeHistory)}>
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
        </PanelBoundary>
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
