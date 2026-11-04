import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@halloween/ui/sidebar"
import {
  IconBucket,
  IconDevices,
  IconGauge,
  IconLogout,
  IconRss,
  IconShieldHalf,
  IconUserCircle,
} from "@tabler/icons-react"
import { Link, useLocation } from "react-router-dom"
import { useI18n } from "@/i18n"
import { adminApi } from "@/lib/api"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const location = useLocation()
  const { t } = useI18n()
  const nav = [
    { title: t.nav.overview, to: "/", icon: IconGauge },
    { title: t.nav.devices, to: "/tokens", icon: IconDevices },
    { title: t.nav.ossAccounts, to: "/oss-accounts", icon: IconBucket },
    { title: t.nav.rss, to: "/rss", icon: IconRss },
    { title: t.nav.profile, to: "/profile", icon: IconUserCircle },
  ]

  const logout = async () => {
    try {
      await adminApi("/logout", { method: "POST" })
    } finally {
      window.location.hash = "#/login"
    }
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <div className="flex h-8 w-full items-center gap-2 p-1.5">
          <IconShieldHalf className="size-5" />
          <span className="text-base font-semibold">Halloween Admin</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent className="flex flex-col gap-2">
            <SidebarMenu>
              {nav.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={location.pathname === item.to}
                    tooltip={item.title}
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={t.nav.logOut} onClick={() => void logout()}>
              <IconLogout />
              <span>{t.nav.logOut}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
