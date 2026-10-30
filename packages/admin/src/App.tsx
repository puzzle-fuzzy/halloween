import { Navigate, Outlet, Route, Routes } from 'react-router-dom'

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import DevicePage from "@/pages/device"
import LoginPage from "@/pages/login"
import OssAccountsPage from "@/pages/oss-accounts"
import OverviewPage from "@/pages/overview"
import TokensPage from "@/pages/tokens"

function Shell() {
  return (
    <TooltipProvider>
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
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/device/:code" element={<DevicePage />} />
      <Route path="/" element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="tokens" element={<TokensPage />} />
        <Route path="oss-accounts" element={<OssAccountsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
