export function buildMetricKey(providerAccountId: string, subscriptionId: string, metricId: string): string {
  return [encodeURIComponent(providerAccountId), encodeURIComponent(subscriptionId), encodeURIComponent(metricId)].join("/")
}

export function parseMetricKey(metricKey: string): {
  providerAccountId: string
  subscriptionId: string
  metricId: string
} {
  const [providerAccountId = "", subscriptionId = "", metricId = ""] = metricKey.split("/")
  return {
    providerAccountId: decodeURIComponent(providerAccountId),
    subscriptionId: decodeURIComponent(subscriptionId),
    metricId: decodeURIComponent(metricId),
  }
}
