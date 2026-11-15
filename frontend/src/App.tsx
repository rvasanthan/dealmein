import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import DealsPage from './pages/DealsPage'
import FacetPage from './pages/FacetPage'
import SavedPage from './pages/SavedPage'
import DealDetailPage from './pages/DealDetailPage'
import { AdminLogin, AdminShell } from './pages/admin/AdminShell'
import AdminQueue, { AdminPreview } from './pages/admin/AdminQueue'
import AdminDeal from './pages/admin/AdminDeal'
import AdminMerge from './pages/admin/AdminMerge'
import AdminImports from './pages/admin/AdminImports'
import { AdminAudit, AdminReports, AdminStores } from './pages/admin/AdminMisc'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DealsPage />} />
        <Route path="/categories" element={<FacetPage kind="categories" />} />
        <Route path="/stores" element={<FacetPage kind="stores" />} />
        <Route path="/saved" element={<SavedPage />} />
        <Route path="/deals/:id" element={<DealDetailPage />} />
        <Route path="/admin" element={<AdminLogin />} />
        <Route element={<AdminShell />}>
          <Route path="/admin/queue" element={<AdminQueue />} />
          <Route path="/admin/preview" element={<AdminPreview />} />
          <Route path="/admin/deals/:id" element={<AdminDeal />} />
          <Route path="/admin/merge" element={<AdminMerge />} />
          <Route path="/admin/imports" element={<AdminImports />} />
          <Route path="/admin/reports" element={<AdminReports />} />
          <Route path="/admin/stores" element={<AdminStores />} />
          <Route path="/admin/audit" element={<AdminAudit />} />
        </Route>
      </Route>
    </Routes>
  )
}
