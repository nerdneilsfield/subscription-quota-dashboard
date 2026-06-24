interface NetworkErrorProps {
  message?: string
  onRetry?: () => void
  retryLabel?: string
}

export function NetworkError({ message = "Something went wrong.", onRetry, retryLabel = "Retry" }: NetworkErrorProps) {
  return (
    <div className="dashboard-error" role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn-retry" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  )
}
