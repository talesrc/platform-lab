# platform-lab

**platform-lab** is TALECO's local internal developer platform: a [kind](https://kind.sigs.k8s.io/)
cluster bootstrapped with Terraform and then managed with GitOps by
[Argo CD](https://argo-cd.readthedocs.io/). Developers use it through
[Backstage](https://backstage.lab.localhost): a catalog of every service, live state on each
service's page, and a golden-path template that turns a form into a running, policy-compliant
service.

## Where things are

| UI | URL |
|---|---|
| Developer portal (Backstage) | <https://backstage.lab.localhost> |
| Argo CD | <https://argocd.lab.localhost> |
| Grafana | <https://grafana.lab.localhost> |
| Prometheus | <https://prometheus.lab.localhost> |
| Alertmanager | <https://alertmanager.lab.localhost> |
| Apps | `https://<name>.apps.lab.localhost` |

`*.localhost` names resolve to `127.0.0.1` in browsers and curl (RFC 6761), so no DNS or
hosts-file changes are needed. The certificates are signed by the lab's own CA; see
[Bring it up](bring-up.md#trust-the-lab-ca).

## Start here

- New to the platform? Read the [architecture](architecture.md).
- Want to ship a service? Follow [Apps and the golden path](apps.md).
- Running the lab yourself? See [Bring it up](bring-up.md).
- What's next? See the [roadmap](roadmap.md).

The source lives in [talesrc/platform-lab](https://github.com/talesrc/platform-lab); these pages
are its `docs/` folder, rendered in Backstage on the `platform-lab` system's *Docs* tab.
