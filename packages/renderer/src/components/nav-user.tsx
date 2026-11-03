import * as React from "react"
import {
  IconBrandGithub,
  IconDotsVertical,
  IconLogout,
  IconMoon,
  IconDevices,
  IconSun,
  IconUserCircle,
} from "@tabler/icons-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { useCloudAuth } from "@/components/cloud/auth"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

const GITHUB_URL = "https://github.com/puzzle-fuzzy/halloween"

interface Profile {
  name: string
  email: string
  avatar: string
}

export function NavUser() {
  const { isMobile } = useSidebar()
  const { theme, setTheme } = useTheme()
  const cloudAuth = useCloudAuth()
  const [profile, setProfile] = React.useState<Profile | null>(null)

  React.useEffect(() => {
    let active = true
    if (!cloudAuth.authed) {
      setProfile(null)
      return
    }
    window.electron?.cloud
      ?.profile()
      .then((res) => { if (active) setProfile(res.profile) })
      .catch(() => { if (active) setProfile(null) })
    return () => { active = false }
  }, [cloudAuth.authed])

  const name = profile?.name || "Halloween"
  const email = profile?.email || "not configured"
  const fallback = name.slice(0, 1).toUpperCase()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage src={profile?.avatar} alt={name} />
                <AvatarFallback className="rounded-lg">{fallback}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {email}
                </span>
              </div>
              <IconDotsVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarImage src={profile?.avatar} alt={name} />
                  <AvatarFallback className="rounded-lg">{fallback}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {email}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void window.electron?.cloud?.openAdmin("profile").catch((e) => toast.error(String(e)))}>
                <IconUserCircle />
                Manage profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void window.electron?.cloud?.openAdmin("tokens").catch((e) => toast.error(String(e)))}>
                <IconDevices />
                Authorized devices
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">
                <IconSun />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <IconMoon />
                Dark
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => window.open(GITHUB_URL, "_blank")}>
              <IconBrandGithub />
              GitHub
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void cloudAuth.logout().then(() => toast.success("Signed out")).catch((e) => toast.error(String(e)))
              }}
              disabled={!cloudAuth.authed}
            >
              <IconLogout />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
