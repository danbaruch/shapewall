// "/": the workspaces you belong to, and a new one.

import { useEffect, useState } from 'react'
import { ArrowRight, Building2, Plus } from 'lucide-react'
import { Button, Dialog, EmptyState, Input, Spinner, initials } from '../../components/ui'
import { Card, Field, FormError, PageHeader, RoleBadge } from '../components'
import { TailnetInvites } from './tailnet'
import { api } from '../lib/api'
import { Link, currentHash, navigate, navigateSoon } from '../lib/router'
import { useAction, useSession } from '../state'

export function Home() {
  const { me, refresh } = useSession()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (currentHash() === '#new') {
      // Through the router: in the demo the route lives in the fragment.
      navigate('/', { replace: true })
      setOpen(true)
    }
  }, [])
  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Projects, people and their access live in a workspace."
        actions={
          <Button variant="default" size="touch" onClick={() => setOpen(true)} className="lg:h-9" data-sw-new-workspace>
            <Plus size={16} aria-hidden="true" /> New workspace
          </Button>
        }
      />
      <TailnetInvites />
      {me.workspaces.length ? (
        <div className="grid animate-fade-in gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {me.workspaces.map((item) => (
            <Link
              key={item.id}
              to={`/w/${item.id}`}
              className="group rounded-xl border border-line bg-surface p-4 shadow-card transition-[box-shadow,border-color,translate] duration-(--motion-fast) ease-standard outline-none hover:-translate-y-px hover:border-line-strong hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              data-sw-workspace-card={item.id}
            >
              <div className="flex items-start gap-3">
                <span
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-ui font-semibold text-accent"
                  aria-hidden="true"
                >
                  {initials(item.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-title font-semibold text-fg">{item.name}</p>
                  <div className="mt-1">
                    <RoleBadge role={item.role} />
                  </div>
                </div>
                <ArrowRight size={16} className="mt-1 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={Building2} title="You are not in a workspace yet">
            Make one, or ask a workspace admin for an invite link.
          </EmptyState>
        </Card>
      )}
      <NewWorkspace
        open={open}
        onClose={() => setOpen(false)}
        onCreated={async (id) => {
          await refresh()
          setOpen(false)
          navigateSoon(`/w/${id}`)
        }}
      />
    </>
  )
}

function NewWorkspace({ open, onClose, onCreated }) {
  const [name, setName] = useState('')
  const { run, busy, error, setError } = useAction()
  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
    }
  }, [open, setError])
  const create = (event) => {
    event.preventDefault()
    run(async () => {
      const result = await api.post('/api/workspaces', { name })
      await onCreated(result.workspace.id)
    })
  }
  return (
    <Dialog open={open} onClose={() => (busy ? null : onClose())} title="New workspace" description="You will be its owner.">
      <form onSubmit={create} className="space-y-4 px-5 py-4">
        <Field label="Name">
          {(props) => (
            <Input
              {...props}
              size="touch"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="Acme design team"
              data-sw-workspace-name
            />
          )}
        </Field>
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <Button size="touch" variant="ghost" onClick={onClose} disabled={busy} className="lg:h-10">
            Cancel
          </Button>
          <Button type="submit" size="touch" variant="default" disabled={busy || !name.trim()} className="lg:h-10">
            {busy ? <Spinner /> : null} Create workspace
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
