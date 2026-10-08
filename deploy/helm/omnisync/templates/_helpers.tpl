{{/* Names. Everything is named <release>-omnisync[-component]; the chart name is dropped when the release name already contains it. */}}
{{- define "omnisync.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "omnisync.fullname" -}}
{{- $n := include "omnisync.name" . -}}
{{- if contains $n .Release.Name -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $n | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Labels. Call with (dict "root" . "component" "gateway"). */}}
{{- define "omnisync.selectorLabels" -}}
app.kubernetes.io/name: {{ include "omnisync.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "omnisync.labels" -}}
{{ include "omnisync.selectorLabels" . }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: omnisync
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Image reference. Call with (dict "root" . "name" .Values.image.gateway). */}}
{{- define "omnisync.image" -}}
{{- printf "%s/%s:%s" .root.Values.image.registry .name (default .root.Chart.AppVersion .root.Values.image.tag) -}}
{{- end -}}

{{/* Web origins: https://<host> for CORS and CSP, https://<host>/ for the return_to allowlist (exact match with what the apps send). */}}
{{- define "omnisync.origin" -}}
{{- printf "https://%s" . -}}
{{- end -}}

{{- define "omnisync.pageUrl" -}}
{{- printf "https://%s/" . -}}
{{- end -}}

{{/* S3 endpoint: the bundled MinIO when enabled, otherwise the configured one (empty = AWS). */}}
{{- define "omnisync.s3Endpoint" -}}
{{- if .Values.minio.enabled -}}
{{- printf "http://%s-minio:9000" (include "omnisync.fullname" .) -}}
{{- else -}}
{{- .Values.storage.s3.endpoint -}}
{{- end -}}
{{- end -}}

{{/* Security contexts shared by every pod and container (Pod Security "restricted"). */}}
{{- define "omnisync.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "omnisync.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop:
    - ALL
{{- end -}}

{{/* A secretKeyRef environment entry. Call with (dict "env" "NAME" "secret" $secretName "key" "key-name" "optional" false). */}}
{{- define "omnisync.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
      optional: {{ .optional }}
{{- end -}}

{{/* Scheduling constraints shared by every workload. */}}
{{- define "omnisync.scheduling" -}}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "omnisync.pullSecrets" -}}
{{- if .Values.image.pullSecrets }}
imagePullSecrets:
{{- range .Values.image.pullSecrets }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Content-Security-Policy and the other response headers of the web apps. Call with the chart root. */}}
{{- define "omnisync.web.headers" -}}
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' {{ include "omnisync.origin" .Values.hosts.api }} wss://{{ .Values.hosts.gateway }}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Cache-Control "no-cache" always;
{{- end -}}
