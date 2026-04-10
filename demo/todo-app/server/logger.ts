import { logger } from "@mandujs/core";

// development environment logger configuration
export const appLogger = logger({
  format: "pretty",
  level: "debug",
  includeHeaders: false,
  includeBody: false,
  maxBodyBytes: 1024,
  sampleRate: 1,
  slowThresholdMs: 500,
});
