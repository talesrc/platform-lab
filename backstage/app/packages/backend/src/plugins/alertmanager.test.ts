import {
  mockCredentials,
  startTestBackend,
} from '@backstage/backend-test-utils';
import { createServiceFactory } from '@backstage/backend-plugin-api';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import { notificationService } from '@backstage/plugin-notifications-node';
import request from 'supertest';
import alertmanagerPlugin, { tenantOf } from './alertmanager';

const component = (name: string, namespace?: string) => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name,
    namespace: 'default',
    annotations: namespace
      ? { 'backstage.io/kubernetes-namespace': namespace }
      : ({} as Record<string, string>),
  },
  spec: { type: 'service', owner: 'group:default/platform-team' },
});

const alert = (
  status: 'firing' | 'resolved',
  labels: Record<string, string>,
) => ({
  status,
  labels,
  annotations: { summary: `${labels.alertname} summary` },
  fingerprint: `fp-${labels.alertname}`,
});

describe('tenantOf', () => {
  it('maps app-<name>-<env> namespaces to the golden-path app', () => {
    expect(tenantOf('app-hello-prd')).toBe('hello');
    expect(tenantOf('app-my-api-stg')).toBe('my-api');
    expect(tenantOf('app-hello')).toBeUndefined();
    expect(tenantOf('monitoring')).toBeUndefined();
  });
});

describe('alertmanager webhook', () => {
  const send = jest.fn();

  async function start() {
    const { server } = await startTestBackend({
      features: [
        alertmanagerPlugin,
        catalogServiceMock.factory({
          entities: [
            // Golden-path app: no namespace annotation, it runs in app-hello-<env>.
            component('hello'),
            component('envoy-gateway', 'envoy-gateway-system'),
            component('platform-gateway', 'envoy-gateway-system'),
          ],
        }),
        createServiceFactory({
          service: notificationService,
          deps: {},
          factory: () => ({ send }),
        }),
      ],
    });
    return server;
  }

  beforeEach(() => send.mockReset());

  it('notifies the owners of the components in the alert namespace', async () => {
    const server = await start();

    const res = await request(server)
      .post('/api/alertmanager/webhook')
      .set('Authorization', mockCredentials.service.header())
      .send({
        externalURL: 'https://alertmanager.lab.localhost',
        alerts: [
          alert('firing', {
            alertname: 'KubePodCrashLooping',
            namespace: 'app-hello-prd',
            severity: 'warning',
          }),
          alert('resolved', {
            alertname: 'EnvoyDown',
            namespace: 'envoy-gateway-system',
            severity: 'critical',
          }),
          alert('firing', { alertname: 'NodeDiskFull', severity: 'critical' }),
        ],
      });

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toEqual({
      recipients: { type: 'entity', entityRef: ['component:default/hello'] },
      payload: expect.objectContaining({
        title: 'KubePodCrashLooping firing in app-hello-prd',
        description: 'KubePodCrashLooping summary',
        severity: 'high',
        scope: 'alertmanager:fp-KubePodCrashLooping',
        link: expect.stringMatching(
          /^https:\/\/alertmanager\.lab\.localhost\/#\/alerts\?filter=/,
        ),
      }),
    });
    expect(send.mock.calls[1][0]).toEqual({
      recipients: {
        type: 'entity',
        entityRef: [
          'component:default/envoy-gateway',
          'component:default/platform-gateway',
        ],
      },
      payload: expect.objectContaining({
        title: 'Resolved: EnvoyDown in envoy-gateway-system',
        severity: 'low',
      }),
    });
    // No namespace: the platform team.
    expect(send.mock.calls[2][0]).toEqual({
      recipients: {
        type: 'entity',
        entityRef: ['group:default/platform-team'],
      },
      payload: expect.objectContaining({
        title: 'NodeDiskFull firing',
        severity: 'critical',
      }),
    });
  });

  it('answers 500 so Alertmanager retries when a notification fails', async () => {
    const server = await start();
    send.mockRejectedValueOnce(new Error('boom'));

    const res = await request(server)
      .post('/api/alertmanager/webhook')
      .set('Authorization', mockCredentials.service.header())
      .send({
        alerts: [
          alert('firing', { alertname: 'X', namespace: 'app-hello-stg' }),
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ received: 1, failed: 1 });
  });

  it('rejects requests without credentials and malformed payloads', async () => {
    const server = await start();

    await request(server)
      .post('/api/alertmanager/webhook')
      .send({ alerts: [] })
      .expect(res => expect([401, 403]).toContain(res.status));
    await request(server)
      .post('/api/alertmanager/webhook')
      .set('Authorization', mockCredentials.service.header())
      .send({ nope: true })
      .expect(400);
  });
});
