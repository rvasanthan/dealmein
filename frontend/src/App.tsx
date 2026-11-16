import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { RequireUser } from './components/RequireUser'
import DealsPage from './pages/DealsPage'
import FacetPage from './pages/FacetPage'
import SavedPage from './pages/SavedPage'
import DealDetailPage from './pages/DealDetailPage'
import UserLogin from './pages/UserLogin'
import { AdminLogin, AdminShell } from './pages/admin/AdminShell'
import AdminQueue, { AdminPreview } from './pages/admin/AdminQueue'
import AdminDeal from './pages/admin/AdminDeal'
import AdminMerge from './pages/admin/AdminMerge'
import AdminImports from './pages/admin/AdminImports'
import AdminAccounts from './pages/admin/AdminAccounts'
import AdminUsers from './pages/admin/AdminUsers'
import { AdminAudit, AdminReports, AdminStores } from './pages/admin/AdminMisc'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route element={<RequireUser />}>
          <Route path="/" element={<DealsPage />} />
          <Route path="/categories" element={<Navigate to="/" replace />} />
          <Route path="/stores" element={<FacetPage kind="stores" />} />
          <Route path="/saved" element={<SavedPage />} />
          <Route path="/deals/:id" element={<DealDetailPage />} />
        </Route>
        <Route path="/signin" element={<UserLogin />} />
        <Route path="/admin" element={<AdminLogin />} />
        <Route element={<AdminShell />}>
          <Route path="/admin/queue" element={<AdminQueue />} />
          <Route path="/admin/preview" element={<AdminPreview />} />
          <Route path="/admin/deals/:id" element={<AdminDeal />} />
          <Route path="/admin/merge" element={<AdminMerge />} />
          <Route path="/admin/imports" element={<AdminImports />} />
          <Route path="/admin/accounts" element={<AdminAccounts />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/reports" element={<AdminReports />} />
          <Route path="/admin/stores" element={<AdminStores />} />
          <Route path="/admin/audit" element={<AdminAudit />} />
        </Route>
      </Route>
    </Routes>
  )
}
