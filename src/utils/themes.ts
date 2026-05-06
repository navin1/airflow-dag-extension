/**
 * Highlight.js theme manager.
 * Imports each theme CSS as an inline string (Vite ?raw feature),
 * then injects the selected theme into a single <style id="hljs-theme"> tag.
 * Switching themes is instant — no page reload needed.
 */

// CSS files copied from node_modules/highlight.js/styles/ to src/styles/
import githubCss        from '../styles/github.css?raw';
import atomOneLightCss  from '../styles/atom-one-light.css?raw';
import vsCss            from '../styles/vs.css?raw';
import xcodeCss         from '../styles/xcode.css?raw';
import atomOneDarkCss   from '../styles/atom-one-dark.css?raw';
import githubDarkCss    from '../styles/github-dark.css?raw';
import monokaiCss       from '../styles/monokai.css?raw';
import vs2015Css        from '../styles/vs2015.css?raw';

export interface ThemeDef {
  label:   string;
  css:     string;
  dark:    boolean;   // true = dark bg, false = light bg
  bg:      string;    // code panel background
  panelBg: string;    // action bar / stats bar background
  border:  string;    // divider / border color
  text:    string;    // default code text color
  lineNum: string;    // line number color
}

export const THEMES: Record<string, ThemeDef> = {
  'github': {
    label:   'GitHub Light',
    css:     githubCss,
    dark:    false,
    bg:      '#FFFFFF',
    panelBg: '#F6F8FA',
    border:  '#E2E8F0',
    text:    '#0D1117',
    lineNum: '#CBD5E1',
  },
  'atom-one-light': {
    label:   'Atom One Light',
    css:     atomOneLightCss,
    dark:    false,
    bg:      '#FAFAFA',
    panelBg: '#F0F0F0',
    border:  '#DCDCDC',
    text:    '#383A42',
    lineNum: '#C0C0C0',
  },
  'vs': {
    label:   'Visual Studio',
    css:     vsCss,
    dark:    false,
    bg:      '#FFFFFF',
    panelBg: '#F3F3F3',
    border:  '#DCDCDC',
    text:    '#000000',
    lineNum: '#BEBEBE',
  },
  'xcode': {
    label:   'Xcode',
    css:     xcodeCss,
    dark:    false,
    bg:      '#FFFFFF',
    panelBg: '#F2F2F2',
    border:  '#DCDCDC',
    text:    '#000000',
    lineNum: '#C0C0C0',
  },
  'atom-one-dark': {
    label:   'Atom One Dark',
    css:     atomOneDarkCss,
    dark:    true,
    bg:      '#282C34',
    panelBg: '#21252B',
    border:  '#3E4451',
    text:    '#ABB2BF',
    lineNum: '#4B5263',
  },
  'github-dark': {
    label:   'GitHub Dark',
    css:     githubDarkCss,
    dark:    true,
    bg:      '#0D1117',
    panelBg: '#161B22',
    border:  '#30363D',
    text:    '#C9D1D9',
    lineNum: '#3D4F5E',
  },
  'monokai': {
    label:   'Monokai',
    css:     monokaiCss,
    dark:    true,
    bg:      '#272822',
    panelBg: '#1E1F1C',
    border:  '#3E3D32',
    text:    '#F8F8F2',
    lineNum: '#5A5A4E',
  },
  'vs2015': {
    label:   'VS 2015',
    css:     vs2015Css,
    dark:    true,
    bg:      '#1E1E1E',
    panelBg: '#252526',
    border:  '#3C3C3C',
    text:    '#D4D4D4',
    lineNum: '#5A5A5A',
  },
};

export const THEME_KEYS     = Object.keys(THEMES);
export const DEFAULT_THEME  = 'github';
export const STORAGE_KEY    = 'sqlViewerTheme';

// ── Apply theme to the document ───────────────────────────────────────────────

export function applyTheme(themeKey: string): void {
  const theme = THEMES[themeKey] ?? THEMES[DEFAULT_THEME];
  let style = document.getElementById('hljs-theme') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'hljs-theme';
    document.head.appendChild(style);
  }
  style.textContent = theme.css;
}

// ── Persist / load from chrome.storage ───────────────────────────────────────

export async function loadTheme(): Promise<string> {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return new Promise(resolve =>
      chrome.storage.sync.get([STORAGE_KEY], r =>
        resolve((r[STORAGE_KEY] as string) ?? DEFAULT_THEME),
      ),
    );
  }
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME;
}

export async function saveTheme(themeKey: string): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return new Promise(resolve => chrome.storage.sync.set({ [STORAGE_KEY]: themeKey }, resolve));
  }
  localStorage.setItem(STORAGE_KEY, themeKey);
}
