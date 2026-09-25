import { type CredentialProfile, type Project, projectPath } from "../domain.js";

/** The desktop catalog cwd identifies an authorized Project, never a Workspace. */
export function projectForCatalogPath(
  cwd: string,
  projects: readonly Project[],
): Project | undefined {
  return projects.find((project) => cwd === projectPath(project.metadata.name));
}

export function effectiveWorkspaceImage(input: {
  project: Project;
  profile: CredentialProfile;
  defaultImage: string;
}): string {
  return (
    input.project.spec.runtime?.image ?? input.profile.spec.runtime?.image ?? input.defaultImage
  );
}
