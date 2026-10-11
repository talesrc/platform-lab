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

{{/* Password generator name for a generated env var: hello + SESSION_KEY -> hello-session-key. */}}
{{- define "app.generatorName" -}}
{{- printf "%s-%s" (include "app.name" .root) (include "app.volumeName" .name) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fails when an env var is set by more than one of env, secretEnv and generatedSecretEnv. */}}
{{- define "app.checkEnvNames" -}}
{{- $seen := dict -}}
{{- range $name := concat (keys .Values.env) .Values.secretEnv (keys .Values.generatedSecretEnv) -}}
{{- if hasKey $seen $name -}}
{{- fail (printf "%s is set more than once: an env var comes from one of env, secretEnv or generatedSecretEnv" $name) -}}
{{- end -}}
{{- $_ := set $seen $name true -}}
{{- end -}}
{{- end -}}
