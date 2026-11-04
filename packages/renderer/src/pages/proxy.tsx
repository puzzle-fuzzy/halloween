import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import prettyBytes from "pretty-bytes"
import {
  IconArrowDown,
  IconArrowUp,
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
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatSpeed, formatTime } from "@/lib/format"
import type { ProxyNodes, ProxyState } from "@/types/global"

const TRAFFIC_WINDOW = 60 // seconds kept on the chart

const chartConfig = {
  down: { label: "Download", color: "var(--chart-1)" },
  up: { label: "Upload", color: "var(--chart-2)" },
} satisfies ChartConfig

export default function ProxyPage() {
  const proxy = window.electron?.proxy
  const isWindows = window.electron?.platform === "win32"
  const [state, setState] = React.useState<ProxyState | null>(null)
  const [nodes, setNodes] = React.useState<ProxyNodes | null>(null)
  const [samples, setSamples] = React.useState<
    { t: number; up: number; down: number; upTotal: number; downTotal: number }[]
  >([])
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

  React.useEffect(() => {
    if (!proxy || !state?.running) return
    setSamples([])
    return proxy.onTraffic((s) => {
      setSamples((prev) => [
        ...prev.slice(-(TRAFFIC_WINDOW - 1)),
        { t: s.ts, up: s.up, down: s.down, upTotal: s.upTotal, downTotal: s.downTotal },
      ])
    })
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

  if (!isWindows) {
    return (
      <div className="flex flex-1 items-center justify-center px-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconShieldLock className="size-5" />
              Proxy is Windows-only for now
            </CardTitle>
            <CardDescription>
              The proxy core (mihomo), system-proxy integration and TUN mode rely on
              Windows machinery. macOS support may come later — subscriptions and
              settings you configure on Windows will be there when it does.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  if (!proxy || state === null) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        Loading…
      </div>
    )
  }

  const tun = state.mode === "tun"
  const active = tun ? state.running : state.running && state.sysProxy
  const last = samples[samples.length - 1]
  const currentNode = nodes?.current

  return (
    <div className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={active}
            disabled={state.busy || (tun && !state.tunReady)}
            onCheckedChange={(v) => void toggle(v)}
            aria-label="Toggle proxy"
          />
          <span className="text-sm font-medium">{active ? "On" : "Off"}</span>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={state.mode}
          onValueChange={(v) => v && void setMode(v as "sys" | "tun")}
          disabled={state.busy}
        >
          <ToggleGroupItem value="sys">System Proxy</ToggleGroupItem>
          <ToggleGroupItem value="tun">TUN Adapter</ToggleGroupItem>
        </ToggleGroup>
        {state.busy && <IconLoader2 className="text-muted-foreground size-4 animate-spin" />}
        {state.lastError && (
          <p className="text-destructive min-w-0 flex-1 truncate text-xs" title={state.lastError}>
            {state.lastError.split("\n")[0]}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void testAll()}
          disabled={!state.running || testing}
        >
          <IconBolt className={testing ? "animate-pulse" : ""} />
          {testing ? "Testing…" : "Test Latency"}
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
            {installing ? "Installing…" : "Install Service"}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>Status</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {state.running ? "Running" : "Stopped"}
            </CardTitle>
            <CardAction>
              <Badge variant={state.running ? "secondary" : "outline"}>
                <IconCircleCheck className="size-3" />
                {tun ? "tun" : "system proxy"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="text-muted-foreground text-sm">
            {state.running
              ? `${tun ? "virtual adapter" : `127.0.0.1:${state.mixedPort}`} · ${state.nodeCount} nodes`
              : "Turn on to route traffic"}
          </CardFooter>
        </Card>
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>Current Node</CardDescription>
            <CardTitle className="truncate text-2xl font-semibold tabular-nums">
              {currentNode || "—"}
            </CardTitle>
            <CardAction>
              <Badge variant="outline">
                {tun && !state.tunReady ? "install required" : active ? "active" : "idle"}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="text-muted-foreground text-sm">
            {state.running ? "Click a node below to switch" : "Nodes listed below"}
          </CardFooter>
        </Card>
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>Download</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {formatSpeed(last?.down ?? 0)}
            </CardTitle>
            <CardAction>
              <Badge variant="outline">
                <IconArrowDown className="size-3" />
                live
              </Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="text-muted-foreground text-sm">
            Session {prettyBytes(last?.downTotal ?? 0)}
          </CardFooter>
        </Card>
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>Upload</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {formatSpeed(last?.up ?? 0)}
            </CardTitle>
            <CardAction>
              <Badge variant="outline">
                <IconArrowUp className="size-3" />
                live
              </Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="text-muted-foreground text-sm">
            Session {prettyBytes(last?.upTotal ?? 0)}
          </CardFooter>
        </Card>
      </div>

      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Traffic</CardTitle>
          <CardDescription className="text-xs">
            {state.running ? `Last ${TRAFFIC_WINDOW}s · upload / download` : "Start the proxy to see live traffic"}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-2 sm:px-4">
          <ChartContainer config={chartConfig} className="aspect-auto h-[160px] w-full">
            <AreaChart data={samples}>
              <defs>
                <linearGradient id="fillDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-down)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-down)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-up)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-up)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="t"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={40}
                tickFormatter={(v) =>
                  new Date(v).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" })
                }
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => prettyBytes(v)}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    indicator="line"
                    labelFormatter={(value) =>
                      new Date(Number(value)).toLocaleTimeString([], { hour12: false })
                    }
                    formatter={(value, name) => (
                      <div className="flex w-full items-center gap-3">
                        <span className="text-muted-foreground">{String(name)}</span>
                        <span className="ml-auto font-mono font-medium">
                          {formatSpeed(Number(value))}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Area dataKey="down" type="natural" fill="url(#fillDown)" stroke="var(--color-down)" strokeWidth={2} />
              <Area dataKey="up" type="natural" fill="url(#fillUp)" stroke="var(--color-up)" strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div className="grid min-h-0 flex-1 gap-4 @xl/main:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className="text-sm font-semibold">Subscriptions</span>
            <span className="text-muted-foreground text-xs">{state.subscriptions.length}</span>
          </div>
          <div className="flex gap-2 border-b p-3">
            <Input
              placeholder="https://…/subscribe?token=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add()
              }}
            />
            <Button size="sm" className="shrink-0" onClick={() => void add()} disabled={!url.trim() || adding}>
              <IconPlus />
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-scroll">
            {state.subscriptions.map((sub) => (
              <React.Fragment key={sub.id}>
                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{sub.name}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {sub.nodeCount} nodes · {sub.updatedAt ? formatTime(sub.updatedAt) : "—"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label="Update subscription"
                    disabled={updating === sub.id || state.busy}
                    onClick={() => void updateSub(sub.id)}
                  >
                    <IconRefresh className={`size-4 ${updating === sub.id ? "animate-spin" : ""}`} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive size-7 shrink-0"
                    aria-label="Delete subscription"
                    onClick={() => void removeSub(sub.id)}
                  >
                    <IconTrash className="size-4" />
                  </Button>
                </div>
                <Separator />
              </React.Fragment>
            ))}
            {state.subscriptions.length === 0 && (
              <p className="text-muted-foreground p-3 text-sm">
                No subscriptions yet — add your provider's clash URL
              </p>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className="text-sm font-semibold">Nodes</span>
            <span className="text-muted-foreground text-xs">
              {state.running
                ? `${nodes?.nodes.length ?? 0} nodes · click to switch`
                : state.cachedNodes.length > 0
                  ? `${state.cachedNodes.length} nodes · turn on to select`
                  : ""}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-scroll">
            {!state.running && state.cachedNodes.length > 0 ? (
              <div className="flex flex-col">
                {state.cachedNodes.map((name) => (
                  <React.Fragment key={name}>
                    <div className="text-muted-foreground flex w-full items-center gap-3 px-3 py-1.5 text-sm">
                      <span className="truncate">{name}</span>
                      <span className="ml-auto shrink-0 text-xs">—</span>
                    </div>
                    <Separator />
                  </React.Fragment>
                ))}
              </div>
            ) : !state.running ? (
              <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
                <IconCircleX className="size-4" />
                Core not running
              </div>
            ) : nodes === null ? (
              <div className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
                <IconLoader2 className="size-4 animate-spin" />
                Loading nodes…
              </div>
            ) : (
              <div className="flex flex-col">
                {nodes.nodes.map((node) => {
                  const isActive = node.name === nodes.current
                  return (
                    <React.Fragment key={node.name}>
                      <button
                        className="hover:bg-accent flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm"
                        onClick={() => void selectNode(node.name)}
                      >
                        <span
                          className={
                            isActive ? "text-primary truncate font-medium" : "truncate font-normal"
                          }
                        >
                          {node.name}
                        </span>
                        {isActive && (
                          <Badge variant="outline" className="ml-auto shrink-0">
                            active
                          </Badge>
                        )}
                        <span
                          className={`text-xs ${node.delay ? "" : "text-muted-foreground"} ${isActive ? "" : "ml-auto"} shrink-0`}
                        >
                          {node.delay ? `${node.delay} ms` : "—"}
                        </span>
                      </button>
                      <Separator />
                    </React.Fragment>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
