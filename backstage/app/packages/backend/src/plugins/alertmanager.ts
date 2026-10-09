/*
 * Alertmanager webhook receiver: turns Prometheus alerts into Backstage notifications for
 * the team that owns the alerting workload.
 *
 * POST /api/alertmanager/webhook takes Alertmanager's webhook payload
 * (https://prometheus.io/docs/alerting/latest/configuration/#webhook_config). Each alert
 * goes to the Components whose backstage.io/kubernetes-namespace annotation matches the
 * alert's `namespace` label (so app-hello reaches hello's owner, monitoring reaches
 * kube-prometheus-stack's owner); alerts without a namespace, or in a namespace no
 * Component claims, go to alertmanager.fallbackRecipient. Notification recipients for an
 * entity are its owner's members, resolved by the notifications backend.
 *
 * Alertmanager authenticates with a static token (backend.auth.externalAccess, restricted
 * to this plugin).
 */
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { notificationService } from '@backstage/plugin-notifications-node';
import type { NotificationSeverity } from '@backstage/plugin-notifications-common';
import express from 'express';
import Router from 'express-promise-router';

type Alert = {
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  fingerprint: string;
};

type WebhookPayload = {
  externalURL?: string;
  alerts?: Alert[];
};

// Alertmanager's `severity` label (kube-prometheus-stack rules use critical/warning/info).
const firingSeverity: Record<string, NotificationSeverity> = {
  critical: 'critical',
  warning: 'high',
  info: 'normal',
};

export default createBackendPlugin({
  pluginId: 'alertmanager',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        catalog: catalogServiceRef,
        notifications: notificationService,
      },
      async init({
        config,
        logger,
        auth,
        httpAuth,
        httpRouter,
        catalog,
        notifications,
      }) {
        const fallbackRecipient =
          config.getOptionalString('alertmanager.fallbackRecipient') ??
          'group:default/platform-team';

        async function ownersOf(namespace: string | undefined) {
          if (!namespace) {
            return [fallbackRecipient];
          }
          const { items } = await catalog.getEntities(
            {
              filter: {
                kind: 'Component',
                'metadata.annotations.backstage.io/kubernetes-namespace':
                  namespace,
              },
              fields: ['kind', 'metadata.namespace', 'metadata.name'],
            },
            { credentials: await auth.getOwnServiceCredentials() },
          );
          return items.length
            ? items.map(entity => stringifyEntityRef(entity))
            : [fallbackRecipient];
        }

        // Promise-aware, so a rejected handler (e.g. bad credentials) reaches the error handler.
        const router = Router();
        router.use(express.json({ limit: '1mb' }));

        router.post('/webhook', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['service'] });

          const { alerts, externalURL } = req.body as WebhookPayload;
          if (!Array.isArray(alerts)) {
            res
              .status(400)
              .json({ error: 'expected an Alertmanager webhook payload' });
            return;
          }

          const recipientsByNamespace = new Map<string, Promise<string[]>>();
          let failed = 0;

          for (const alert of alerts) {
            const {
              alertname = 'Alert',
              namespace,
              severity = '',
            } = alert.labels;
            const resolved = alert.status === 'resolved';
            const where = namespace ? ` in ${namespace}` : '';
            const filter = encodeURIComponent(
              `{alertname="${alertname}"${
                namespace ? `,namespace="${namespace}"` : ''
              }}`,
            );

            try {
              const key = namespace ?? '';
              if (!recipientsByNamespace.has(key)) {
                recipientsByNamespace.set(key, ownersOf(namespace));
              }
              const entityRef = await recipientsByNamespace.get(key)!;

              await notifications.send({
                recipients: { type: 'entity', entityRef },
                payload: {
                  title: resolved
                    ? `Resolved: ${alertname}${where}`
                    : `${alertname} firing${where}`,
                  description:
                    alert.annotations?.summary ??
                    alert.annotations?.description ??
                    alert.annotations?.message,
                  link: externalURL
                    ? `${externalURL}/#/alerts?filter=${filter}`
                    : undefined,
                  severity: resolved
                    ? 'low'
                    : firingSeverity[severity] ?? 'normal',
                  topic: 'alerts',
                  // Same scope: the "resolved" update replaces the "firing" notification.
                  scope: `alertmanager:${alert.fingerprint}`,
                },
              });
            } catch (error) {
              failed++;
              logger.error(
                `Failed to notify about ${alertname}${where}: ${error}`,
              );
            }
          }

          // A 5xx makes Alertmanager retry the group; the scope keeps retries idempotent.
          res
            .status(failed ? 500 : 200)
            .json({ received: alerts.length, failed });
        });

        httpRouter.use(router);
      },
    });
  },
});
