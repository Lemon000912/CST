import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "paper-query-theme-v1";

const ThemeContext = createContext<{
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
} | null>(null);

function readStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light") return "light";
  } catch {
    /* ignore */
  }
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => readStoredTheme());

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    try {
      document.documentElement.dataset.theme = t;
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 须在 ThemeProvider 内使用");
  return ctx;
}
