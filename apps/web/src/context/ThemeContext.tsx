import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'system' | 'light' | 'dark';

interface ThemeCtx {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const KEY = 'janelle-theme';

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme !== 'system') root.classList.add(theme);
}

function systemDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(KEY) as Theme) ?? 'system';
    } catch {
      return 'system';
    }
  });

  const resolved: 'light' | 'dark' =
    theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme;

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* storage may be blocked; ignore */
    }
  }, [theme]);

  const setTheme = (t: Theme) => setThemeState(t);
  const toggle = () => setThemeState(resolved === 'dark' ? 'light' : 'dark');

  return <Ctx.Provider value={{ theme, resolved, setTheme, toggle }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTheme must be used within ThemeProvider');
  return c;
}
