import { useI18n } from "../i18n"

export function LoadingState() {
  const { t } = useI18n()
  return (
    <div data-skeleton className="dashboard-loading" role="status" aria-label={t("loadingDashboard")}>
      <div className="skeleton skeleton-header" />
      <div className="skeleton-row">
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
      <div className="skeleton-row">
        <div className="skeleton skeleton-sub" />
        <div className="skeleton skeleton-sub" />
      </div>
    </div>
  )
}
