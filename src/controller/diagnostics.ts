import type { V1Pod } from "@kubernetes/client-node";

/** Report structured reason codes; container messages/logs may contain credentials. */
export function podDiagnostic(
  pod: V1Pod | undefined,
): { reason: string; message: string; failed: boolean } | undefined {
  if (!pod) return undefined;
  const reason = pod.status?.reason;
  if (reason === "Evicted")
    return { reason, message: "Workspace pod evicted; inspect node capacity", failed: true };
  for (const container of [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ]) {
    const terminated = container.state?.terminated ?? container.lastState?.terminated;
    if (terminated && terminated.exitCode !== 0) {
      const code = terminated.reason === "OOMKilled" ? "OOMKilled" : "ContainerFailed";
      return {
        reason: code,
        message:
          code === "OOMKilled"
            ? "Workspace container exceeded its memory limit; active turn may be interrupted"
            : "Workspace container failed; inspect authenticated workspace logs",
        failed: true,
      };
    }
    const waiting = container.state?.waiting?.reason;
    if (
      waiting &&
      [
        "ErrImagePull",
        "ImagePullBackOff",
        "CreateContainerConfigError",
        "CrashLoopBackOff",
      ].includes(waiting)
    )
      return {
        reason: waiting,
        message: `Workspace container cannot start (${waiting})`,
        failed: true,
      };
  }
  if (
    pod.status?.conditions?.some(
      (condition) => condition.type === "PodScheduled" && condition.status === "False",
    )
  )
    return {
      reason: "Unschedulable",
      message: "Workspace pod is unschedulable; inspect resource capacity and placement",
      failed: false,
    };
  return undefined;
}
