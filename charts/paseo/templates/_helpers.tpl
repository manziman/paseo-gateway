{{- define "paseo.gatewayImage" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "paseo.workspaceImage" -}}
{{- if .Values.workspace.image -}}
{{- .Values.workspace.image -}}
{{- else if .Values.workspace.digest -}}
{{- printf "%s@%s" .Values.workspace.repository .Values.workspace.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.workspace.repository (default .Chart.AppVersion .Values.workspace.tag) -}}
{{- end -}}
{{- end -}}
