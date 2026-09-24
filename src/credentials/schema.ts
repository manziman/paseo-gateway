import { z } from "zod";

const name = z
  .string()
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  .max(63);
export const KeyReferenceSchema = z
  .object({
    name,
    key: z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/)
      .min(1)
      .max(253),
  })
  .strict();
export const ValueReferenceSchema = z
  .object({
    secretKeyRef: KeyReferenceSchema.optional(),
    configMapKeyRef: KeyReferenceSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Number(!!value.secretKeyRef) + Number(!!value.configMapKeyRef) === 1,
    "Exactly one Secret or ConfigMap key reference is required",
  );
const protectedEnv =
  /^(?:PASEO_|GATEWAY_|KUBERNETES_|GIT_|LD_|DYLD_|NODE_|NPM_CONFIG_|npm_config_)/;
export function allowedEnvironmentName(value: string): boolean {
  return (
    !protectedEnv.test(value) &&
    ![
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
    ].includes(value)
  );
}
export function allowedFilePath(value: string): boolean {
  const parts = value.split("/");
  return (
    parts.every((part) => !!part && part !== "." && part !== "..") &&
    ![
      ".gitconfig",
      ".git-credentials",
      ".bashrc",
      ".bash_profile",
      ".profile",
      ".zshrc",
      ".zshenv",
    ].includes(parts[0] ?? "") &&
    ![".paseo", ".paseo-gateway"].includes(parts[0] ?? "") &&
    value !== ".codex/auth.json"
  );
}
const quantity = z
  .string()
  .regex(/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+|[EPTGMK]i?|m|k)?$/)
  .max(32);
const resources = z
  .object({
    cpu: quantity.optional(),
    memory: quantity.optional(),
    "ephemeral-storage": quantity.optional(),
  })
  .strict();
export const RuntimeOverridesSchema = z
  .object({
    image: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/)
      .optional(),
    resources: z
      .object({ requests: resources.optional(), limits: resources.optional() })
      .strict()
      .optional(),
  })
  .strict();
export const CredentialProfileSpecSchema = z
  .object({
    env: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .max(128)
              .refine(allowedEnvironmentName, "Reserved runtime environment name"),
            valueFrom: ValueReferenceSchema,
          })
          .strict(),
      )
      .max(64)
      .default([]),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(240)
              .regex(/^[A-Za-z0-9._/-]+$/)
              .refine(
                allowedFilePath,
                "Use a safe relative home path outside gateway configuration",
              ),
            valueFrom: ValueReferenceSchema,
            mode: z
              .number()
              .int()
              .min(0o440)
              .max(0o444)
              .refine((mode) => mode === 0o440 || mode === 0o444, "Use mode 0440 or 0444")
              .default(0o440),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    git: z
      .object({
        tokenSecretRef: KeyReferenceSchema.optional(),
        githubApp: z
          .object({
            appId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            privateKeySecretRef: KeyReferenceSchema,
            outputSecretName: name,
            repositories: z
              .array(
                z
                  .string()
                  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
                  .max(200),
              )
              .min(1)
              .max(100),
          })
          .strict()
          .optional(),
        ssh: z
          .object({ keySecretRef: KeyReferenceSchema, knownHostsRef: ValueReferenceSchema })
          .strict()
          .optional(),
        username: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._@-]+$/)
          .default("x-access-token"),
        identity: z
          .object({
            name: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[^\r\n]+$/)
              .refine((value) => !value.includes(String.fromCharCode(0)), "NUL is not permitted"),
            email: z
              .string()
              .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
              .max(254),
          })
          .strict()
          .optional(),
        signing: z
          .object({ keySecretRef: KeyReferenceSchema, format: z.literal("ssh") })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    runtime: RuntimeOverridesSchema.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.git?.tokenSecretRef && spec.git.githubApp)
      ctx.addIssue({
        code: "custom",
        message: "Choose a static token or GitHub App, not both",
        path: ["git"],
      });
    if (spec.git?.githubApp) {
      const app = spec.git.githubApp;
      if (app.outputSecretName === app.privateKeySecretRef.name)
        ctx.addIssue({
          code: "custom",
          message: "Output Secret must differ from App private key Secret",
          path: ["git", "githubApp"],
        });
      if (
        new Set(app.repositories.map((repo) => repo.toLowerCase())).size !==
          app.repositories.length ||
        new Set(app.repositories.map((repo) => repo.split("/")[0]?.toLowerCase())).size !== 1
      )
        ctx.addIssue({
          code: "custom",
          message: "Repository allowlist must be unique and belong to one owner",
          path: ["git", "githubApp", "repositories"],
        });
    }
    if (new Set(spec.env.map((env) => env.name)).size !== spec.env.length)
      ctx.addIssue({ code: "custom", message: "Environment names must be unique", path: ["env"] });
    for (const [index, file] of spec.files.entries()) {
      if (
        spec.files.some(
          (other, j) =>
            j !== index && (other.path === file.path || file.path.startsWith(`${other.path}/`)),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "File paths cannot overlap",
          path: ["files", index, "path"],
        });
    }
    if (
      (spec.git?.tokenSecretRef || spec.git?.githubApp) &&
      spec.env.some((env) => ["GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"].includes(env.name))
    )
      ctx.addIssue({
        code: "custom",
        message: "Git authentication manages GH_TOKEN, GH_ENTERPRISE_TOKEN and GH_HOST",
        path: ["env"],
      });
  });
