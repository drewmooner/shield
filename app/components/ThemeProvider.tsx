'use client';

import { useCallback, useEffect, useState } from 'react';

function applyTheme(isDark: boolean) {
  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    // Hydration: read theme after mount to avoid SSR mismatch
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional mount flag
    setMounted(true);
    const saved = localStorage.getItem('darkMode');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = saved ? saved === 'true' : prefersDark;
    setDarkMode(isDark);
    applyTheme(isDark);
  }, []);

  const toggleDarkMode = useCallback(() => {
    setDarkMode(prev => {
      const newMode = !prev;
      localStorage.setItem('darkMode', String(newMode));
      applyTheme(newMode);
      return newMode;
    });
  }, []);

  if (!mounted) {
    return <>{children}</>;
  }

  return <>{children}</>;
}

