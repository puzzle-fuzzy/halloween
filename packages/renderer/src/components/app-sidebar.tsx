import * as React from "react"
import {
  IconCloud,
  IconDashboard,
  IconInnerShadowTop,
  IconBucket,
  IconTrash,
  IconRss,
  IconRocket,
  IconArchive,
} from "@tabler/icons-react"

import { useI18n } from "@/i18n"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@halloween/ui/sidebar"



export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useI18n()
  const data = {
    navMain: [
      { title: t.nav.overview, to: "/", icon: IconDashboard },
      { title: t.nav.cloud, to: "/cloud", icon: IconCloud },
      { title: t.nav.oss, to: "/oss", icon: IconBucket },
      { title: t.nav.rss, to: "/rss", icon: IconRss },
      { title: t.nav.proxy, to: "/proxy", icon: IconRocket },
      { title: t.nav.trash, to: "/trash", icon: IconTrash },
      { title: t.nav.backups, to: "/backups", icon: IconArchive },
    ],
  }
  // mac traffic lights overlay the top-left of this header row — keep clear
  const isMac = window.electron?.platform === "darwin"
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        {/* mac: the row stays as an empty drag strip under the traffic lights;
            windows/linux keep the brand logo + title */}
        <div className="flex h-8 w-full items-center gap-2 p-1.5 [-webkit-app-region:drag]">
          {!isMac && (
            <>
              <IconInnerShadowTop className="size-5" />
              <span className="text-base font-semibold">Halloween</span>
            </>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  )
}


