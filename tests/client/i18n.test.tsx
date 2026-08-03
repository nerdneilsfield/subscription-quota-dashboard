import { afterEach, expect, test } from "bun:test"
import { fireEvent, render, within } from "@testing-library/react"
import { I18nProvider, useI18n } from "../../src/client/i18n"
import { LanguageSwitch } from "../../src/client/components/LanguageSwitch"
import { formatRelativeTime } from "../../src/client/format"

function Probe() {
  const { locale, t } = useI18n()
  return <output data-locale={locale}>{t("noSubscriptions")}</output>
}

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.lang = ""
})

test("language switch changes translated copy and persists locale", () => {
  const { container } = render(
    <I18nProvider>
      <LanguageSwitch />
      <Probe />
    </I18nProvider>,
  )
  const view = within(container)

  expect(view.getByText("No subscriptions configured for this profile.")).toBeTruthy()
  fireEvent.click(view.getByRole("button", { name: "中文" }))

  expect(view.getByText("此配置档未配置订阅。")).toBeTruthy()
  expect(view.getByRole("button", { name: "中文" }).getAttribute("aria-pressed")).toBe("true")
  expect(document.documentElement.lang).toBe("zh-CN")
  expect(window.localStorage.getItem("sqd.locale")).toBe("zh-CN")
})

test("relative time supports Chinese copy", () => {
  const now = new Date("2026-06-25T12:00:00.000Z")
  expect(formatRelativeTime("2026-06-25T12:05:00.000Z", now, "zh-CN")).toBe("5 分钟后")
  expect(formatRelativeTime("2026-06-25T11:55:00.000Z", now, "zh-CN")).toBe("5 分钟前")
})
