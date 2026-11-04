import { Button } from "@halloween/ui/button"
import { Input } from "@halloween/ui/input"
import { Label } from "@halloween/ui/label"
import { IconUpload, IconX } from "@tabler/icons-react"
import * as React from "react"
import { useI18n } from "@/i18n"
import { adminApi, checkSession } from "@/lib/api"

interface Profile {
  name: string
  email: string
  avatar: string
}

const MAX_AVATAR_BYTES = 300 * 1024

export default function ProfilePage() {
  const { t } = useI18n()
  const [profile, setProfile] = React.useState<Profile | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [reading, setReading] = React.useState(false)
  const [message, setMessage] = React.useState("")
  const [loadError, setLoadError] = React.useState("")
  const [attempt, setAttempt] = React.useState(0)
  const fileInput = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    setLoadError("")
    void (async () => {
      try {
        if (!(await checkSession(controller.signal))) {
          if (!controller.signal.aborted) window.location.hash = "#/login"
          return
        }
        const res = await adminApi<{ profile: Profile }>("/profile", { signal: controller.signal })
        if (!controller.signal.aborted) setProfile(res.profile)
      } catch (e) {
        if (!controller.signal.aborted) setLoadError(String(e))
      }
    })()
    return () => controller.abort()
  }, [])

  if (profile === null) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 text-sm">
        {loadError ? (
          <>
            <p role="alert">{loadError}</p>
            <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          </>
        ) : (
          "Loading…"
        )}
      </div>
    )
  }

  const set = (patch: Partial<Profile>) =>
    setProfile((current) => (current ? { ...current, ...patch } : current))

  const pickAvatar = (file: File | undefined) => {
    if (!file || saving || reading) return
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setMessage("Choose a PNG, JPG or WebP image")
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setMessage(t.profile.avatarTooLarge)
      return
    }
    const reader = new FileReader()
    setReading(true)
    reader.onerror = () => {
      setMessage("Could not read the image")
      setReading(false)
    }
    reader.onload = () => {
      set({ avatar: String(reader.result) })
      setReading(false)
    }
    reader.readAsDataURL(file)
  }

  const save = async () => {
    if (saving || reading) return
    setSaving(true)
    setMessage("")
    try {
      const res = await adminApi<{ profile: Profile }>("/profile", {
        method: "POST",
        body: JSON.stringify(profile),
      })
      setProfile(res.profile)
      setMessage(t.profile.saved)
    } catch (e) {
      setMessage(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <p className="text-muted-foreground text-sm">{t.profile.description}</p>
      <fieldset disabled={saving || reading} className="max-w-xl space-y-6 rounded-lg border p-6">
        <div className="flex items-center gap-4">
          {profile.avatar ? (
            <img
              src={profile.avatar}
              alt="Avatar preview"
              className="size-16 shrink-0 rounded-lg border object-cover"
            />
          ) : (
            <div className="bg-muted text-muted-foreground flex size-16 shrink-0 items-center justify-center rounded-lg border text-xl font-medium">
              {(profile.name || "?").slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label className="sr-only">{t.profile.avatar}</Label>
            <Input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ""
                pickAvatar(file)
              }}
            />
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <IconUpload />
                Upload image
              </Button>
              {profile.avatar && (
                <Button variant="ghost" size="sm" onClick={() => set({ avatar: "" })}>
                  <IconX />
                  {t.profile.remove}
                </Button>
              )}
            </div>
            <p className="text-muted-foreground text-xs">{t.profile.avatarHint}</p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="name">{t.profile.nickname}</Label>
          <Input
            id="name"
            placeholder={t.profile.nickname}
            value={profile.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">{t.profile.email}</Label>
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
          <Button size="sm" disabled={saving || reading} onClick={() => void save()}>
            <IconUpload />
            {saving ? t.common.saving : t.common.save}
          </Button>
        </div>
      </fieldset>
    </div>
  )
}
