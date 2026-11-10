// The composer: notice line, queued messages, starter prompts or follow-ups,
// /help, pending images, mentions and text files, the text box (with "@"
// mentions and "/" commands, ComposerInput.jsx), the attach menu, the
// agent's option menus and usage ring, the mic and send / queue / stop.

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Crosshair, FileImage, FileText, ListPlus, Mic, MonitorSmartphone, Paperclip, Square, Upload, X } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from '../components/ui'
import { cn } from '../lib/utils'
import { ATTACH_MAX } from './images'
import { ComposerInput } from './ComposerInput'
import { AgentOptions, FileChips, HelpCard, MentionChips, PromptChips, QueuedMessages, UsageRing } from './composerParts'
import { TEXT_ACCEPT, TEXT_FILES_MAX, footerLayout } from './composerModel.js'

// Starter prompts: on an empty thread, and above the composer until the
// person sends something in this thread.
export const SUGGESTIONS = {
  board: ["What's still open?", 'Fix the next @agent comment', 'Which pages need the most work?'],
  comment: ['What does this comment ask for?', 'Fix this comment', 'Suggest a smaller change'],
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

export function Composer({
  touch,
  notice,
  dictation,
  showStarters,
  followUps = [],
  comment,
  draft,
  onDraft,
  attachments,
  onRemoveAttachment,
  mentions = [],
  candidates = [],
  onMention,
  onRemoveMention,
  commands = [],
  onCommand,
  files = [],
  onRemoveFile,
  queue = [],
  onEditQueued,
  onRemoveQueued,
  help = false,
  onCloseHelp,
  usage = null,
  options = null,
  optionsLoading = false,
  onChooseOption,
  onSubmit,
  onStop,
  onMic,
  addFiles,
  vision,
  running,
  turnRunning,
  selectingProfile,
  captureFor,
  attachElement,
  attachPage,
  focused,
  focusedPage,
  pageItems,
  viewport,
}) {
  const inputRef = useRef(null)
  const fileRef = useRef(null)
  const textRef = useRef(null)
  // The footer row's width: room for a menu per option, or one combined.
  const actionsRef = useRef(null)
  const [footerWidth, setFooterWidth] = useState(0)
  useEffect(() => {
    const node = actionsRef.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => setFooterWidth(Math.round(entry.contentRect.width)))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const { layout, usage: usageFit } = footerLayout({ width: footerWidth, options, usage: Boolean(usage), touch })
  const hasContent = Boolean(draft.trim() || attachments.length || mentions.length || files.length)
  // Footer buttons are 44px targets on touch; with a pointer 36 x 44, and
  // the visible circle (fill, hover) is the inner 32px, so send does not
  // outweigh the icons beside it and the option menus have room.
  const iconSize = touch ? undefined : 'w-9 rounded-full bg-clip-content px-0.5 py-1.5 shadow-none'
  const onKeyDown = (event) => {
    // React's key event has no isComposing: an IME's Enter (it picks a word) is on the native event.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !touch) {
      event.preventDefault()
      onSubmit()
    }
  }
  const attachFull = attachments.length >= ATTACH_MAX && files.length >= TEXT_FILES_MAX
  const chips = showStarters ? SUGGESTIONS[comment ? 'comment' : 'board'] : followUps
  return (
    <form
      className="shrink-0 p-3"
      style={{ paddingBottom: touch ? 'max(0.75rem, env(safe-area-inset-bottom, 0px))' : undefined }}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      // Escape closes the /help card first, wherever the focus is in the
      // composer (not the panel, and not the phone sheet: data-sw-own-escape).
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !help) return
        event.preventDefault()
        event.stopPropagation()
        onCloseHelp?.()
      }}
      data-sw-own-escape={help ? 'true' : undefined}
    >
      {notice || dictation.error ? (
        <p
          className={cn('mb-1.5 px-1 text-xs', notice?.tone === 'bad' || !notice ? 'text-bad' : 'text-muted')}
          role="alert"
          data-sw-chat-notice="true"
        >
          {notice?.text || dictation.error}
        </p>
      ) : null}
      <QueuedMessages items={queue} onEdit={onEditQueued} onRemove={onRemoveQueued} touch={touch} />
      {help ? <HelpCard onClose={onCloseHelp} touch={touch} /> : null}
      {chips?.length && !queue.length ? (
        <PromptChips
          items={chips}
          onPick={(text) => onSubmit(text)}
          touch={touch}
          label={showStarters ? 'Suggested prompts' : 'Suggested next steps'}
          hook={showStarters ? 'data-sw-chat-suggestion' : 'data-sw-chat-follow-up'}
        />
      ) : null}
      {attachments.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5" data-sw-chat-pending="true">
          {attachments.map((item) => (
            <div key={item.id} className="relative">
              <img src={item.preview} alt={item.name} className="h-14 w-14 rounded-md border border-line object-cover" />
              <button
                type="button"
                className={cn(
                  'absolute -top-1.5 -right-1.5 inline-flex items-center justify-center rounded-full border border-line bg-surface text-muted shadow-card hover:text-fg',
                  touch ? 'h-7 w-7' : 'h-5 w-5',
                )}
                aria-label={`Remove ${item.name}`}
                onClick={() => onRemoveAttachment(item.id)}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <MentionChips items={mentions} onRemove={onRemoveMention} touch={touch} className="mb-1.5" />
      <FileChips items={files} onRemove={onRemoveFile} touch={touch} className="mb-1.5" />
      <div className="rounded-2xl border border-line bg-surface p-2 shadow-card focus-within:border-accent/60" data-sw-chat-composer="true">
        <ComposerInput
          ref={inputRef}
          size={touch ? 'touch' : 'md'}
          rows={2}
          // A fixed two whole lines (py-2 is the 1rem), so the composer never
          // moves while typing or dictating and no line shows cut in half;
          // longer drafts scroll.
          className={cn(
            'h-[calc(2lh+1rem)] min-h-[calc(2lh+1rem)] resize-none border-0 bg-transparent shadow-none focus-visible:outline-none',
            touch ? 'leading-6' : 'leading-5',
          )}
          readOnly={dictation.listening}
          placeholder={
            dictation.listening
              ? 'Listening…'
              : turnRunning
                ? 'Queue a follow-up'
                : comment
                  ? 'Ask about this comment, @ to mention, / for commands'
                  : 'Ask about this board, @ to mention, / for commands'
          }
          value={draft}
          onChange={onDraft}
          onKeyDown={onKeyDown}
          candidates={candidates}
          mentions={mentions}
          onMention={onMention}
          commands={commands}
          onCommand={onCommand}
          onPaste={(event) => {
            if (addFiles(event.clipboardData?.files)) event.preventDefault()
          }}
          aria-label="Message the agent"
          data-sw-chat-input="true"
        />
        <div
          ref={actionsRef}
          className={cn('mt-2 flex h-11 items-center', touch ? 'gap-2' : 'gap-1')}
          data-sw-chat-actions="true"
          data-sw-chat-layout={layout}
        >
          <input
            ref={fileRef}
            type="file"
            accept={`${IMAGE_ACCEPT},${TEXT_ACCEPT}`}
            multiple
            className="hidden"
            data-sw-chat-file="true"
            onChange={(event) => {
              addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <input
            ref={textRef}
            type="file"
            accept={TEXT_ACCEPT}
            multiple
            className="hidden"
            data-sw-chat-text-file="true"
            onChange={(event) => {
              addFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <DropdownMenu>
            <Tooltip content={vision ? 'Attach an image or a text file' : 'Attach a text file (this model does not take images)'}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={iconSize}
                  aria-label="Attach"
                  disabled={selectingProfile || attachFull}
                  data-sw-chat-attach="true"
                >
                  <Paperclip size={16} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="start" className="max-h-80 w-64">
              <DropdownMenuItem
                onSelect={() => fileRef.current?.click()}
                disabled={!vision || attachments.length >= ATTACH_MAX}
                data-sw-chat-upload="true"
              >
                <Upload size={14} aria-hidden="true" /> Upload an image
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => textRef.current?.click()}
                disabled={files.length >= TEXT_FILES_MAX}
                data-sw-chat-upload-text="true"
              >
                <FileText size={14} aria-hidden="true" /> Attach a text file
              </DropdownMenuItem>
              {vision && comment && captureFor(comment.pageId, comment.viewport) ? (
                <DropdownMenuItem onSelect={() => attachElement(comment)} data-sw-chat-attach-element={comment.id}>
                  <Crosshair size={14} aria-hidden="true" /> The element of comment #{comment.id}
                </DropdownMenuItem>
              ) : null}
              {vision && focusedPage && captureFor(focusedPage.id, focused.viewport) ? (
                <DropdownMenuItem onSelect={() => attachPage(focusedPage, focused.viewport)} data-sw-chat-attach-focused="true">
                  <MonitorSmartphone size={14} aria-hidden="true" /> <span className="truncate">This page: {focusedPage.title}</span>
                </DropdownMenuItem>
              ) : null}
              {vision && pageItems.length ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Page screenshot · {viewport}</DropdownMenuLabel>
                  {pageItems.map((page) => (
                    <DropdownMenuItem key={page.id} onSelect={() => attachPage(page, viewport)} data-sw-chat-attach-page={page.id}>
                      <FileImage size={14} aria-hidden="true" /> <span className="truncate">{page.title}</span>
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {dictation.listening ? (
            <span
              className="flex min-w-0 flex-1 items-center gap-2 text-xs text-accent"
              role="status"
              data-sw-chat-listening={dictation.phase}
            >
              <span className={cn('sw-listening-bars', dictation.phase !== 'listening' && 'sw-voice-still')} aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              {dictation.phase === 'starting' ? 'Starting…' : dictation.phase === 'stopping' ? 'Finishing…' : 'Listening'}
            </span>
          ) : (
            // The agent's options (model, thinking, more), and usage, between attach and the mic.
            <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" data-sw-chat-footer="true">
              <AgentOptions
                options={options}
                loading={optionsLoading}
                layout={layout}
                onChoose={onChooseOption}
                disabled={running}
                touch={touch}
              />
              <UsageRing usage={usage} touch={touch} ringOnly={usageFit === 'ring'} />
            </span>
          )}
          {turnRunning && hasContent && !dictation.listening ? (
            <IconButton
              type="submit"
              size="icon"
              className={cn(iconSize, 'rounded-full')}
              variant="secondary"
              label="Queue message"
              tooltip="Queue: sends when the answer finishes"
              data-sw-chat-queue-send="true"
            >
              <ListPlus size={16} aria-hidden="true" />
            </IconButton>
          ) : (
            <IconButton
              size="icon"
              // The same circle in every state, so nothing in the footer
              // moves: a mic, or while listening a red stop square.
              className={cn(
                iconSize,
                'rounded-full',
                dictation.listening && 'border-bad/25 bg-bad/5 text-bad shadow-none hover:bg-bad/10 hover:text-bad',
                dictation.listening && !touch && 'border-transparent bg-bad/10',
              )}
              variant={dictation.listening ? 'secondary' : 'ghost'}
              label={dictation.listening ? 'Stop listening' : 'Speak your message'}
              disabled={running || dictation.phase === 'stopping'}
              aria-pressed={dictation.listening}
              onClick={onMic}
              data-sw-chat-mic="true"
            >
              {dictation.listening ? (
                <Square size={13} className="fill-current" aria-hidden="true" />
              ) : (
                <Mic size={16} aria-hidden="true" />
              )}
            </IconButton>
          )}
          {turnRunning ? (
            <IconButton
              type="button"
              size="icon"
              className={cn(iconSize, 'rounded-full')}
              variant="default"
              label="Stop response"
              onClick={onStop}
              data-sw-chat-stop="true"
            >
              <Square size={15} aria-hidden="true" />
            </IconButton>
          ) : (
            <Button
              type="submit"
              size="icon"
              variant="default"
              className={cn(iconSize, 'rounded-full')}
              aria-label="Send message"
              disabled={selectingProfile || dictation.listening || !hasContent}
              data-sw-chat-send="true"
            >
              <ArrowUp size={18} aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      <span className="sr-only">Stop dictation to review or edit your message, then press Send.</span>
    </form>
  )
}
