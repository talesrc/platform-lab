import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { ThemeBlueprint } from '@backstage/plugin-app-react';
import { UnifiedThemeProvider } from '@backstage/theme';
import DarkIcon from '@material-ui/icons/Brightness2';
import { midnightTheme } from './midnight';
import './midnight.css';

/**
 * Replaces the stock dark theme with Midnight. Same extension name and theme id
 * ('dark') as the one it overrides, so a saved "Dark" selection carries over.
 * The stock light theme is disabled in app-config.yaml, so Midnight is the only
 * theme and the default for everyone.
 */
const midnight = ThemeBlueprint.make({
  name: 'dark',
  params: {
    theme: {
      id: 'dark',
      title: 'Midnight',
      variant: 'dark',
      icon: <DarkIcon />,
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={midnightTheme} themeName="midnight">
          {children}
        </UnifiedThemeProvider>
      ),
    },
  },
});

export const themeModule = createFrontendModule({
  pluginId: 'app',
  extensions: [midnight],
});
