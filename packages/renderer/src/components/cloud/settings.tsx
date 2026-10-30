import * as React from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { CloudConfig } from "@/types/global"

interface CloudSettingsContextValue {
  config: CloudConfig
  configured: boolean
  open: () => void
  reload: () => Promise<void>
}

const CloudSettingsContext = React.createContext<CloudSettingsContextValue>({
  config: { serverUrl: "", token: "" },
  configured: false,
  open: () => {},
  reload: async () => {},
})

export function useCloudSettings() {
  return React.useContext(CloudSettingsContext)
}

export function CloudSettingsProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = React.useState<CloudConfig>({ serverUrl: "", token: "" })
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<CloudConfig>({ serverUrl: "", token: "" })
  const [testing, setTesting] = React.useState(false)

  const reload = React.useCallback(async () => {
    const loaded = (await window.electron?.cloud?.getConfig()) ?? { serverUrl: "", token: "" }
    setConfig(loaded)
  }, [])

  React.useEffect(() => {
    void reload()
  }, [reload])

  const openSettings = React.useCallback(() => {
    setDraft(config)
    setOpen(true)
  }, [config])

  const testConnection = async () => {
    const cloud = window.electron?.cloud
    if (!cloud || !draft.serverUrl || !draft.token) return
    setTesting(true)
    try {
      await cloud.setConfig(draft)
      await cloud.list("/")
      toast.success("Connected")
    } catch (error) {
      toast.error(`Connection failed: ${String(error)}`)
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    const cloud = window.electron?.cloud
    if (!cloud) return
    await cloud.setConfig(draft)
    await reload()
    setOpen(false)
    toast.success("Saved")
  }

  return (
    <CloudSettingsContext.Provider
      value={{ config, configured: Boolean(config.serverUrl && config.token), open: openSettings, reload }}
    >
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cloud Settings</DialogTitle>
            <DialogDescription>Server URL and access token</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cloud-server">Server URL</Label>
              <Input
                id="cloud-server"
                placeholder="https://halloween.yxswy.com/cloud"
                value={draft.serverUrl}
                onChange={(e) => setDraft({ ...draft, serverUrl: e.target.value.trim() })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cloud-token">Access Token</Label>
              <Input
                id="cloud-token"
                type="password"
                placeholder="TOKEN"
                value={draft.token}
                onChange={(e) => setDraft({ ...draft, token: e.target.value.trim() })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={testConnection} disabled={testing || !draft.serverUrl || !draft.token}>
              {testing ? "Testing…" : "Test Connection"}
            </Button>
            <Button onClick={save} disabled={!draft.serverUrl || !draft.token}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CloudSettingsContext.Provider>
  )
}
