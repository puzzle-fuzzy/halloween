import { MemoryRouter, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"

import { AppSidebar } from "@/components/app-sidebar"
import { CloudSettingsProvider } from "@/components/cloud/settings"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import CloudDrivePage from "@/pages/cloud-drive"
import DashboardPage from "@/pages/dashboard"

export default function App() {
  return (
    <TooltipProvider>
      <CloudSettingsProvider>
        <MemoryRouter>
          <SidebarProvider
            style={
              {
                "--sidebar-width": "calc(var(--spacing) * 72)",
                "--header-height": "calc(var(--spacing) * 12)",
              } as React.CSSProperties
            }
          >
            <AppSidebar variant="inset" />
            <SidebarInset>
              <SiteHeader />
              <div className="flex flex-1 flex-col">
                <Routes>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/cloud" element={<CloudDrivePage />} />
                </Routes>
              </div>
            </SidebarInset>
          </SidebarProvider>
        </MemoryRouter>
        <Toaster position="bottom-right" />
      </CloudSettingsProvider>
    </TooltipProvider>
  )
}
