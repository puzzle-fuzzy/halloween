import * as React from "react"
import {
  IconCloud,
  IconDashboard,
  IconInnerShadowTop,
  IconBucket,
  IconTrash,
  IconArchive,
} from "@tabler/icons-react"

import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"

const data = {
  navMain: [
    {
      title: "Overview",
      to: "/",
      icon: IconDashboard,
    },
    {
      title: "Cloud",
      to: "/cloud",
      icon: IconCloud,
    },
    {
      title: "OSS",
      to: "/oss",
      icon: IconBucket,
    },
    {
      title: "Trash",
      to: "/trash",
      icon: IconTrash,
    },
    {
      title: "Backups",
      to: "/backups",
      icon: IconArchive,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
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


