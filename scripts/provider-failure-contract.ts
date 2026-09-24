export type RejectionSurface =
  | "structured-authentication-error"
  | "native-idle-assistant-auth-error";

export interface RejectionEvidence {
  status: string;
  structuredErrors: string[];
  lastMessage: string | null;
  assistantTexts: string[];
  successMarker: string;
}

export function authRejected(value: string): boolean {
  return /\b(?:401|403|unauthori[sz]ed|forbidden|authentication|invalid (?:api[ _-]?key|token|credential)|access denied|not logged in|please run \/login)\b/i.test(
    value,
  );
}

/** Match only observable provider failures, including pinned Paseo's idle/text surface. */
export function classifyRejectedTurn(evidence: RejectionEvidence): RejectionSurface | null {
  if (evidence.assistantTexts.some((text) => text.includes(evidence.successMarker))) return null;
  if (evidence.status === "error" && evidence.structuredErrors.some(authRejected))
    return "structured-authentication-error";
  if (
    evidence.status === "idle" &&
    evidence.structuredErrors.length === 0 &&
    evidence.assistantTexts.length > 0 &&
    evidence.assistantTexts.every(authRejected) &&
    authRejected(evidence.lastMessage ?? evidence.assistantTexts.join(" "))
  )
    return "native-idle-assistant-auth-error";
  return null;
}
