import { useI18n } from "../i18n"

export function EmptyState() {
  const { t } = useI18n()
  return (
    <div className="dashboard-empty">
      <p>{t("noSubscriptions")}</p>
    </div>
  )
}
