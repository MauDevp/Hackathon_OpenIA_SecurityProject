import { homedir } from "node:os";
import { join } from "node:path";

/** Private local state. Nothing below this directory is part of a repository. */
export function notificationStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DMSECURITY_STATE_DIR
    ?? environment.GUARDIA_STATE_DIR
    ?? join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "dmsecurity");
}
