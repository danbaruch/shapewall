// A board page the signed-in account cannot open: removed from the
// workspace, never in it, or the project is gone. The server answers 404
// and this page; it says so and offers the two ways on.

import { useEffect } from 'react'
import { ArrowLeft, Lock, LogOut } from 'lucide-react'
import { Button } from '../../components/ui'
import { Card } from '../components'
import { api } from '../lib/api'
import { currentPath, leaveTo, navigate } from '../lib/router'
import { useSession } from '../state'
import { AuthLayout } from '../shell'

export function NoBoardAccess() {
  const { me } = useSession()
  useEffect(() => {
    document.title = 'No access · Shapewall'
  }, [])
  const signInAsSomeoneElse = async () => {
    const next = encodeURIComponent(currentPath())
    try {
      await api.post('/auth/logout', {})
    } finally {
      leaveTo(`/signin?next=${next}`)
    }
  }
  return (
    <AuthLayout>
      <Card className="p-6 text-center sm:p-8" data-sw-no-access>
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Lock size={20} aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-xl font-semibold text-fg">You don&apos;t have access to this board</h1>
        <p className="mt-2 text-sm text-muted">
          {me ? `You are signed in as @${me.user.handle}. ` : ''}
          The board may have moved, or you are no longer a member of its workspace. Ask a workspace admin to invite you again.
        </p>
        <div className="mt-6 space-y-2">
          <Button size="touch" variant="default" className="w-full" onClick={() => navigate('/')} data-sw-no-access-home>
            <ArrowLeft size={16} aria-hidden="true" /> Back to your workspaces
          </Button>
          {me ? (
            <Button size="touch" variant="secondary" className="w-full" onClick={signInAsSomeoneElse} data-sw-no-access-switch>
              <LogOut size={16} aria-hidden="true" /> Sign in as someone else
            </Button>
          ) : null}
        </div>
      </Card>
    </AuthLayout>
  )
}
