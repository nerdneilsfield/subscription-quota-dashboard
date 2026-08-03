import { expect, test } from "bun:test"
import { render, within } from "@testing-library/react"
import { ProviderLogo } from "../../src/client/components/ProviderLogo"

test.each([
  ["Cursor Pro", "0 0 512 512", "provider-logo--cursor"],
  ["OpenCode Go", "0 0 300 300", "provider-logo--opencode"],
])("renders cached brand mark for %s", (label, viewBox, className) => {
  const { container } = render(<ProviderLogo label={label} />)
  const logo = within(container).getByRole("img", { name: `${label} logo` })

  expect(logo.getAttribute("viewBox")).toBe(viewBox)
  expect(logo.closest("span")?.classList.contains(className)).toBe(true)
})

test("renders cached Xiaomi MiMo image for unsupported direct plan", () => {
  const { container } = render(<ProviderLogo label="Xiaomi MiMo Token Plan" />)
  const logo = within(container).getByRole("img", { name: "Xiaomi MiMo Token Plan logo" })

  expect(logo.tagName).toBe("IMG")
  expect(logo.closest("span")?.classList.contains("provider-logo--mimo")).toBe(true)
})

test.each(["Doubao Agent Plan", "Doubao Coding Plan", "Volcengine"])("renders cached Doubao image for %s", (label) => {
  const { container } = render(<ProviderLogo label={label} />)
  const logo = within(container).getByRole("img", { name: `${label} logo` })

  expect(logo.tagName).toBe("IMG")
  expect(logo.closest("span")?.classList.contains("provider-logo--doubao")).toBe(true)
})
