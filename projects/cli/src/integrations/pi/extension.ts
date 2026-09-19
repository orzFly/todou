/** Native Pi adapter; the standalone installed asset bundles the shared core. */
import todou, {
  type ExtensionHost,
  type ExtensionProfile,
} from "../omp/extension.ts";

const PI_PROFILE: ExtensionProfile = {
  agent: "pi",
  stateEnv: "TODOU_PI_STATE",
  toolsEnv: "TODOU_PI_TOOLS",
  childEnv: {
    PI_CODING_AGENT: "true",
    // A Pi launched from another agent must still spawn Pi watch children.
    OMPCODE: undefined,
    CLAUDECODE: undefined,
    TODOU_OMP_STATE: undefined,
    TODOU_OMP_TOOLS: undefined,
  },
  reclaimOnStart: true,
};

/** Pi's native validator accepts plain JSON Schema without a schema library. */
export const WATCH_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["start", "stop", "list"],
      description: "start a watch, stop one, or list what is running",
    },
    issue: {
      type: "string",
      description:
        'the card to follow — "T-16", "16", "proj/16", or a full URL. Leave it out to follow the whole project',
    },
    project: {
      type: "string",
      description:
        "project slug, or a comma-separated list of them. Left out, it is resolved from the directory pi is running in",
    },
    server: {
      type: "string",
      description: "server origin. Left out, it is resolved the same way",
    },
    since: {
      type: "string",
      description:
        'cursor to resume from. Without it the watch starts at "now"',
    },
    debounce: {
      type: "string",
      description:
        "batching window in seconds; 60 by default, 0 delivers each entry as it lands",
    },
    id: {
      type: "string",
      description: "which watch to stop, from a start or a list",
    },
  },
  required: ["action"],
  additionalProperties: false,
};

export default function piExtension(pi: ExtensionHost): void {
  todou(pi, PI_PROFILE, WATCH_PARAMETERS);
}
