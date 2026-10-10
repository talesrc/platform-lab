/*
 * platform-lab permission policy (replaces the allow-all policy).
 *
 * - Signed-in users can read everything and run the golden-path templates: the scaffolder
 *   only opens a pull request, and merging it is the gate (CI, review, Kyverno, the apps
 *   AppProject), so restricting the template itself would add friction without safety.
 * - Changing the catalog is restricted. Unregistering/deleting or refreshing an entity is
 *   allowed to its owners and to the platform team; registering or removing locations (which
 *   decides what the catalog ingests) is platform-team only.
 *
 * Service-to-service calls (fact retrievers, the alertmanager plugin, Policy Reporter
 * backend) and external access tokens (Argo CD Notifications, Alertmanager) use service
 * principals, which the permission framework does not route through this policy.
 */
import {
  coreServices,
  createBackendModule,
  type UserInfoService,
} from '@backstage/backend-plugin-api';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';
import {
  catalogEntityCreatePermission,
  catalogEntityDeletePermission,
  catalogEntityRefreshPermission,
  catalogLocationCreatePermission,
  catalogLocationDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';
import {
  AuthorizeResult,
  isPermission,
  type PolicyDecision,
} from '@backstage/plugin-permission-common';
import type {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';

/** Owners of the platform; full catalog administration. */
export const PLATFORM_TEAM = 'group:default/platform-team';

export class PlatformLabPermissionPolicy implements PermissionPolicy {
  constructor(private readonly userInfo: UserInfoService) {}

  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    // Only signed-in users get anything.
    if (!user) {
      return { result: AuthorizeResult.DENY };
    }
    const { ownershipEntityRefs } = await this.userInfo.getUserInfo(
      user.credentials,
    );
    const isPlatformTeam = ownershipEntityRefs.includes(PLATFORM_TEAM);
    const { permission } = request;

    // What the catalog ingests: platform team only.
    if (
      isPermission(permission, catalogLocationCreatePermission) ||
      isPermission(permission, catalogLocationDeletePermission) ||
      isPermission(permission, catalogEntityCreatePermission)
    ) {
      return {
        result: isPlatformTeam ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
      };
    }

    // Unregister/delete or refresh an entity: its owners (or the platform team).
    if (
      isPermission(permission, catalogEntityDeletePermission) ||
      isPermission(permission, catalogEntityRefreshPermission)
    ) {
      if (isPlatformTeam) {
        return { result: AuthorizeResult.ALLOW };
      }
      return createCatalogConditionalDecision(
        permission,
        catalogConditions.isEntityOwner({ claims: ownershipEntityRefs }),
      );
    }

    // Reading the catalog, TechDocs, Kubernetes/Argo CD/Grafana data, scorecards and
    // running templates.
    return { result: AuthorizeResult.ALLOW };
  }
}

export default createBackendModule({
  pluginId: 'permission',
  moduleId: 'platform-lab-policy',
  register(reg) {
    reg.registerInit({
      deps: {
        policy: policyExtensionPoint,
        userInfo: coreServices.userInfo,
      },
      async init({ policy, userInfo }) {
        policy.setPolicy(new PlatformLabPermissionPolicy(userInfo));
      },
    });
  },
});
