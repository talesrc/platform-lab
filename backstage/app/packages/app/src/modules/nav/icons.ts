import { IconBundleBlueprint } from '@backstage/plugin-app-react';
import SyncIcon from '@material-ui/icons/Sync';
import ShowChartIcon from '@material-ui/icons/ShowChart';
import WhatshotIcon from '@material-ui/icons/Whatshot';
import NotificationsActiveIcon from '@material-ui/icons/NotificationsActive';

/** Icons for the platform UIs, referenced by id from config (e.g. the home toolkit). */
export const platformIcons = IconBundleBlueprint.make({
  name: 'platform',
  params: {
    icons: {
      argocd: SyncIcon,
      grafana: ShowChartIcon,
      prometheus: WhatshotIcon,
      alertmanager: NotificationsActiveIcon,
    },
  },
});
