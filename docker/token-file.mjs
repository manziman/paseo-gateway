import { readFileSync } from "node:fs";
/** Open on every invocation: whole projected volumes follow Kubernetes' atomic ..data switch. */
export function readGitToken(env = process.env) {
  if (!env.PASEO_GIT_TOKEN_FILE) return undefined;
  let token;
  try {
    token = readFileSync(env.PASEO_GIT_TOKEN_FILE, "utf8").trim();
  } catch {
    throw new Error("Git credential file is unavailable");
  }
  if (!token || token.length > 16384 || /\s/.test(token) || token.includes(String.fromCharCode(0)))
    throw new Error("Git credential file is invalid");
  return token;
}

export function githubEnvironment(input = process.env) {
  const env = { ...input };
  const token = readGitToken(env);
  if (token) {
    delete env.GH_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    env[env.GH_HOST === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"] = token;
  }
  return env;
}
