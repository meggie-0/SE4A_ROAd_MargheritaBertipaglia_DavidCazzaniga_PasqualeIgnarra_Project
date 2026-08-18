export const THEMES = ['light', 'dark'] as const;

export type Theme = (typeof THEMES)[number];

const THEME_STORAGE_KEY = 'road-passenger-theme';

function isTheme(value: string | null): value is Theme {
  return value !== null && THEMES.some((theme) => theme === value);
}

/**
 * Usa il tema salvato dall'utente. Alla prima apertura segue invece
 * la preferenza giorno/notte del sistema operativo.
 */
export function loadTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);

  if (isTheme(stored)) return stored;

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applica il tema al documento e lo conserva per gli accessi successivi. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

  themeColor?.setAttribute('content', theme === 'dark' ? '#061328' : '#F4F6FF');
}
