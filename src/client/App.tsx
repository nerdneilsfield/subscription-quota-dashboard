import { BrowserRouter, Routes, Route, useSearchParams, useParams } from "react-router-dom"
import type { RangeKey } from "../shared/domain"
import { AuthGate } from "./components/AuthGate"
import { LanguageSwitch } from "./components/LanguageSwitch"
import { I18nProvider, useI18n } from "./i18n"

const RANGE_KEYS: RangeKey[] = ["1h", "24h", "7d", "30d"]

function NotFound() {
  const { t } = useI18n()
  return (
    <div className="not-found">
      <div className="not-found__controls"><LanguageSwitch /></div>
      <h1>{t("notFoundTitle")}</h1>
      <p>{t("notFoundDescription")}</p>
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
      key={profileId}
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
    <I18nProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </I18nProvider>
  )
}
