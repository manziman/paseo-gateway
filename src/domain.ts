import { z } from "zod";
import { validRepository } from "./credentials/repository.js";
import { CredentialProfileSpecSchema, RuntimeOverridesSchema } from "./credentials/schema.js";

export const API_GROUP = "paseo-gateway.manziman.github.io";
export const WORKSPACE_UID_LABEL = `${API_GROUP}/workspace-uid`;
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
      .max(2048)
      .refine(validRepository, "Use HTTPS without credentials or SSH with the git user"),
    revision: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/)
      .default("HEAD"),
    credentialProfile: name,
    runtime: RuntimeOverridesSchema.optional(),
    cache: z
      .object({
        claimName: name,
        subPath: z
          .string()
          .min(1)
          .max(240)
          .regex(/^[A-Za-z0-9._/-]+$/)
          .refine(
            (value) => value.split("/").every((part) => !!part && part !== "." && part !== ".."),
            "Use a safe relative cache path",
          )
          .optional(),
      })
      .optional(),
    maxRunningWorkspaces: z.number().int().min(1).max(10000).optional(),
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
    revision: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/@{}^~+-]*$/)
      .default("HEAD"),
    branch: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .optional(),
    fetchDepth: z.number().int().min(0).max(100000).optional(),
    pullRequest: z.number().int().positive().optional(),
    retentionPolicy: z
      .object({
        storage: z.enum(["Retain", "Ephemeral"]),
        ttlAfterArchivedSeconds: z.number().int().min(0).max(31536000).optional(),
      })
      .optional(),
  }),
  status: z
    .object({
      phase: z.enum(["Pending", "Ready", "Suspended", "Archived", "Failed"]),
      observedGeneration: z.number().int(),
      message: z.string(),
      pvcName: z.string().optional(),
      archivedAt: z.string().optional(),
      teardownCompletedAt: z.string().optional(),
      storageDeletedAt: z.string().optional(),
      lastFailure: z.object({ reason: z.string(), message: z.string(), at: z.string() }).optional(),
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

export const CredentialProfileSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal("PaseoCredentialProfile"),
  metadata,
  spec: CredentialProfileSpecSchema,
});
export type CredentialProfile = z.infer<typeof CredentialProfileSchema>;

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
