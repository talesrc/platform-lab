{{/* App name: nameOverride or the release name (= apps/<name> directory via Argo CD). */}}
{{- define "app.name" -}}
{{- default .Release.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
{{- end -}}

{{- define "app.labels" -}}
{{ include "app.selectorLabels" . }}
app.kubernetes.io/part-of: apps
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* emptyDir volume name for a writable path, e.g. /tmp -> tmp, /var/cache -> var-cache. */}}
{{- define "app.volumeName" -}}
{{- trimPrefix "-" (regexReplaceAll "[^a-z0-9]+" (lower .) "-") | trunc 63 | trimSuffix "-" -}}
{{- end -}}
