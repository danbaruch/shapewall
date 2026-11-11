import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Send } from 'lucide-react'
import { PageHeader } from '../components/page.jsx'
import { Button, Container, cx } from '../components/ui.jsx'
import { GITHUB_URL } from '../routes.js'

// The contact form. It posts JSON to /api/contact on this origin (website/contact/server.mjs behind Caddy), which
// stores the message and notifies the owner. The limits below match the server's.
const KINDS = [
  { id: 'feedback', label: 'Feedback' },
  { id: 'feature', label: 'Feature request' },
  { id: 'bug', label: 'Bug' },
  { id: 'other', label: 'Other' },
]
const MESSAGE_MIN = 10
const MESSAGE_MAX = 4000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const FIELD_ORDER = ['message', 'email']

const ERRORS = {
  messageShort: `Please write at least ${MESSAGE_MIN} characters.`,
  messageLong: `Please keep it under ${MESSAGE_MAX.toLocaleString('en-US')} characters.`,
  email: 'That email address does not look right. Leave it empty if you do not need a reply.',
  tooFast: 'That was quick. Please wait a moment, then send it again.',
  rateLimited: 'You have sent several messages already. Please try again later.',
  failed: 'The message could not be sent. Check your connection and try again.',
}

function validate({ message, email }) {
  const errors = {}
  const text = message.trim()
  if (text.length < MESSAGE_MIN) errors.message = ERRORS.messageShort
  else if (text.length > MESSAGE_MAX) errors.message = ERRORS.messageLong
  if (email.trim() && !EMAIL_PATTERN.test(email.trim())) errors.email = ERRORS.email
  return errors
}

const fieldClass = (invalid) =>
  cx(
    'block w-full rounded-xl border bg-card px-3.5 py-2.5 text-[16px] leading-6 text-ink placeholder:text-faint',
    invalid ? 'border-danger' : 'border-line hover:border-line-strong',
  )

export default function Contact() {
  return (
    <>
      <PageHeader eyebrow="Contact" title="Contact us">
        Feedback, a feature you would like, or a question about Shapewall: send it here and it reaches the maintainer directly.
      </PageHeader>
      <Container className="py-14 sm:py-16">
        <div className="max-w-xl">
          <ContactForm />
          <p className="mt-8 border-t border-line pt-6 text-[14.5px] leading-6 text-slate">
            Prefer email? Write to{' '}
            <a href="mailto:hello@shapewall.com" className="font-semibold text-wall hover:text-wall-deep">
              hello@shapewall.com
            </a>
            . Found a bug you can reproduce? Open an issue on{' '}
            <a href={`${GITHUB_URL}/issues`} className="font-semibold text-wall hover:text-wall-deep">
              GitHub
            </a>
            . Security reports go through the{' '}
            <a href={`${GITHUB_URL}/blob/main/SECURITY.md`} className="font-semibold text-wall hover:text-wall-deep">
              security policy
            </a>
            , never this form. What the form keeps is in the{' '}
            <Link to="/privacy#contact-form" className="font-semibold text-wall hover:text-wall-deep">
              privacy policy
            </Link>
            .
          </p>
        </div>
      </Container>
    </>
  )
}

function ContactForm() {
  const [values, setValues] = useState({ kind: 'feedback', message: '', email: '', website: '' })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const startedAt = useRef(0)
  const fields = { message: useRef(null), email: useRef(null) }
  const thanks = useRef(null)

  // Set by script when the form appears: the server rejects a form sent within 3 seconds of this.
  useEffect(() => {
    startedAt.current = Date.now()
  }, [])
  useEffect(() => {
    if (sent) thanks.current?.focus()
  }, [sent])

  const set = (name) => (event) => {
    const value = event.target.value
    setValues((current) => ({ ...current, [name]: value }))
    if (errors[name]) setErrors((current) => ({ ...current, [name]: undefined }))
  }

  const showErrors = (next) => {
    setErrors(next)
    const first = FIELD_ORDER.find((name) => next[name])
    if (first) fields[first].current?.focus()
  }

  const submit = async (event) => {
    event.preventDefault()
    if (sending) return
    setFormError('')
    const found = validate(values)
    if (Object.keys(found).length) return showErrors(found)
    setSending(true)
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({
          kind: values.kind,
          message: values.message.trim(),
          email: values.email.trim(),
          website: values.website,
          startedAt: startedAt.current,
          submittedAt: Date.now(),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) return setSent(true)
      if (res.status === 429) return setFormError(ERRORS.rateLimited)
      if (data.error === 'too_fast') return setFormError(ERRORS.tooFast)
      if (data.field === 'message') return showErrors({ message: data.error === 'too_long' ? ERRORS.messageLong : ERRORS.messageShort })
      if (data.field === 'email') return showErrors({ email: ERRORS.email })
      setFormError(ERRORS.failed)
    } catch {
      setFormError(ERRORS.failed)
    } finally {
      setSending(false)
    }
  }

  if (sent)
    return (
      <div role="status" className="flex items-start gap-4 rounded-2xl border border-line bg-card p-6">
        <span
          className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-wall-wash text-wall"
          aria-hidden="true"
        >
          <Check className="size-5" />
        </span>
        <div className="min-w-0">
          {/* Focus moves here so a screen reader reads it; the heading is not a control, so it shows no focus ring. */}
          <h2 ref={thanks} tabIndex={-1} className="text-[20px] leading-7 font-bold tracking-[-0.01em] text-ink outline-none">
            Thanks, your message is on its way.
          </h2>
          <p className="mt-1 text-[15px] leading-6 text-slate">
            {values.email.trim() ? 'If it needs an answer, the reply will go to the email you gave.' : 'Every message is read.'}
          </p>
        </div>
      </div>
    )

  const length = values.message.trim().length
  const describe = (name, hint) => [hint, errors[name] && `${name}-error`].filter(Boolean).join(' ') || undefined

  return (
    // One rhythm for every group: label, 4 px, hint, 8 px, control, 8 px, error; 28 px between groups.
    <form noValidate onSubmit={submit} aria-label="Contact" className="space-y-7">
      <fieldset>
        <legend className="text-[15px] font-semibold text-ink">What is this about?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {KINDS.map((kind) => (
            <label
              key={kind.id}
              className={cx(
                'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3.5 text-[14.5px] font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-wall',
                values.kind === kind.id ? 'border-wall bg-wall-wash text-ink' : 'border-line bg-card text-slate hover:text-ink',
              )}
            >
              <input
                type="radio"
                name="kind"
                value={kind.id}
                checked={values.kind === kind.id}
                onChange={set('kind')}
                className="size-4 accent-wall focus-visible:outline-none"
              />
              {kind.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="contact-message" className="text-[15px] font-semibold text-ink">
          Message
        </label>
        {/* The hint and the running count share one line above the field, so nothing hangs under it and every
            group ends on its control. */}
        <div className="mt-1 flex items-baseline justify-between gap-4">
          <p id="message-hint" className="text-[13.5px] leading-5 text-slate">
            {MESSAGE_MIN} to {MESSAGE_MAX.toLocaleString('en-US')} characters.
          </p>
          <span
            className={cx('shrink-0 text-[13px] leading-5 tabular-nums', length > MESSAGE_MAX ? 'font-medium text-danger' : 'text-faint')}
            aria-hidden="true"
          >
            {length.toLocaleString('en-US')} / {MESSAGE_MAX.toLocaleString('en-US')}
          </span>
        </div>
        <textarea
          id="contact-message"
          ref={fields.message}
          name="message"
          rows={7}
          required
          value={values.message}
          onChange={set('message')}
          aria-invalid={errors.message ? 'true' : undefined}
          aria-describedby={describe('message', 'message-hint')}
          className={cx(fieldClass(errors.message), 'mt-2 resize-y')}
        />
        {errors.message ? (
          <p id="message-error" className="mt-2 text-[14px] leading-5 font-medium text-danger">
            {errors.message}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor="contact-email" className="text-[15px] font-semibold text-ink">
          Email <span className="font-normal text-slate">(optional)</span>
        </label>
        <p id="email-hint" className="mt-1 text-[13.5px] leading-5 text-slate">
          Only if you want a reply.
        </p>
        <input
          id="contact-email"
          ref={fields.email}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          value={values.email}
          onChange={set('email')}
          aria-invalid={errors.email ? 'true' : undefined}
          aria-describedby={describe('email', 'email-hint')}
          className={cx(fieldClass(errors.email), 'mt-2')}
        />
        {errors.email ? (
          <p id="email-error" className="mt-2 text-[14px] leading-5 font-medium text-danger">
            {errors.email}
          </p>
        ) : null}
      </div>

      {/* Hidden from people and assistive technology; bots that fill every field land here. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="contact-website">Website</label>
        <input
          id="contact-website"
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={set('website')}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <Button type="submit" size="lg" disabled={sending}>
          <Send className="size-4" aria-hidden="true" />
          {sending ? 'Sending...' : 'Send'}
        </Button>
        <p role="alert" className="text-[14.5px] font-medium text-danger">
          {formError}
        </p>
      </div>
      <noscript>
        <p className="text-[14.5px] text-slate">The form needs JavaScript. You can also open an issue on GitHub.</p>
      </noscript>
    </form>
  )
}
