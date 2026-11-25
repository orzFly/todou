import type * as tty from "node:tty";
import { type Cases, equal } from "./assert.ts";

type Tty = typeof tty;

const ENVS: Record<string, string | undefined>[] = [
  {},
  { TERM: "xterm-256color" },
  { TERM: "xterm" },
  { TERM: "xterm-kitty" },
  { TERM: "screen" },
  { TERM: "dumb" },
  { TERM: "alacritty" },
  { TERM: "xterm-256color", NO_COLOR: "1" },
  { TERM: "xterm", NO_COLOR: "" },
  { FORCE_COLOR: "0" },
  { FORCE_COLOR: "1" },
  { FORCE_COLOR: "2" },
  { FORCE_COLOR: "3" },
  { FORCE_COLOR: "" },
  { COLORTERM: "truecolor" },
  { COLORTERM: "yes" },
  { TMUX: "1", TERM: "screen" },
  { CI: "1", GITHUB_ACTIONS: "true" },
  { CI: "1", GITLAB_CI: "true" },
  { CI: "1" },
  { TF_BUILD: "1", AGENT_NAME: "x" },
  { TEAMCITY_VERSION: "9.1.0" },
  { TEAMCITY_VERSION: "8.0" },
  { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.4" },
  { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "2.9" },
  { TERM_PROGRAM: "Apple_Terminal" },
];

/** What Node answers for each environment above, on a non-Windows host. */
const EXPECTED = [
  1, 8, 4, 24, 4, 1, 1, 1, 4, 1, 4, 8, 24, 4, 24, 4, 24, 24, 8, 1, 4, 4, 1, 24,
  8, 8,
];

export const cases: Cases<Tty> = {
  "getColorDepth reads the environment as Node does": async (mod) => {
    if (process.platform === "win32") return;
    const depth = (env: Record<string, string | undefined>) =>
      mod.WriteStream.prototype.getColorDepth.call(
        mod.WriteStream.prototype,
        env as NodeJS.ProcessEnv,
      );
    ENVS.forEach((env, i) => {
      equal(depth(env), EXPECTED[i], JSON.stringify(env));
    });
  },
};
