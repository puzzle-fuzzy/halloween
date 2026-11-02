import { MemoryRouter, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"

import { AppSidebar } from "@/components/app-sidebar"
import { CloudAuthProvider } from "@/components/cloud/auth"
import { ErrorBoundary } from "@/components/error-boundary"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import CloudDrivePage from "@/pages/cloud-drive"
import DashboardPage from "@/pages/dashboard"
import OssManagerPage from "@/pages/oss-manager"
import ProxyPage from "@/pages/proxy"
import RssPage from "@/pages/rss"

export default function App() {
  return (
    <ErrorBoundary>
    <TooltipProvider>
      <CloudAuthProvider>
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
                  <Route path="/oss" element={<OssManagerPage />} />
                  <Route path="/rss" element={<RssPage />} />
                  <Route path="/proxy" element={<ProxyPage />} />
                </Routes>
              </div>
            </SidebarInset>
          </SidebarProvider>
        </MemoryRouter>
        <Toaster position="bottom-right" />
      </CloudAuthProvider>
    </TooltipProvider>
    </ErrorBoundary>
  )
}
