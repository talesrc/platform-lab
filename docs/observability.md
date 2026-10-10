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

## Alerts

Alertmanager sends every alert except `Watchdog` to Backstage, where it becomes a notification
for the owners of the components in the alert's namespace (`platform-team` otherwise). In
Backstage, an entity's *Grafana* card lists its dashboards.
