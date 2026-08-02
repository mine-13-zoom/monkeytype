import { readJson } from "./fs";
import { fg, bg, RESET } from "./term";

export interface Theme {
  bg: string;
  main: string;
  caret: string;
  sub: string;
  subAlt: string;
  text: string;
  error: string;
  errorExtra: string;
  colorfulError: string;
  colorfulErrorExtra: string;
}

const themesFile = new URL("../data/themes.json", import.meta.url);
export const themes: Record<string, Theme> = await readJson(themesFile);
export const themeNames: string[] = Object.keys(themes).sort();

export const DEFAULT_THEME = "serika_dark";

export function getTheme(name: string): Theme {
  return themes[name] ?? themes[DEFAULT_THEME]!;
}

/** A painter bound to a theme, returning styled strings. */
export function painter(theme: Theme) {
  return {
    theme,
    bg: bg(theme.bg),
    reset: RESET,
    main: (s: string) => fg(theme.main) + s + RESET + bg(theme.bg),
    text: (s: string) => fg(theme.text) + s + RESET + bg(theme.bg),
    sub: (s: string) => fg(theme.sub) + s + RESET + bg(theme.bg),
    caret: (s: string) => fg(theme.caret) + s + RESET + bg(theme.bg),
    error: (s: string) => fg(theme.error) + s + RESET + bg(theme.bg),
    errorExtra: (s: string) => fg(theme.errorExtra) + s + RESET + bg(theme.bg),
    fgMain: fg(theme.main),
    fgText: fg(theme.text),
    fgSub: fg(theme.sub),
    fgCaret: fg(theme.caret),
    fgError: fg(theme.error),
    fgErrorExtra: fg(theme.errorExtra),
  };
}

export type Painter = ReturnType<typeof painter>;
