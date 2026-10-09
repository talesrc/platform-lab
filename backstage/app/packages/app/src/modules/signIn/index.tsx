import { SignInPage } from '@backstage/core-components';
import {
  createFrontendModule,
  githubAuthApiRef,
} from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';

/**
 * Replaces the default (guest) sign-in page with GitHub sign-in.
 * The backend maps the GitHub login to a catalog User of the same name
 * (usernameMatchingUserEntityName in app-config.production.yaml).
 */
const githubSignInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      (
        <SignInPage
          {...props}
          auto
          provider={{
            id: 'github-auth-provider',
            title: 'GitHub',
            message: 'Sign in with your GitHub account',
            apiRef: githubAuthApiRef,
          }}
        />
      ),
  },
});

export const signInModule = createFrontendModule({
  pluginId: 'app',
  extensions: [githubSignInPage],
});
