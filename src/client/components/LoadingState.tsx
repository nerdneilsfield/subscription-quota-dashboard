export function LoadingState() {
  return (
    <div data-skeleton className="dashboard-loading" role="status" aria-label="Loading dashboard">
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
