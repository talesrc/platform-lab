import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { SidebarContent } from './Sidebar';
import { platformIcons } from './icons';

export const navModule = createFrontendModule({
  pluginId: 'app',
  extensions: [SidebarContent, platformIcons],
});
