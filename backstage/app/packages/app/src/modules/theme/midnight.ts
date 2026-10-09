import {
  createUnifiedTheme,
  genPageTheme,
  pageTheme,
  palettes,
  shapes,
} from '@backstage/theme';

/**
 * Midnight: navy-tinted darks in four layers (sidebar < page < cards < raised)
 * with a teal accent. The same values are mirrored for Backstage UI components
 * in midnight.css.
 */
const colors = {
  sidebar: '#0a0f19',
  page: '#0e1420',
  paper: '#161e2e',
  raised: '#1e2840',
  border: '#2a3550',
  text: '#e6edf6',
  textSubtle: '#93a1b8',
  textVerySubtle: '#64718a',
  accent: '#2dd4bf',
  accentHover: '#5eead4',
  accentInk: '#04201c',
  violet: '#a78bfa',
  ok: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
  info: '#60a5fa',
};

// Page header gradients, picked by page kind.
const header = {
  platform: ['#0f766e', '#1e3a8a'],
  service: ['#1e3a8a', '#5b21b6'],
  docs: ['#155e75', '#0f766e'],
  neutral: ['#1e2840', '#2a3550'],
};

export const midnightTheme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    background: { default: colors.page, paper: colors.paper },
    primary: { main: colors.accent, dark: colors.accentHover },
    secondary: { main: colors.violet },
    text: { primary: colors.text, secondary: colors.textSubtle },
    divider: colors.border,
    border: colors.border,
    textSubtle: colors.textSubtle,
    textVerySubtle: colors.textVerySubtle,
    link: colors.accent,
    linkHover: colors.accentHover,
    success: { main: colors.ok },
    warning: { main: colors.warning },
    error: { main: colors.error },
    info: { main: colors.info },
    status: {
      ...palettes.dark.status,
      ok: colors.ok,
      warning: colors.warning,
      error: colors.error,
      running: colors.info,
    },
    banner: {
      ...palettes.dark.banner,
      info: '#1d4ed8',
      error: '#b91c1c',
      warning: '#b45309',
    },
    navigation: {
      ...palettes.dark.navigation,
      background: colors.sidebar,
      indicator: colors.accent,
      color: colors.textSubtle,
      selectedColor: colors.text,
      navItem: { hoverBackground: colors.raised },
      submenu: { background: colors.page },
    },
  },
  defaultPageTheme: 'home',
  pageTheme: {
    ...pageTheme,
    home: genPageTheme({ colors: header.platform, shape: shapes.wave }),
    apis: genPageTheme({ colors: header.platform, shape: shapes.wave2 }),
    tool: genPageTheme({ colors: header.platform, shape: shapes.round }),
    service: genPageTheme({ colors: header.service, shape: shapes.wave }),
    website: genPageTheme({ colors: header.service, shape: shapes.wave }),
    app: genPageTheme({ colors: header.service, shape: shapes.wave }),
    library: genPageTheme({ colors: header.service, shape: shapes.wave2 }),
    documentation: genPageTheme({ colors: header.docs, shape: shapes.wave2 }),
    other: genPageTheme({ colors: header.neutral, shape: shapes.wave }),
    card: genPageTheme({ colors: header.neutral, shape: shapes.wave }),
  },
  components: {
    // MUI v5 lightens dark-mode Paper with a gradient overlay; keep the flat layers.
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiButton: {
      styleOverrides: {
        containedPrimary: {
          color: colors.accentInk,
          '&:hover': { backgroundColor: colors.accentHover },
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        hover: { '&:hover': { backgroundColor: `${colors.raised} !important` } },
      },
    },
  },
});
