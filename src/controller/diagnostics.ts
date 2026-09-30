import type { V1Pod } from "@kubernetes/client-node";

const checkoutMessages = {
  CheckoutDnsUnavailable: "Repository hostname resolution failed during checkout",
  CheckoutNetworkUnavailable: "Repository network connection failed during checkout",
  CheckoutFetchTimeout: "Repository fetch exceeded its bounded deadline",
  CheckoutAuthenticationFailed: "Repository credentials were rejected during checkout",
  CheckoutRevisionUnavailable: "Configured repository revision was not found",
  CheckoutLocalStorageFailed: "Workspace storage could not complete checkout",
  CheckoutCacheInvalid: "Reference cache could not support checkout",
  CheckoutConfigurationInvalid: "Repository checkout configuration is invalid",
  CheckoutInitializationFailed: "Repository checkout failed; inspect authorized diagnostics",
} as const;

/** Kubernetes termination text is untrusted; accept only the initializer's fixed envelope. */
export function checkoutTerminationDiagnostic(
  message: string | undefined,
): { reason: string; message: string; failed: true } | undefined {
  if (!message || message.length > 256) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "attempts,code,stage,version") return undefined;
  if (
    fields.version !== 1 ||
    typeof fields.stage !== "string" ||
    !["prepare", "fetch", "checkout", "cache", "marker"].includes(fields.stage) ||
    typeof fields.code !== "string" ||
    !Object.hasOwn(checkoutMessages, fields.code) ||
    !Number.isInteger(fields.attempts) ||
    Number(fields.attempts) < 0 ||
    Number(fields.attempts) > 3
  )
    return undefined;
  const reason = fields.code as keyof typeof checkoutMessages;
  return {
    reason,
    message: `${reason}: ${checkoutMessages[reason]}${fields.attempts ? ` after ${fields.attempts} attempt${fields.attempts === 1 ? "" : "s"}` : ""}`,
    failed: true,
  };
}

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
      if (terminated.reason === "OOMKilled")
        return {
          reason: "OOMKilled",
          message: "Workspace container exceeded its memory limit; active turn may be interrupted",
          failed: true,
        };
      if (container.name === "checkout") {
        const checkout = checkoutTerminationDiagnostic(terminated.message);
        if (checkout) return checkout;
      }
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
