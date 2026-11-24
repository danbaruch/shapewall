// Account: your name and photo.

import { useState } from 'react'
import { UserRound } from 'lucide-react'
import { Button, Input, Spinner } from '../../../components/ui'
import { Card, CardHeader, Field, FormError } from '../../components'
import { api } from '../../lib/api'
import { useAction, useSession, useToast } from '../../state'
import { ProfilePhoto } from '../../../components/profile-photo'

export function Profile() {
  const { me, refresh } = useSession()
  const toast = useToast()
  const [name, setName] = useState(me.user.displayName)
  const { run, busy, error } = useAction()
  const save = (event) => {
    event.preventDefault()
    run(async () => {
      await api.patch('/auth/me', { displayName: name })
      // The server tidies the name (trims it): show what it kept.
      const fresh = await refresh()
      if (fresh) setName(fresh.user.displayName)
      toast('Name saved')
    })
  }
  return (
    <Card id="account-profile" className="scroll-mt-20">
      <CardHeader icon={UserRound} title="Profile" description="Your name signs your comments; people @mention your handle." />
      <ProfilePhoto name={me.user.displayName} avatarUrl={me.user.avatarUrl} transport={api} onSaved={refresh} />
      <form onSubmit={save} className="px-4 py-4 sm:px-5">
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Shown on your comments and in mentions.">
            {(props) => (
              <Input
                {...props}
                size="touch"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={60}
                data-sw-profile-name
              />
            )}
          </Field>
          <Field label="Handle" hint="Handles do not change.">
            {(props) => <Input {...props} size="touch" value={`@${me.user.handle}`} readOnly disabled />}
          </Field>
        </div>
        <FormError error={error} />
        {/* Save appears with a change, under the fields. */}
        {name !== me.user.displayName ? (
          <div className="mt-4 flex animate-rise-in justify-end gap-2" data-sw-profile-actions>
            <Button size="touch" variant="ghost" className="lg:h-9" disabled={busy} onClick={() => setName(me.user.displayName)}>
              Cancel
            </Button>
            <Button type="submit" size="touch" variant="default" className="lg:h-9" disabled={busy || !name.trim()}>
              {busy ? <Spinner /> : null} Save
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  )
}
