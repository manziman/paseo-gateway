import type { V1EnvVar, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import {
  type CredentialProfile,
  CredentialProfileSchema,
  type Project,
  type Workspace,
} from "../domain.js";

import { repositoryLocation } from "./repository.js";

export interface CredentialReference {
  kind: "Secret" | "ConfigMap";
  name: string;
  key: string;
}
/** The controller validates these references without putting their values in resources or status. */
export function referencedCredentials(profile: CredentialProfile): CredentialReference[] {
  const references: CredentialReference[] = [];
  for (const item of [...profile.spec.env, ...profile.spec.files]) {
    if (item.valueFrom.secretKeyRef)
      references.push({ kind: "Secret", ...item.valueFrom.secretKeyRef });
    else if (item.valueFrom.configMapKeyRef)
      references.push({ kind: "ConfigMap", ...item.valueFrom.configMapKeyRef });
  }
  if (profile.spec.git?.tokenSecretRef)
    references.push({ kind: "Secret", ...profile.spec.git.tokenSecretRef });
  if (profile.spec.git?.githubApp)
    references.push({
      kind: "Secret",
      name: profile.spec.git.githubApp.outputSecretName,
      key: "token",
    });
  if (profile.spec.git?.ssh) {
    references.push({ kind: "Secret", ...profile.spec.git.ssh.keySecretRef });
    const knownHosts = profile.spec.git.ssh.knownHostsRef;
    if (knownHosts.secretKeyRef) references.push({ kind: "Secret", ...knownHosts.secretKeyRef });
    else if (knownHosts.configMapKeyRef)
      references.push({ kind: "ConfigMap", ...knownHosts.configMapKeyRef });
  }
  if (profile.spec.git?.signing)
    references.push({ kind: "Secret", ...profile.spec.git.signing.keySecretRef });
  return [
    ...new Map(references.map((ref) => [`${ref.kind}/${ref.name}/${ref.key}`, ref])).values(),
  ];
}

export function credentialProjection(
  workspace: Workspace,
  project: Project,
  supplied?: CredentialProfile,
) {
  const profile = supplied ? CredentialProfileSchema.parse(supplied) : undefined;
  if (
    profile &&
    (profile.metadata.namespace !== workspace.metadata.namespace ||
      profile.metadata.name !== workspace.spec.credentialProfile)
  )
    throw new Error("Credential profile must match the workspace reference and namespace");
  const env: V1EnvVar[] = profile
    ? [...profile.spec.env]
    : [
        {
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          valueFrom: { secretKeyRef: { name: workspace.spec.credentialProfile, key: "token" } },
        },
      ];
  const volumes: V1Volume[] = [];
  const daemonMounts: V1VolumeMount[] = [];
  const checkoutMounts: V1VolumeMount[] = [];
  for (const [index, file] of (profile?.spec.files ?? []).entries()) {
    const name = `profile-file-${index}`;
    const reference = file.valueFrom.secretKeyRef ?? file.valueFrom.configMapKeyRef;
    if (!reference) throw new Error("Missing credential file reference");
    const items = [
      {
        key: reference.key,
        path: "value",
        mode: file.mode,
      },
    ];
    volumes.push({
      name,
      ...(file.valueFrom.secretKeyRef
        ? { secret: { secretName: file.valueFrom.secretKeyRef.name, items } }
        : { configMap: { name: reference.name, items } }),
    });
    daemonMounts.push({
      name,
      mountPath: `/home/paseo/${file.path}`,
      subPath: "value",
      readOnly: true,
    });
    checkoutMounts.push({
      name,
      mountPath: `/data/home/${file.path}`,
      subPath: "value",
      readOnly: true,
    });
  }
  const git = profile?.spec.git;
  const gitConfig: [string, string][] = [];
  if (repositoryLocation(project.spec.repository).transport === "ssh" && !git?.ssh)
    throw new Error(
      "SSH repositories require a credential profile with an SSH key and known hosts",
    );
  if (git?.ssh) {
    const known = git.ssh.knownHostsRef;
    const knownReference = known.secretKeyRef ?? known.configMapKeyRef;
    if (!knownReference) throw new Error("SSH known hosts reference is required");
    volumes.push({
      name: "git-ssh",
      projected: {
        defaultMode: 0o440,
        sources: [
          {
            secret: {
              name: git.ssh.keySecretRef.name,
              items: [{ key: git.ssh.keySecretRef.key, path: "key" }],
            },
          },
          known.secretKeyRef
            ? {
                secret: {
                  name: knownReference.name,
                  items: [{ key: knownReference.key, path: "known_hosts" }],
                },
              }
            : {
                configMap: {
                  name: knownReference.name,
                  items: [{ key: knownReference.key, path: "known_hosts" }],
                },
              },
        ],
      },
    });
    const mount = { name: "git-ssh", mountPath: "/run/paseo-ssh", readOnly: true };
    daemonMounts.push(mount);
    checkoutMounts.push(mount);
    env.push({
      name: "GIT_SSH_COMMAND",
      value:
        "ssh -i /run/paseo-ssh/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/paseo-ssh/known_hosts -o GlobalKnownHostsFile=/dev/null -o BatchMode=yes",
    });
  }
  const gitToken =
    git?.tokenSecretRef ??
    (git?.githubApp ? { name: git.githubApp.outputSecretName, key: "token" } : undefined);
  if (gitToken) {
    const repository = repositoryLocation(project.spec.repository);
    if (
      git?.githubApp &&
      (repository.hostname !== "github.com" ||
        !git.githubApp.repositories.some(
          (repo) => repo.toLowerCase() === repository.path.replace(/\.git$/, "").toLowerCase(),
        ))
    )
      throw new Error("Repository is outside the GitHub App allowlist");
    volumes.push({
      name: "git-token",
      secret: {
        secretName: gitToken.name,
        items: [{ key: gitToken.key, path: "token", mode: 0o440 }],
      },
    });
    const tokenMount = { name: "git-token", mountPath: "/run/paseo-git", readOnly: true };
    daemonMounts.push(tokenMount);
    checkoutMounts.push(tokenMount);
    env.push(
      { name: "PASEO_GIT_TOKEN_FILE", value: "/run/paseo-git/token" },
      { name: "PASEO_GIT_HOST", value: repository.host },
      { name: "PASEO_GIT_PATH", value: repository.path },
      { name: "PASEO_GIT_USERNAME", value: git?.username ?? "x-access-token" },
      { name: "GH_HOST", value: repository.hostname },
    );
    // Reset other helpers so this workspace never stores its token in the persistent home.
    gitConfig.push(
      ["credential.helper", ""],
      ["credential.helper", "!node /opt/paseo/git-credential.mjs"],
      ["credential.useHttpPath", "true"],
    );
  }
  if (git?.identity)
    gitConfig.push(["user.name", git.identity.name], ["user.email", git.identity.email]);
  if (git?.signing) {
    volumes.push({
      name: "git-signing",
      secret: {
        secretName: git.signing.keySecretRef.name,
        items: [{ key: git.signing.keySecretRef.key, path: "key", mode: 0o440 }],
      },
    });
    const mount = { name: "git-signing", mountPath: "/run/paseo-signing", readOnly: true };
    daemonMounts.push(mount);
    checkoutMounts.push(mount);
    gitConfig.push(
      ["gpg.format", "ssh"],
      ["user.signingkey", "/run/paseo-signing/key"],
      ["commit.gpgsign", "true"],
      ["tag.gpgsign", "true"],
    );
  }
  env.push({ name: "GIT_TERMINAL_PROMPT", value: "0" });
  if (gitConfig.length) {
    env.push({ name: "GIT_CONFIG_COUNT", value: String(gitConfig.length) });
    gitConfig.forEach(([key, value], index) => {
      env.push(
        { name: `GIT_CONFIG_KEY_${index}`, value: key },
        { name: `GIT_CONFIG_VALUE_${index}`, value },
      );
    });
  }
  return { env, volumes, daemonMounts, checkoutMounts };
}
