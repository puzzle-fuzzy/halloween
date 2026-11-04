import { Separator } from "@halloween/ui/separator"
import { SidebarTrigger } from "@halloween/ui/sidebar"
import { useLocation } from "react-router-dom"

import { useI18n } from "@/i18n"

export function SiteHeader() {
  const { pathname } = useLocation()
  const { t } = useI18n()
  const titles: Record<string, string> = {
    "/": t.nav.overview,
    "/tokens": t.nav.devices,
    "/oss-accounts": t.nav.ossAccounts,
    "/rss": t.nav.rss,
  }
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="text-base font-medium">{titles[pathname] ?? t.login.title}</h1>
      </div>
    </header>
  )
}
