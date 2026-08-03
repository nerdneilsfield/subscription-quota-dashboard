import { useI18n, type Locale } from "../i18n"

export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n()
  const options: Array<{ value: Locale; label: string }> = [
    { value: "en", label: "EN" },
    { value: "zh-CN", label: "中文" },
  ]

  return (
    <div className="language-switch" role="group" aria-label={t("language")}>
      <span className="language-switch__label">{t("language")}</span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`language-switch__btn${locale === option.value ? " is-active" : ""}`}
          aria-pressed={locale === option.value}
          onClick={() => setLocale(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
