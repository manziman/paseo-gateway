import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { API_GROUP, ProjectSchema, WorkspaceSchema } from "../src/domain.js";

function structural(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) structural(child);
    return;
  }
  const record = value as Record<string, unknown>;
  // Kubernetes prunes unknown fields; structural CRDs reject additionalProperties: false.
  if (record.additionalProperties === false) delete record.additionalProperties;
  for (const child of Object.values(record)) structural(child);
}

await mkdir("charts/paseo/crds", { recursive: true });
for (const [kind, plural, singular, schema] of [
  ["PaseoProject", "paseoprojects", "paseoproject", ProjectSchema],
  ["PaseoWorkspace", "paseoworkspaces", "paseoworkspace", WorkspaceSchema],
] as const) {
  const json = z.toJSONSchema(schema, { target: "openapi-3.0" });
  structural(json);
  delete json.$schema;
  delete json.additionalProperties;
  if (json.properties) {
    json.properties.metadata = { type: "object" };
    if (kind === "PaseoWorkspace") {
      const spec = json.properties.spec;
      if (spec && typeof spec === "object")
        Object.assign(spec, {
          "x-kubernetes-validations": [
            { rule: "self.projectRef == oldSelf.projectRef", message: "projectRef is immutable" },
            {
              rule: "self.credentialProfile == oldSelf.credentialProfile",
              message: "credentialProfile is immutable",
            },
            { rule: "self.revision == oldSelf.revision", message: "revision is immutable" },
            {
              rule: "has(self.branch) == has(oldSelf.branch)",
              message: "branch presence is immutable",
            },
            {
              rule: "!has(self.branch) || self.branch == oldSelf.branch",
              message: "branch is immutable",
            },
          ],
        });
    }
  }
  const crd = {
    apiVersion: "apiextensions.k8s.io/v1",
    kind: "CustomResourceDefinition",
    metadata: { name: `${plural}.${API_GROUP}` },
    spec: {
      group: API_GROUP,
      scope: "Namespaced",
      names: { kind, plural, singular },
      versions: [
        {
          name: "v1alpha1",
          served: true,
          storage: true,
          schema: { openAPIV3Schema: json },
          ...(kind === "PaseoWorkspace"
            ? {
                subresources: { status: {} },
                additionalPrinterColumns: [
                  { name: "Project", type: "string", jsonPath: ".spec.projectRef" },
                  { name: "Residency", type: "string", jsonPath: ".spec.residency" },
                  { name: "Phase", type: "string", jsonPath: ".status.phase" },
                ],
              }
            : {}),
        },
      ],
    },
  };
  // JSON is valid YAML; deterministic generated output avoids a second hand-maintained schema.
  await writeFile(`charts/paseo/crds/${plural}.yaml`, `${JSON.stringify(crd, null, 2)}\n`);
}
