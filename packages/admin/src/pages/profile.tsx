import * as React from "react"
import { IconUpload, IconX } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { adminApi, checkSession } from "@/lib/api"

interface Profile {
  name: string
  email: string
  avatar: string
}

const MAX_AVATAR_BYTES = 300 * 1024

export default function ProfilePage() {
  const [profile, setProfile] = React.useState<Profile | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    void (async () => {
      if (!(await checkSession())) {
        window.location.hash = '#/login'
        return
      }
      try {
        const res = await adminApi<{ profile: Profile }>('/profile')
        setProfile(res.profile)
      } catch {
        setProfile({ name: '', email: '', avatar: '' })
      }
    })()
  }, [])

  if (profile === null) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        Loading…
      </div>
    )
  }

  const set = (patch: Partial<Profile>) => setProfile({ ...profile, ...patch })

  const pickAvatar = (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_AVATAR_BYTES) {
      setMessage('Avatar image must be under 300 KB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => set({ avatar: String(reader.result) })
    reader.readAsDataURL(file)
  }

  const save = async () => {
    setSaving(true)
    setMessage('')
    try {
      const res = await adminApi<{ profile: Profile }>('/profile', {
        method: 'POST',
        body: JSON.stringify(profile),
      })
      setProfile(res.profile)
      setMessage('Saved')
    } catch (e) {
      setMessage(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <p className="text-muted-foreground text-sm">
        Shown in the desktop app after it signs in.
      </p>
      <div className="max-w-xl space-y-6 rounded-lg border p-6">
        <div className="flex items-center gap-4">
          {profile.avatar ? (
            <img
              src={profile.avatar}
              alt="Avatar preview"
              className="size-16 shrink-0 rounded-lg border object-cover"
            />
          ) : (
            <div className="bg-muted text-muted-foreground flex size-16 shrink-0 items-center justify-center rounded-lg border text-xl font-medium">
              {(profile.name || '?').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label className="sr-only">Avatar</Label>
            <Input
              type="file"
              accept="image/*"
              className="w-64"
              onChange={(e) => pickAvatar(e.target.files?.[0])}
            />
            {profile.avatar && (
              <Button variant="ghost" size="sm" className="w-fit" onClick={() => set({ avatar: '' })}>
                <IconX />
                Remove
              </Button>
            )}
            <p className="text-muted-foreground text-xs">
              Image under 300 KB, or paste an https URL below.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="avatar-url">Avatar URL</Label>
          <Input
            id="avatar-url"
            placeholder="https://…"
            value={profile.avatar.startsWith('data:') ? '' : profile.avatar}
            onChange={(e) => set({ avatar: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="name">Nickname</Label>
          <Input
            id="name"
            placeholder="Nickname"
            value={profile.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={profile.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          {message && <p className="text-muted-foreground text-sm">{message}</p>}
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            <IconUpload />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
