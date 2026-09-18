import { z } from "zod";

/** Local scripts always target Docker Desktop, independently of kubectl's current context. */
export const context = "docker-desktop";
/** A separate namespace allows fresh acceptance runs without replacing an older installation. */
export const namespace = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  .parse(process.env.PASEO_NAMESPACE ?? "paseo-system");
