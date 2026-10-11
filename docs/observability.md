# Observability

kube-prometheus-stack (Prometheus Operator, Prometheus, Alertmanager, Grafana, node-exporter,
kube-state-metrics) runs in `monitoring`, plus metrics-server for `kubectl top`.

| UI | URL |
|---|---|
| Grafana | <https://grafana.lab.localhost> |
| Prometheus | <https://prometheus.lab.localhost> |
| Alertmanager | <https://alertmanager.lab.localhost> |

Grafana's `admin` password is generated in the cluster:

```bash
kubectl -n monitoring get secret kube-prometheus-stack-grafana \
  -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

## Metrics

Prometheus selects ServiceMonitors, PodMonitors, Probes and PrometheusRules from every
namespace, so an app's ServiceMonitor (created by the golden-path chart) is enough to be
scraped. Prometheus keeps 2 days of data, without persistent volumes.

etcd, kube-scheduler, kube-controller-manager and kube-proxy are not scraped: kind binds their
metrics to `127.0.0.1` inside the nodes.

## SLOs

The golden-path chart gives every app two SLOs per environment, over 30 days, from the request
histogram its ServiceMonitor scrapes (a PrometheusRule `<name>-slo` in `app-<name>-<env>`,
`charts/app/templates/slo.yaml`):

| SLO | Objective | A bad request |
|---|---|---|
| availability | 99.5% | answered with a 5xx status |
| latency | 99% | slower than 0.5s |

Probes and Prometheus' scrapes (`/healthz`, `/readyz`, `/metrics`) don't count: on a quiet
app they would be almost all the traffic and hide real failures.

**Burn-rate alerts.** The burn rate is how fast the error budget (0.5% or 1% of requests) is
being spent: 1 spends exactly the budget in 30 days. Each SLO alerts on two windows at once, a
long one that proves the problem is significant and a short one that proves it is still going
on, so alerts fire fast and resolve fast ([Google SRE workbook](https://sre.google/workbook/alerting-on-slos/)):

| Alert | Severity | Fires when the burn rate is above | Budget gone in |
|---|---|---|---|
| `AvailabilityErrorBudgetBurn`, `LatencyErrorBudgetBurn` | critical | 14.4 over 1h and 5m, or 6 over 6h and 30m | 2 to 5 days |
| same names | warning | 3 over 1d and 2h | 10 days |

The workbook's slowest alert (1x over 3 days) is left out: Prometheus keeps only 2 days. Like
every alert, they become Backstage notifications for the app's owners, and in stg they block
promotion. An app with no requests has no burn rate (0 / 0) and never alerts.

**Recorded series** (labels `namespace`, `job` = app name, `slo`):

| Series | Meaning |
|---|---|
| `slo:sli_error:ratio_rate5m` … `_rate1d` | share of bad requests over 5m, 30m, 1h, 2h, 6h, 1d |
| `slo:error_budget:ratio` | 1 − objective |

So the burn rate of every SLO, e.g. in Prometheus or Grafana, is:

```promql
slo:sli_error:ratio_rate1h / on (namespace, job, slo) slo:error_budget:ratio
```

**Promotion** reads the same series: *Promote to prd* refuses while an SLO in stg burned
faster than `platformLab.promotion.stgMaxBurnRate` (1) over the last 30 minutes. Burn-rate
alerts need an hour of data, longer than the 10-minute soak, so this check catches a bad
release sooner.

**Per app** (`charts/app/values.yaml`, `slo:`): change the objectives, the latency threshold
(`le`, a bucket boundary of the histogram as Prometheus stores it: `0.5`, `1.0`, `2.5`), the
histogram name or label matchers, or turn an SLO off. An app without a podinfo-style
`http_request_duration_seconds` histogram (with `status` and `path` labels) sets
`slo.enabled: false` or points `slo.metric` and the selectors at its own. CI unit-tests the
rules with `promtool test rules` (`scripts/ci/test-slo-rules.sh`).

Sloth was the alternative: it generates the same rules from a short spec, but needs its own
operator (or a generation step) and CRD. The chart already templates everything else, so it
templates plain PrometheusRules, which the existing Prometheus Operator picks up.

## Alerts

Alertmanager sends every alert except `Watchdog` to Backstage, where it becomes a notification
for the owners of the components in the alert's namespace (`platform-team` otherwise). In
Backstage, an entity's *Grafana* card lists its dashboards.
