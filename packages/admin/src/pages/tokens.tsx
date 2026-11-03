import * as React from "react"
import { format } from "date-fns"
import { IconTrash } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { adminApi, checkSession } from "@/lib/api"

interface Device {
  id: string
  name: string
  createdAt: number
}

export default function TokensPage() {
  const [devices, setDevices] = React.useState<Device[] | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setError('')
      if (!(await checkSession())) {
        window.location.hash = '#/login'
        return
      }
      const res = await adminApi<{ devices: Device[] }>('/devices')
      setDevices(res.devices)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const revoke = async (device: Device) => {
    if (busy) return
    if (!window.confirm(`Revoke ${device.name}? The device will need to sign in again.`)) return
    setBusy(true)
    try {
      await adminApi('/devices/revoke', {
        method: 'POST',
        body: JSON.stringify({ id: device.id }),
      })
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex items-center">
        <p className="text-muted-foreground text-sm">
          Devices authorized through browser sign-in. Revoking signs the device out.
        </p>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <div className="flex-1 overflow-hidden rounded-lg border">
        {error ? <p role="alert" className="text-destructive p-4 text-sm">{error}</p> : devices === null ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Loading…
          </div>
        ) : devices.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            No authorized devices
          </div>
        ) : (
          <div className="h-full overflow-auto [scrollbar-gutter:stable]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">Name</TableHead>
                  <TableHead className="w-44">Authorized</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell className="pl-3 font-medium">{device.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(device.createdAt), 'MMM d, yyyy, HH:mm')}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        aria-label="Revoke"
                        disabled={busy}
                        onClick={() => void revoke(device)}
                      >
                        <IconTrash className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
