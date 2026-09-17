import { z } from "zod";

export const API_GROUP = "paseo.dev";
export const API_VERSION = `${API_GROUP}/v1alpha1`;
export const MANAGED_BY = "paseo-kubernetes";
const name = z
  .string()
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
  .max(63);
const metadata = z
  .object({
    name,
    namespace: name,
    uid: z.string().optional(),
    resourceVersion: z.string().optional(),
    generation: z.number().optional(),
    creationTimestamp: z.string().optional(),
    deletionTimestamp: z.string().optional(),
  })
  .passthrough();

/** Only configuration and lifecycle state belong in these records, never prompts or tokens. */
export const ProjectSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal("PaseoProject"),
  metadata,
  spec: z.object({
    displayName: z.string().min(1).max(200),
    repository: z
      .string()
      .url()
      .refine((s) => {
        const url = new URL(s);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "Use an HTTPS repository URL without embedded credentials"),
    revision: z.string().min(1).max(200).default("HEAD"),
    credentialProfile: name,
  }),
});

export const WorkspaceSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal("PaseoWorkspace"),
  metadata,
  spec: z.object({
    projectRef: name,
    displayName: z.string().min(1).max(200),
    residency: z.enum(["Running", "Suspended", "Archived"]).default("Running"),
    credentialProfile: name,
    revision: z.string().min(1).max(200).default("HEAD"),
    branch: z.string().min(1).max(200).optional(),
  }),
  status: z
    .object({
      phase: z.enum(["Pending", "Ready", "Suspended", "Archived", "Failed"]),
      observedGeneration: z.number().int(),
      message: z.string(),
      pvcName: z.string().optional(),
      backendWorkspaceId: z.string().optional(),
      conditions: z
        .array(
          z.object({
            type: z.literal("Ready"),
            status: z.enum(["True", "False"]),
            reason: z.string(),
            message: z.string(),
            observedGeneration: z.number(),
            lastTransitionTime: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export type Project = z.infer<typeof ProjectSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceStatus = NonNullable<Workspace["status"]>;

export function workspacePath(id: string): string {
  return `/workspaces/${id}`;
}

export function projectPath(id: string): string {
  return `/projects/${id}`;
}

/** Stable, reversible IDs; no mutable routing database is needed. */
export function scopedId(workspaceId: string, backendId: string): string {
  return `${workspaceId}~${Buffer.from(backendId).toString("base64url")}`;
}

export function parseScopedId(id: string): { workspaceId: string; backendId: string } {
  const match = /^([a-z0-9][a-z0-9-]*)~([A-Za-z0-9_-]+)$/.exec(id);
  if (!match?.[1] || !match[2]) throw new Error("Invalid scoped ID");
  const backendId = Buffer.from(match[2], "base64url").toString("utf8");
  if (scopedId(match[1], backendId) !== id) throw new Error("Noncanonical scoped ID");
  return { workspaceId: match[1], backendId };
}
