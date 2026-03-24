import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout/Layout.tsx'
import DashboardPage from './pages/DashboardPage.tsx'
import CreateVaultPage from './pages/CreateVaultPage.tsx'
import VaultDetailPage from './pages/VaultDetailPage.tsx'

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/create" element={<CreateVaultPage />} />
        <Route path="/vault/:poolAddress" element={<VaultDetailPage />} />
      </Route>
    </Routes>
  )
}

export default App