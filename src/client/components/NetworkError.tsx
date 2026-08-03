import { useI18n } from "../i18n"

interface NetworkErrorProps {
  message?: string
  onRetry?: () => void
  retryLabel?: string
}

export function NetworkError({ message, onRetry, retryLabel }: NetworkErrorProps) {
  const { t } = useI18n()
  return (
    <div className="dashboard-error" role="alert">
      <p>{message ?? t("somethingWentWrong")}</p>
      {onRetry && (
        <button type="button" className="btn-retry" onClick={onRetry}>
          {retryLabel ?? t("retry")}
        </button>
      )}
    </div>
  )
}
