import { Badge } from "@halloween/ui/badge"
import { Button } from "@halloween/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@halloween/ui/card"
import { Input } from "@halloween/ui/input"
import { Separator } from "@halloween/ui/separator"
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
import prettyBytes from "pretty-bytes"
import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { toast } from "sonner"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useI18n } from "@/i18n"
import { formatSpeed, formatTime } from "@/lib/format"
import type { ProxyNodes, ProxyState } from "@/types/global"

const TRAFFIC_WINDOW = 60 // seconds kept on the chart

const chartConfig = {
  down: { label: "Download", color: "var(--chart-1)" },
  up: { label: "Upload", color: "var(--chart-2)" },
} satisfies ChartConfig

export default function ProxyPage() {
  const { t } = useI18n()
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
    void proxy
      ?.nodes()
      .then(setNodes)
      .catch(() => setNodes(null))
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
    if (on && next.lastError)
      toast.error(t.proxy.proxyFailedTitle, { description: next.lastError.slice(0, 300) })
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
      toast.error(t.proxy.installFailedTitle, { description: String(e).slice(0, 300) })
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
      toast.success(t.proxy.subAdded)
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
              {t.proxy.windowsOnlyTitle}
            </CardTitle>
            <CardDescription>{t.proxy.windowsOnlyDesc}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  if (!proxy || state === null) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        {t.common.loading}
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
            aria-label={t.proxy.toggleAria}
          />
          <span className="text-sm font-medium">{active ? t.proxy.on : t.proxy.off}</span>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={state.mode}
          onValueChange={(v) => v && void setMode(v as "sys" | "tun")}
          disabled={state.busy}
        >
          <ToggleGroupItem value="sys">{t.proxy.systemProxy}</ToggleGroupItem>
          <ToggleGroupItem value="tun">{t.proxy.tunAdapter}</ToggleGroupItem>
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
          {testing ? t.proxy.testing : t.proxy.testLatency}
        </Button>
      </div>
      {tun && !state.tunReady && (
        <div className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <IconShieldLock className="text-muted-foreground size-4 shrink-0" />
          <span className="text-muted-foreground min-w-0 flex-1">{t.proxy.tunNeedsInstall}</span>
          <Button size="sm" onClick={() => void installTun()} disabled={installing}>
            <IconShieldLock />
            {installing ? t.proxy.installing : t.proxy.installService}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>{t.proxy.status}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {state.running ? t.proxy.running : t.proxy.stopped}
            </CardTitle>
            <CardAction>
              <Badge variant={state.running ? "secondary" : "outline"}>
                <IconCircleCheck className="size-3" />
                {tun ? t.proxy.tunBadge : t.proxy.sysBadge}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="text-muted-foreground text-sm">
            {state.running
              ? `${tun ? t.proxy.virtualAdapter : `127.0.0.1:${state.mixedPort}`} · ${t.proxy.nodesCount(state.nodeCount)}`
              : t.proxy.turnOnToRoute}
          </CardFooter>
        </Card>
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>{t.proxy.currentNode}</CardDescription>
            <CardTitle className="truncate text-2xl font-semibold tabular-nums">
              {currentNode || "—"}
            </CardTitle>
            <CardAction>
              <Badge variant="outline">
                {tun && !state.tunReady
                  ? t.proxy.installRequired
                  : active
                    ? t.proxy.activeBadge
                    : t.proxy.idleBadge}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="text-muted-foreground text-sm">
            {state.running ? t.proxy.clickToSwitch : t.proxy.nodesListed}
          </CardFooter>
        </Card>
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>{t.proxy.download}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {formatSpeed(last?.down ?? 0)}
            </CardTitle>
            <CardAction>
              <Badge variant="outline">
                <IconArrowDown className="size-3" />
                {t.proxy.live}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="text-muted-foreground text-sm">
            {t.proxy.session(prettyBytes(last?.downTotal ?? 0))}
          </CardFooter>
        </Card>
        <Card className="@container/card">
          <CardHeader>
            <CardDescription>{t.proxy.upload}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {formatSpeed(last?.up ?? 0)}
            </CardTitle>
            <CardAction>
              <Badge variant="outline">
                <IconArrowUp className="size-3" />
                {t.proxy.live}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardFooter className="text-muted-foreground text-sm">
            {t.proxy.session(prettyBytes(last?.upTotal ?? 0))}
          </CardFooter>
        </Card>
      </div>

      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">{t.proxy.traffic}</CardTitle>
          <CardDescription className="text-xs">
            {state.running ? t.proxy.lastWindow(TRAFFIC_WINDOW) : t.proxy.startToSeeTraffic}
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
                  new Date(v).toLocaleTimeString([], {
                    hour12: false,
                    minute: "2-digit",
                    second: "2-digit",
                  })
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
              <Area
                dataKey="down"
                type="natural"
                fill="url(#fillDown)"
                stroke="var(--color-down)"
                strokeWidth={2}
              />
              <Area
                dataKey="up"
                type="natural"
                fill="url(#fillUp)"
                stroke="var(--color-up)"
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <div className="grid min-h-0 flex-1 gap-4 @xl/main:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className="text-sm font-semibold">{t.proxy.subscriptions}</span>
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
            <Button
              size="sm"
              className="shrink-0"
              onClick={() => void add()}
              disabled={!url.trim() || adding}
            >
              <IconPlus />
              {adding ? t.proxy.adding : t.proxy.add}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-scroll">
            {state.subscriptions.map((sub) => (
              <React.Fragment key={sub.id}>
                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{sub.name}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {t.proxy.subNodes(sub.nodeCount)} ·{" "}
                      {sub.updatedAt ? formatTime(sub.updatedAt) : "—"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label={t.proxy.updateSubAria}
                    disabled={updating === sub.id || state.busy}
                    onClick={() => void updateSub(sub.id)}
                  >
                    <IconRefresh
                      className={`size-4 ${updating === sub.id ? "animate-spin" : ""}`}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive size-7 shrink-0"
                    aria-label={t.proxy.deleteSubAria}
                    onClick={() => void removeSub(sub.id)}
                  >
                    <IconTrash className="size-4" />
                  </Button>
                </div>
                <Separator />
              </React.Fragment>
            ))}
            {state.subscriptions.length === 0 && (
              <p className="text-muted-foreground p-3 text-sm">{t.proxy.noSubs}</p>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <span className="text-sm font-semibold">{t.proxy.nodes}</span>
            <span className="text-muted-foreground text-xs">
              {state.running
                ? t.proxy.nodesSwitchHint(nodes?.nodes.length ?? 0)
                : state.cachedNodes.length > 0
                  ? t.proxy.nodesSelectHint(state.cachedNodes.length)
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
                {t.proxy.coreNotRunning}
              </div>
            ) : nodes === null ? (
              <div className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
                <IconLoader2 className="size-4 animate-spin" />
                {t.proxy.loadingNodes}
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
                            {t.proxy.activeBadge}
                          </Badge>
                        )}
                        <span
                          className={`text-xs ${node.delay ? "" : "text-muted-foreground"} ${isActive ? "" : "ml-auto"} shrink-0`}
                        >
                          {node.delay ? t.proxy.msDelay(node.delay) : "—"}
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
