import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './layout/Layout'
import OverviewPage from './pages/OverviewPage'
import StylesPage from './pages/StylesPage'
import SampleReviewPage from './pages/SampleReviewPage'
import HistoryPage from './pages/HistoryPage'
import BatchCenterPage from './pages/batches/BatchCenterPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/styles" element={<StylesPage />} />
        <Route path="/review" element={<SampleReviewPage />} />
        <Route path="/batches" element={<BatchCenterPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
