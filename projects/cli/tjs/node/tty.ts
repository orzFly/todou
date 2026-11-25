// `tty` for the tjs build, which only clipanion imports: it calls
// `tty.WriteStream.prototype.getColorDepth()` once, at load, to decide whether
// help text is coloured. That call reads nothing but the environment, so this
// is the environment half of Node's WriteStream and nothing else.
//
// getColorDepth below is ported from Node's lib/internal/tty.js (v26), which
// is MIT-licensed: Copyright Node.js contributors. All rights reserved.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above
// copyright notice and this permission notice shall be included in all copies
// or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
//
// Two departures: the deprecation warning Node prints when FORCE_COLOR meets
// NO_COLOR is left out, and the Windows build number comes from tjs' uname.

import { osRelease } from "../platform.ts";

const COLORS_2 = 1;
const COLORS_16 = 4;
const COLORS_256 = 8;
const COLORS_16m = 24;

const TERM_ENVS: Record<string, number> = {
  eterm: COLORS_16,
  cons25: COLORS_16,
  console: COLORS_16,
  cygwin: COLORS_16,
  dtterm: COLORS_16,
  gnome: COLORS_16,
  hurd: COLORS_16,
  jfbterm: COLORS_16,
  konsole: COLORS_16,
  kterm: COLORS_16,
  mlterm: COLORS_16,
  mosh: COLORS_16m,
  putty: COLORS_16,
  st: COLORS_16,
  "rxvt-unicode-24bit": COLORS_16m,
  terminator: COLORS_16m,
  "xterm-kitty": COLORS_16m,
};

const CI_ENVS_MAP = new Map(
  Object.entries({
    APPVEYOR: COLORS_256,
    BUILDKITE: COLORS_256,
    CIRCLECI: COLORS_16m,
    DRONE: COLORS_256,
    GITEA_ACTIONS: COLORS_16m,
    GITHUB_ACTIONS: COLORS_16m,
    GITLAB_CI: COLORS_256,
    TRAVIS: COLORS_256,
  }),
);

const TERM_ENVS_REG_EXP = [
  /ansi/,
  /color/,
  /linux/,
  /direct/,
  /^con[0-9]*x[0-9]/,
  /^rxvt/,
  /^screen/,
  /^xterm/,
  /^vt100/,
  /^vt220/,
];

const hasOwn = (env: object, key: string) => Object.hasOwn(env, key);

function getColorDepth(
  env: Record<string, string | undefined> = process.env,
): number {
  if (env.FORCE_COLOR !== undefined) {
    switch (env.FORCE_COLOR) {
      case "":
      case "1":
      case "true":
        return COLORS_16;
      case "2":
        return COLORS_256;
      case "3":
        return COLORS_16m;
      default:
        return COLORS_2;
    }
  }

  if (
    (env.NODE_DISABLE_COLORS !== undefined && env.NODE_DISABLE_COLORS !== "") ||
    (env.NO_COLOR !== undefined && env.NO_COLOR !== "") ||
    env.TERM === "dumb"
  ) {
    return COLORS_2;
  }

  if (process.platform === "win32") {
    const release = osRelease.split(".", 3);
    if (+(release[0] ?? 0) >= 10) {
      const build = +(release[2] ?? 0);
      if (build >= 14931) return COLORS_16m;
      if (build >= 10586) return COLORS_256;
    }
    return COLORS_16;
  }

  if (env.TMUX) return COLORS_16m;

  if (hasOwn(env, "TF_BUILD") && hasOwn(env, "AGENT_NAME")) return COLORS_16;

  if (hasOwn(env, "CI")) {
    for (const [envName, colors] of CI_ENVS_MAP) {
      if (hasOwn(env, envName)) return colors;
    }
    if (env.CI_NAME === "codeship") return COLORS_256;
    return COLORS_2;
  }

  if ("TEAMCITY_VERSION" in env) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.exec(env.TEAMCITY_VERSION ?? "") !==
      null
      ? COLORS_16
      : COLORS_2;
  }

  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
      if (
        !env.TERM_PROGRAM_VERSION ||
        /^[0-2]\./.exec(env.TERM_PROGRAM_VERSION) !== null
      ) {
        return COLORS_256;
      }
      return COLORS_16m;
    case "HyperTerm":
    case "MacTerm":
      return COLORS_16m;
    case "Apple_Terminal":
      return COLORS_256;
  }

  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    return COLORS_16m;
  }

  if (env.TERM) {
    if (/truecolor/.exec(env.TERM) !== null) return COLORS_16m;
    if (/^xterm-256/.exec(env.TERM) !== null) return COLORS_256;
    const termEnv = env.TERM.toLowerCase();
    const known = TERM_ENVS[termEnv];
    if (known) return known;
    if (TERM_ENVS_REG_EXP.some((term) => term.exec(termEnv) !== null)) {
      return COLORS_16;
    }
  }
  if (env.COLORTERM) return COLORS_16;
  return COLORS_2;
}

export class WriteStream {
  getColorDepth(env?: Record<string, string | undefined>): number {
    return getColorDepth(env);
  }
}

export default { WriteStream };
