import { useLocation } from "react-router-dom"

import { useI18n } from "@/i18n"

import { Separator } from "@halloween/ui/separator"
import { SidebarTrigger, useSidebar } from "@halloween/ui/sidebar"
import { WindowControls } from "@/components/window-controls"
import { cn } from "@/lib/utils"

export function SiteHeader() {
  const { pathname } = useLocation()
  const { t } = useI18n()
  const titles: Record<string, string> = {
    "/": t.nav.overview,
    "/cloud": t.nav.cloud,
    "/oss": t.nav.oss,
    "/rss": t.nav.rss,
    "/proxy": t.nav.proxy,
    "/trash": t.nav.trash,
    "/backups": t.nav.backups,
  }
  const { state } = useSidebar()
  // sidebar collapsed = this header sits at the window's top-left,
  // where the mac traffic lights live
  const macInset =
    window.electron?.platform === "darwin" && state === "collapsed" ? "pl-20" : ""
  return (
    // drag regions live only on leaf elements (title text + flex spacer);
    // interactive elements must never be descendants of an app-region element
    <header className="flex h-(--header-height) shrink-0 items-stretch gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 px-4 lg:gap-2 lg:px-6",
          macInset
        )}
      >
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <h1 className="text-base font-medium [-webkit-app-region:drag]">
          {titles[pathname] ?? "Halloween"}
        </h1>
        <div aria-hidden="true" className="min-w-4 flex-1 [-webkit-app-region:drag]" />
      </div>
      <WindowControls />
    </header>
  )
}
