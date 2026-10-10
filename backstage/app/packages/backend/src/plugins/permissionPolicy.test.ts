import { mockCredentials } from '@backstage/backend-test-utils';
import type { UserInfoService } from '@backstage/backend-plugin-api';
import {
  catalogEntityCreatePermission,
  catalogEntityDeletePermission,
  catalogEntityReadPermission,
  catalogEntityRefreshPermission,
  catalogLocationCreatePermission,
  catalogLocationDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';
import { taskCreatePermission } from '@backstage/plugin-scaffolder-common/alpha';
import {
  AuthorizeResult,
  type Permission,
} from '@backstage/plugin-permission-common';
import { PlatformLabPermissionPolicy, PLATFORM_TEAM } from './permissionPolicy';

const userInfo = (ownershipEntityRefs: string[]): UserInfoService => ({
  getUserInfo: async () => ({
    userEntityRef: ownershipEntityRefs[0],
    ownershipEntityRefs,
  }),
});

// talesrc as resolved at sign-in: the user and its groups (catalog-info.yaml).
const platformEngineer = ['user:default/talesrc', PLATFORM_TEAM];
const developer = ['user:default/dev', 'group:default/team-a'];

async function decide(refs: string[] | undefined, permission: Permission) {
  const policy = new PlatformLabPermissionPolicy(userInfo(refs ?? []));
  const user = refs
    ? {
        credentials: mockCredentials.user(refs[0]),
        info: { userEntityRef: refs[0], ownershipEntityRefs: refs },
      }
    : undefined;
  return policy.handle({ permission }, user);
}

describe('PlatformLabPermissionPolicy', () => {
  it('denies requests without a signed-in user', async () => {
    expect(await decide(undefined, catalogEntityReadPermission)).toEqual({
      result: AuthorizeResult.DENY,
    });
  });

  it.each([platformEngineer, developer])(
    'lets every signed-in user read the catalog and run templates (%s)',
    async (...refs) => {
      for (const permission of [catalogEntityReadPermission, taskCreatePermission]) {
        expect(await decide(refs, permission)).toEqual({
          result: AuthorizeResult.ALLOW,
        });
      }
    },
  );

  it.each([
    catalogLocationCreatePermission,
    catalogLocationDeletePermission,
    catalogEntityCreatePermission,
  ])('keeps $name to the platform team', async permission => {
    expect(await decide(platformEngineer, permission)).toEqual({
      result: AuthorizeResult.ALLOW,
    });
    expect(await decide(developer, permission)).toEqual({
      result: AuthorizeResult.DENY,
    });
  });

  it.each([catalogEntityDeletePermission, catalogEntityRefreshPermission])(
    'allows $name to the platform team and to entity owners only',
    async permission => {
      expect(await decide(platformEngineer, permission)).toEqual({
        result: AuthorizeResult.ALLOW,
      });
      expect(await decide(developer, permission)).toEqual({
        result: AuthorizeResult.CONDITIONAL,
        pluginId: 'catalog',
        resourceType: 'catalog-entity',
        conditions: {
          rule: 'IS_ENTITY_OWNER',
          resourceType: 'catalog-entity',
          params: { claims: developer },
        },
      });
    },
  );
});
