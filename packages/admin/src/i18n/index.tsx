import * as React from "react"

import { en } from "./en"
import { zhCN } from "./zh-CN"

export type Lang = "en" | "zh-CN"
export type Dict = typeof en

const STORAGE_KEY = "halloween-admin:lang"
const dictionaries: Record<Lang, Dict> = { en, "zh-CN": zhCN }

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === "en" || saved === "zh-CN") return saved
  } catch {
    /* fall through to detection */
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en"
}

interface I18nValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: Dict
}

const I18nContext = React.createContext<I18nValue>({ lang: "en", setLang: () => {}, t: en })

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>(detect)

  const setLang = React.useCallback((next: Lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* best effort */
    }
    document.documentElement.lang = next
    setLangState(next)
  }, [])

  React.useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const value = React.useMemo(() => ({ lang, setLang, t: dictionaries[lang] }), [lang, setLang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return React.useContext(I18nContext)
}

/** always-visible switcher — the login and device-approval pages live outside the shell */
export function LangSwitch() {
  const { lang, setLang, t } = useI18n()
  return (
    <div className="fixed top-3 right-4 z-50 flex overflow-hidden rounded-md border bg-background text-xs shadow-xs">
      <button
        type="button"
        className={`px-2 py-1 transition-colors ${lang === "en" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        onClick={() => setLang("en")}
      >
        {t.lang.english}
      </button>
      <button
        type="button"
        className={`px-2 py-1 transition-colors ${lang === "zh-CN" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
        onClick={() => setLang("zh-CN")}
      >
        {t.lang.chinese}
      </button>
    </div>
  )
}
