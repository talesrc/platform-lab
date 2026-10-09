{{/*
Namespace selector for the platform listeners: this release's namespace plus every
namespace that has an entry in .Values.routes.
*/}}
{{- define "platform-gateway.platformNamespaces" -}}
{{- $namespaces := list .Release.Namespace -}}
{{- range .Values.routes }}
{{- $namespaces = append $namespaces .namespace -}}
{{- end -}}
from: Selector
selector:
  matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: In
      values:
        {{- range (uniq $namespaces | sortAlpha) }}
        - {{ . }}
        {{- end }}
{{- end -}}
