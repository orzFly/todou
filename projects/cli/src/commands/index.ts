import type { CommandClass } from "clipanion";
import type { CliContext } from "../api-command.ts";

/** Every registerable command; grows as command files land. */
export const commands: Array<CommandClass<CliContext>> = [];
