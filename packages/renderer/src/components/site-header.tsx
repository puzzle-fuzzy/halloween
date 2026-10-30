import { useLocation } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { WindowControls } from "@/components/window-controls"

const titles: Record<string, string> = {
  "/": "Dashboard",
  "/cloud": "Cloud",
}

export function SiteHeader() {
  const { pathname } = useLocation()
  return (
    // drag regions live only on leaf elements (title text + flex spacer);
    // interactive elements must never be descendants of an app-region element
    <header className="flex h-(--header-height) shrink-0 items-stretch gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex min-w-0 flex-1 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <h1 className="text-base font-medium [-webkit-app-region:drag]">
          {titles[pathname] ?? "Halloween"}
        </h1>
        <div aria-hidden="true" className="min-w-4 flex-1 [-webkit-app-region:drag]" />
        <Button variant="ghost" asChild size="sm" className="hidden sm:flex">
          <a
            href="https://github.com/shadcn-ui/ui/tree/main/apps/v4/app/(examples)/dashboard"
            rel="noopener noreferrer"
            target="_blank"
            className="dark:text-foreground"
          >
            GitHub
          </a>
        </Button>
      </div>
      <WindowControls />
    </header>
  )
}
