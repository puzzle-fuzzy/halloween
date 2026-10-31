import * as React from "react"
import {
  IconCloud,
  IconDashboard,
  IconDatabase,
  IconHelp,
  IconInnerShadowTop,
  IconReport,
  IconSearch,
  IconSettings,
  IconFileWord,
  IconBucket,
} from "@tabler/icons-react"

import { NavDocuments } from "@/components/nav-documents"
import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
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
      title: "Dashboard",
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
  ],
  navSecondary: [
    {
      title: "Settings",
      url: "#",
      icon: IconSettings,
    },
    {
      title: "Get Help",
      url: "#",
      icon: IconHelp,
    },
    {
      title: "Search",
      url: "#",
      icon: IconSearch,
    },
  ],
  documents: [
    {
      name: "Data Library",
      url: "#",
      icon: IconDatabase,
    },
    {
      name: "Reports",
      url: "#",
      icon: IconReport,
    },
    {
      name: "Word Assistant",
      url: "#",
      icon: IconFileWord,
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
              <span className="text-base font-semibold">Acme Inc.</span>
            </>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavDocuments items={data.documents} />
        <NavSecondary className="mt-auto" items={data.navSecondary} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  )
}


