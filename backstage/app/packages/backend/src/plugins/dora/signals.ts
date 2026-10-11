/*
 * What counts as a prd failure for DORA (change failure rate, time to restore).
 *
 * Today: any critical alert in app-<name>-prd. Alertmanager only sends the dora receiver those
 * alerts (gitops/platform/kube-prometheus-stack.yaml), and this checks again. Once services
 * have SLOs (roadmap item 7), change both to the SLO burn-rate alerts: the rest of the plugin
 * only sees incidents.
 */
import { tenantOf } from '../alertmanager';

const FAILURE_SEVERITIES = new Set(['critical']);

/** The golden-path app whose prd an alert says is failing, if it does. */
export function failingApp(labels: Record<string, string>): string | undefined {
  const { namespace = '', severity = '' } = labels;
  if (!namespace.endsWith('-prd') || !FAILURE_SEVERITIES.has(severity)) {
    return undefined;
  }
  return tenantOf(namespace);
}
