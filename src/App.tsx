import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './layout/Layout'
import OverviewPage from './pages/OverviewPage'
import StylesPage from './pages/StylesPage'
import SampleReviewPage from './pages/SampleReviewPage'
import HistoryPage from './pages/HistoryPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/styles" element={<StylesPage />} />
        <Route path="/review" element={<SampleReviewPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
