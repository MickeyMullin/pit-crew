// public/theme.ts
// the header's theme toggle: System, Light or Dark, kept per browser in localStorage. Every color
// is a light-dark() token, so a theme is only the root's color-scheme. The inline script at the
// top of each page applies the stored theme before first paint, with this file's key and values
// (test/ui-theme.test.ts runs it against these functions)

export type Theme = 'system' | 'light' | 'dark'

export const themeKey = 'pit-view.theme'

// one click moves one step along System → Light → Dark → System
export const nextTheme = (theme: Theme): Theme => theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'

export const colorSchemeOf = (theme: Theme): string => theme === 'system' ? 'light dark' : theme

const names: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }

// the toggle's accessible name and tooltip: the current state, then what a click does
export const themeLabel = (theme: Theme): string => `Theme: ${names[theme]}. Switch to ${names[nextTheme(theme)].toLowerCase()}`

// anything but a stored light or dark means System
export const parseTheme = (value: string | null | undefined): Theme => value === 'light' || value === 'dark' ? value : 'system'

export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// storage is passed as a getter, since even reading window.localStorage can throw when blocked
export const readTheme = (storage: () => ThemeStorage): Theme => {
  try {
    return parseTheme(storage().getItem(themeKey))
  } catch {
    return 'system'
  }
}

// System is the absence of a choice, so it removes the key; false when storage refused
export const writeTheme = (storage: () => ThemeStorage, theme: Theme): boolean => {
  try {
    if (theme === 'system') storage().removeItem(themeKey)
    else storage().setItem(themeKey, theme)
    return true
  } catch {
    return false
  }
}

// data-theme picks the toggle's icon in styles.css; color-scheme picks every token's half
export const applyTheme = (root: HTMLElement, theme: Theme): void => {
  root.dataset.theme = theme
  root.style.colorScheme = colorSchemeOf(theme)
}

const browserStorage = (): ThemeStorage => window.localStorage

// wires a page's toggle button; a change made in another tab arrives as a storage event
export const mountThemeToggle = (button: HTMLButtonElement): void => {
  let theme = readTheme(browserStorage)
  const show = (): void => {
    applyTheme(document.documentElement, theme)
    const label = themeLabel(theme)
    button.setAttribute('aria-label', label)
    button.title = label
  }
  button.addEventListener('click', () => {
    theme = nextTheme(theme)
    // a refused write still switches this page; only a reload forgets it
    writeTheme(browserStorage, theme)
    show()
  })
  window.addEventListener('storage', (event) => {
    if (event.key !== themeKey && event.key !== null) return
    theme = readTheme(browserStorage)
    show()
  })
  show()
}
