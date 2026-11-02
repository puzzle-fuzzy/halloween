import { lazy, Suspense } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"

import { AppSidebar } from "@/components/app-sidebar"
import { CloudAuthProvider } from "@/components/cloud/auth"
import { TransferPanel } from "@/components/cloud/transfer-panel"
import { ErrorBoundary } from "@/components/error-boundary"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import DashboardPage from "@/pages/dashboard"

const CloudDrivePage = lazy(() => import("@/pages/cloud-drive"))
const OssManagerPage = lazy(() => import("@/pages/oss-manager"))
const TrashPage = lazy(() => import("@/pages/trash"))
const BackupsPage = lazy(() => import("@/pages/backups"))

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
                <Suspense fallback={<p className="text-muted-foreground p-6 text-sm">Loading…</p>}>
                <Routes>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/cloud" element={<CloudDrivePage />} />
                  <Route path="/oss" element={<OssManagerPage />} />
                  <Route path="/trash" element={<TrashPage />} />
                  <Route path="/backups" element={<BackupsPage />} />
                </Routes>
                </Suspense>
              </div>
            </SidebarInset>
          </SidebarProvider>
        </MemoryRouter>
        <TransferPanel />
        <Toaster position="bottom-right" />
      </CloudAuthProvider>
    </TooltipProvider>
    </ErrorBoundary>
  )
}
