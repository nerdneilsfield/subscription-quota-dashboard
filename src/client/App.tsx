import { BrowserRouter, Routes, Route, useSearchParams, useParams } from "react-router-dom"
import type { RangeKey } from "../shared/domain"
import { AuthGate } from "./components/AuthGate"

const RANGE_KEYS: RangeKey[] = ["1h", "24h", "7d", "30d"]

function NotFound() {
  return (
    <div className="not-found">
      <h1>Not found</h1>
      <p>The page you requested does not exist.</p>
    </div>
  )
}

function DashboardRoute() {
  const { profileId } = useParams()
  const [params, setParams] = useSearchParams()
  const rangeParam = params.get("range") ?? "24h"
  if (!profileId) return <NotFound />
  if (!RANGE_KEYS.includes(rangeParam as RangeKey)) return <NotFound />
  const range = rangeParam as RangeKey
  return (
    <AuthGate
      profileId={profileId}
      range={range}
      onRangeChange={(r) => setParams({ range: r })}
    />
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/d/:profileId" element={<DashboardRoute />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
