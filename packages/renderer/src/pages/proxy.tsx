import * as React from "react"
import {
  IconBolt,
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconShieldLock,
  IconTrash,
} from "@tabler/icons-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatTime } from "@/lib/format"
import type { ProxyNodes, ProxyState } from "@/types/global"

export default function ProxyPage() {
  const proxy = window.electron?.proxy
  const [state, setState] = React.useState<ProxyState | null>(null)
  const [nodes, setNodes] = React.useState<ProxyNodes | null>(null)
  const [url, setUrl] = React.useState("")
  const [adding, setAdding] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [updating, setUpdating] = React.useState("")
  const [installing, setInstalling] = React.useState(false)

  React.useEffect(() => {
    void proxy?.state().then(setState)
  }, [proxy])

  React.useEffect(() => {
    if (!state?.running) {
      setNodes(null)
      return
    }
    void proxy?.nodes().then(setNodes).catch(() => setNodes(null))
  }, [proxy, state?.running])

  const toggle = async (on: boolean) => {
    if (!proxy || state?.busy) return
    const next = on ? await proxy.enable() : await proxy.disable()
    setState(next)
    if (on && next.lastError) toast.error("Proxy failed to start", { description: next.lastError.slice(0, 300) })
  }

  const setMode = async (mode: "sys" | "tun") => {
    if (!proxy || state?.busy || mode === state?.mode) return
    setState(await proxy.setMode(mode))
  }

  const installTun = async () => {
    if (!proxy) return
    setInstalling(true)
    try {
      setState(await proxy.installTun())
      toast.success("TUN service installed")
    } catch (e) {
      toast.error("Install failed", { description: String(e).slice(0, 300) })
    } finally {
      setInstalling(false)
    }
  }

  const add = async () => {
    if (!proxy || !url.trim()) return
    setAdding(true)
    try {
      setState(await proxy.addSubscription(url.trim()))
      setUrl("")
      toast.success("Subscription added")
    } catch (e) {
      toast.error(String(e))
    } finally {
      setAdding(false)
    }
  }

  const removeSub = async (id: string) => {
    if (!proxy) return
    setState(await proxy.deleteSubscription(id))
  }

  const updateSub = async (id: string) => {
    if (!proxy) return
    setUpdating(id)
    try {
      setState(await proxy.updateSubscription(id))
      if (state?.running) setNodes(await proxy.nodes())
    } catch (e) {
      toast.error(String(e))
    } finally {
      setUpdating("")
    }
  }

  const selectNode = async (name: string) => {
    if (!proxy || name === nodes?.current) return
    try {
      setNodes(await proxy.select(name))
    } catch (e) {
      toast.error(String(e))
    }
  }

  const testAll = async () => {
    if (!proxy) return
    setTesting(true)
    try {
      setNodes(await proxy.testAll())
    } catch (e) {
      toast.error(String(e))
    } finally {
      setTesting(false)
    }
  }

  if (!proxy || state === null) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        Loading…
      </div>
    )
  }

  const active = state.mode === 'tun' ? state.running : state.running && state.sysProxy
  const tun = state.mode === 'tun'

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Proxy</CardTitle>
          <CardDescription className="text-xs">
            {active
              ? tun
                ? `All traffic routed through the virtual adapter via ${nodes?.current || "the selected node"}`
                : `Routing through ${nodes?.current || "the selected node"} on 127.0.0.1:${state.mixedPort}`
              : tun
                ? "Off — turn on to start the elevated core and take over routing"
                : "Off — turn on to start the core and set the system proxy"}
          </CardDescription>
          <CardAction className="flex items-center gap-3">
            {state.busy && <IconLoader2 className="text-muted-foreground size-4 animate-spin" />}
            <Switch
              checked={active}
              disabled={state.busy || (tun && !state.tunReady)}
              onCheckedChange={(v) => void toggle(v)}
              aria-label="Toggle proxy"
            />
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={state.mode}
              onValueChange={(v) => v && void setMode(v as 'sys' | 'tun')}
              disabled={state.busy}
            >
              <ToggleGroupItem value="sys">System Proxy</ToggleGroupItem>
              <ToggleGroupItem value="tun">TUN Adapter</ToggleGroupItem>
            </ToggleGroup>
            <Badge variant={state.running ? 'secondary' : 'outline'}>
              <IconCircleCheck className="size-3" />
              core {state.running ? (tun ? ' · tun' : ` :${state.mixedPort}`) : ' stopped'}
            </Badge>
            {!tun && (
              <Badge variant={active ? 'default' : 'outline'}>
                {active ? 'system proxy on' : 'system proxy off'}
              </Badge>
            )}
            <Badge variant="outline">{state.nodeCount} nodes</Badge>
            {state.lastError && (
              <p className="text-destructive min-w-0 flex-1 truncate text-xs" title={state.lastError}>
                {state.lastError.split('\n')[0]}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void testAll()}
              disabled={!state.running || testing}
            >
              <IconBolt className={testing ? 'animate-pulse' : ''} />
              {testing ? 'Testing…' : 'Test Latency'}
            </Button>
          </div>
          {tun && !state.tunReady && (
            <div className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <IconShieldLock className="text-muted-foreground size-4 shrink-0" />
              <span className="text-muted-foreground min-w-0 flex-1">
                TUN mode needs an elevated task (one UAC prompt, once per install)
              </span>
              <Button size="sm" onClick={() => void installTun()} disabled={installing}>
                <IconShieldLock />
                {installing ? 'Installing…' : 'Install Service'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Subscriptions</CardTitle>
          <CardDescription className="text-xs">
            Clash subscription URLs — fetched fresh on every start
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex gap-2">
            <Input
              placeholder="https://example.com/api/v1/client/subscribe?token=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add()
              }}
            />
            <Button size="sm" onClick={() => void add()} disabled={!url.trim() || adding}>
              <IconPlus />
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
          {state.subscriptions.map((sub) => (
            <div key={sub.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{sub.name}</span>
              <span className="text-muted-foreground shrink-0 text-xs">
                {sub.nodeCount} nodes · {sub.updatedAt ? formatTime(sub.updatedAt) : "—"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Update subscription"
                disabled={updating === sub.id || state.busy}
                onClick={() => void updateSub(sub.id)}
              >
                <IconRefresh className={`size-4 ${updating === sub.id ? "animate-spin" : ""}`} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:text-destructive size-7"
                aria-label="Delete subscription"
                onClick={() => void removeSub(sub.id)}
              >
                <IconTrash className="size-4" />
              </Button>
            </div>
          ))}
          {state.subscriptions.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No subscriptions yet — add your provider's clash URL to get started
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="min-h-0 flex-1 gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Nodes</CardTitle>
          <CardDescription className="text-xs">
            {state.running
              ? `${nodes?.nodes.length ?? 0} nodes · click to switch`
              : "Start the proxy to load the node list"}
          </CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-auto px-4 [scrollbar-gutter:stable]">
          {!state.running ? (
            <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
              <IconCircleX className="size-4" />
              Core not running
            </div>
          ) : nodes === null ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <IconLoader2 className="size-4 animate-spin" />
              Loading nodes…
            </div>
          ) : (
            <div className="flex flex-col">
              {nodes.nodes.map((node) => {
                const active = node.name === nodes.current
                return (
                  <React.Fragment key={node.name}>
                    <button
                      className="hover:bg-accent flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm"
                      onClick={() => void selectNode(node.name)}
                    >
                      <span
                        className={
                          active ? "text-primary truncate font-medium" : "truncate font-normal"
                        }
                      >
                        {node.name}
                      </span>
                      {active && (
                        <Badge variant="outline" className="ml-auto shrink-0">
                          active
                        </Badge>
                      )}
                      <span
                        className={`shrink-0 text-xs ${
                          node.delay ? "" : "text-muted-foreground"
                        } ${active ? "" : "ml-auto"}`}
                      >
                        {node.delay ? `${node.delay} ms` : "—"}
                      </span>
                    </button>
                    <Separator className="last:hidden" />
                  </React.Fragment>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
