import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { REPOSITORY_PATTERN } from "../src/credentials/repository.js";
import {
  API_GROUP,
  CredentialProfileSchema,
  ProjectSchema,
  WorkspaceSchema,
} from "../src/domain.js";

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

type SchemaNode = {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  [key: string]: unknown;
};
function property(node: SchemaNode, ...path: string[]): SchemaNode {
  for (const key of path) {
    const child = node.properties?.[key];
    if (!child) throw new Error(`Missing generated schema property ${key}`);
    node = child;
  }
  return node;
}
function items(node: SchemaNode): SchemaNode {
  if (!node.items) throw new Error("Missing generated schema items");
  return node.items;
}
function rules(node: SchemaNode, validations: { rule: string; message: string }[]) {
  node["x-kubernetes-validations"] = validations;
}
function valueReference(node: SchemaNode) {
  rules(node, [
    {
      rule: "has(self.secretKeyRef) != has(self.configMapKeyRef)",
      message: "Exactly one Secret or ConfigMap key reference is required",
    },
  ]);
}
function safeRelativePath(node: SchemaNode) {
  rules(node, [
    {
      rule: "self.split('/').all(p, p != '' && p != '.' && p != '..')",
      message: "Path must be relative without empty or traversal components",
    },
  ]);
}
function profileValidations(root: SchemaNode) {
  const spec = property(root, "spec");
  const env = property(spec, "env");
  const files = property(spec, "files");
  const reservedNames = [
    "HOME",
    "CODEX_HOME",
    "PATH",
    "SHELL",
    "ENV",
    "BASH_ENV",
    "ZDOTDIR",
    "NODE_OPTIONS",
    "REPOSITORY",
    "REVISION",
    "BRANCH",
    "FETCH_DEPTH",
    "PULL_REQUEST",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  rules(property(items(env), "name"), [
    {
      rule: `!(self in ${JSON.stringify(reservedNames)}) && !self.matches('^(PASEO_|GATEWAY_|KUBERNETES_|GIT_|LD_|DYLD_|NODE_|NPM_CONFIG_|npm_config_)')`,
      message: "Reserved runtime environment name",
    },
  ]);
  rules(env, [
    {
      rule: "self.all(e, self.filter(other, other.name == e.name).size() == 1)",
      message: "Environment names must be unique",
    },
  ]);
  valueReference(property(items(env), "valueFrom"));
  valueReference(property(items(files), "valueFrom"));
  const filePath = property(items(files), "path");
  const reservedPaths = [
    ".gitconfig",
    ".git-credentials",
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".zshrc",
    ".zshenv",
    ".paseo",
    ".paseo-gateway",
  ];
  rules(filePath, [
    {
      rule: `self.split('/').all(p, p != '' && p != '.' && p != '..') && !${JSON.stringify(reservedPaths)}.exists(p, self == p || self.startsWith(p + '/')) && self != '.codex/auth.json'`,
      message: "Use a safe home path outside gateway configuration and shared Codex auth",
    },
  ]);
  property(items(files), "mode").enum = [0o440, 0o444];
  rules(files, [
    {
      rule: "self.all(f, self.filter(g, f.path == g.path || f.path.startsWith(g.path + '/') || g.path.startsWith(f.path + '/')).size() == 1)",
      message: "File paths cannot overlap or duplicate",
    },
  ]);
  valueReference(property(spec, "git", "ssh", "knownHostsRef"));
  rules(spec, [
    {
      rule: "!has(self.git) || !(has(self.git.tokenSecretRef) && has(self.git.githubApp))",
      message: "Choose a static token or GitHub App, not both",
    },
    {
      rule: "!has(self.git) || !(has(self.git.tokenSecretRef) || has(self.git.githubApp)) || !has(self.env) || self.env.all(e, !(e.name in ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']))",
      message: "Git authentication manages GitHub CLI token environment",
    },
  ]);
  const app = property(spec, "git", "githubApp");
  rules(app, [
    {
      rule: "self.outputSecretName != self.privateKeySecretRef.name",
      message: "Output Secret must differ from App private key Secret",
    },
  ]);
  rules(property(app, "repositories"), [
    {
      rule: "self.all(r, self.filter(other, other.lowerAscii() == r.lowerAscii()).size() == 1)",
      message: "Repository allowlist must be unique",
    },
    {
      rule: "self.all(r, r.split('/')[0].lowerAscii() == self[0].split('/')[0].lowerAscii())",
      message: "Repository allowlist must belong to one owner",
    },
  ]);
}

await mkdir("charts/paseo/crds", { recursive: true });
for (const [kind, plural, singular, schema] of [
  ["PaseoProject", "paseoprojects", "paseoproject", ProjectSchema],
  ["PaseoWorkspace", "paseoworkspaces", "paseoworkspace", WorkspaceSchema],
  [
    "PaseoCredentialProfile",
    "paseocredentialprofiles",
    "paseocredentialprofile",
    CredentialProfileSchema,
  ],
] as const) {
  const json = z.toJSONSchema(schema, { target: "openapi-3.0" });
  structural(json);
  delete json.$schema;
  delete json.additionalProperties;
  if (json.properties) {
    json.properties.metadata = { type: "object" };
    if (kind === "PaseoProject") {
      property(json as SchemaNode, "spec", "repository").pattern = REPOSITORY_PATTERN;
      safeRelativePath(property(json as SchemaNode, "spec", "cache", "subPath"));
    }
    if (kind === "PaseoCredentialProfile") profileValidations(json as SchemaNode);
    if (kind === "PaseoWorkspace") {
      const spec = json.properties.spec;
      if (spec && typeof spec === "object")
        Object.assign(spec, {
          "x-kubernetes-validations": [
            {
              rule: "oldSelf.residency != 'Archived' || self.residency == 'Archived'",
              message: "Archived workspaces cannot be restored; create a new workspace",
            },
            { rule: "self.projectRef == oldSelf.projectRef", message: "projectRef is immutable" },
            {
              rule: "(has(self.retentionPolicy) ? self.retentionPolicy.storage : 'Retain') == (has(oldSelf.retentionPolicy) ? oldSelf.retentionPolicy.storage : 'Retain')",
              message: "Storage class cannot change after workspace creation",
            },
            {
              rule: "self.credentialProfile == oldSelf.credentialProfile",
              message: "credentialProfile is immutable",
            },
            { rule: "self.revision == oldSelf.revision", message: "revision is immutable" },
            ...["fetchDepth", "pullRequest"].flatMap((field) => [
              {
                rule: `has(self.${field}) == has(oldSelf.${field})`,
                message: `${field} presence is immutable`,
              },
              {
                rule: `!has(self.${field}) || self.${field} == oldSelf.${field}`,
                message: `${field} is immutable`,
              },
            ]),
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
