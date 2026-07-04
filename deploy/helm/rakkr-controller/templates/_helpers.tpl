{{- define "rakkr-controller.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rakkr-controller.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "rakkr-controller.labels" -}}
helm.sh/chart: {{ include "rakkr-controller.name" . }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "rakkr-controller.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "rakkr-controller.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rakkr-controller.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "rakkr-controller.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "rakkr-controller.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "rakkr-controller.appSecretName" -}}
{{- if .Values.appSecret.existingSecret -}}
{{- .Values.appSecret.existingSecret -}}
{{- else -}}
{{- default (printf "%s-app" (include "rakkr-controller.fullname" .)) .Values.appSecret.name -}}
{{- end -}}
{{- end -}}

{{/* True when the chart should render an Opaque app Secret from values
(native backend, secret-creation enabled, and no externally provided secret). */}}
{{- define "rakkr-controller.manageNativeAppSecret" -}}
{{- and .Values.appSecret.create (eq .Values.secrets.backend "native") (not .Values.appSecret.existingSecret) -}}
{{- end -}}

{{/* Render-time guard: refuse the contradictory combo where the operator brings
their own database (database.externalUrl or database.existingSecret.name) yet
leaves the bundled Postgres enabled (postgres.enabled, true by default). That
would render a full Postgres StatefulSet+Service+Secret+PVC that runs UNUSED —
wasted storage and a second, drifting source of truth for the DB password. Fail
fast with an actionable message instead of shipping an orphaned database. */}}
{{- define "rakkr-controller.validateDatabase" -}}
{{- if and .Values.postgres.enabled (or .Values.database.externalUrl .Values.database.existingSecret.name) -}}
{{- fail "postgres.enabled=true but an external database is configured (database.externalUrl or database.existingSecret.name): the bundled Postgres StatefulSet/Service/Secret/PVC would render and run UNUSED. Disable the bundled Postgres when bringing your own DATABASE_URL (set postgres.enabled=false)." -}}
{{- end -}}
{{- end -}}

{{/* Render-time guard: the opt-in migration Job (migrations.job.enabled) runs as
a pre-install/pre-upgrade Helm hook, which is applied BEFORE the release's normal
resources — so the bundled Postgres StatefulSet/Service is not yet up when the
hook runs and the migration would fail against a non-existent database. The Job
path is therefore only valid against an external/pre-existing DB. Refuse the
combo where the Job is enabled while the bundled Postgres is still on; for
bundled Postgres the default init-container migrate (api.migrateOnStartup) is the
correct path (it runs after the StatefulSet, inside the pod lifecycle). */}}
{{- define "rakkr-controller.validateMigrationJob" -}}
{{- if and .Values.migrations.job.enabled .Values.postgres.enabled -}}
{{- fail "migrations.job.enabled=true requires postgres.enabled=false: the migration Job is a pre-install/pre-upgrade hook that runs BEFORE the bundled Postgres StatefulSet exists, so it can only target an external/pre-existing database. For the bundled Postgres, use the default init-container migrate (api.migrateOnStartup=true) and leave migrations.job.enabled=false." -}}
{{- end -}}
{{- end -}}

{{- define "rakkr-controller.postgresSecretName" -}}
{{- default (printf "%s-postgres" (include "rakkr-controller.fullname" .)) .Values.postgres.auth.existingSecret -}}
{{- end -}}

{{- define "rakkr-controller.postgresServiceName" -}}
{{- printf "%s-postgres" (include "rakkr-controller.fullname" .) -}}
{{- end -}}

{{- define "rakkr-controller.databaseUrl" -}}
{{- if .Values.database.externalUrl -}}
{{- .Values.database.externalUrl -}}
{{- else -}}
{{- printf "postgres://%s:%s@%s:5432/%s" .Values.postgres.auth.username .Values.postgres.auth.password (include "rakkr-controller.postgresServiceName" .) .Values.postgres.auth.database -}}
{{- end -}}
{{- end -}}

{{- define "rakkr-controller.databaseEnv" -}}
- name: DATABASE_URL
{{- if .Values.database.existingSecret.name }}
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.existingSecret.name | quote }}
      key: {{ .Values.database.existingSecret.key | quote }}
{{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ include "rakkr-controller.appSecretName" . | quote }}
      key: DATABASE_URL
{{- end }}
{{- end -}}

{{- define "rakkr-controller.apiEnvFrom" -}}
envFrom:
  - configMapRef:
      name: {{ include "rakkr-controller.fullname" . }}-api
  - secretRef:
      name: {{ include "rakkr-controller.appSecretName" . }}
{{- with .Values.api.extraEnvFrom }}
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
