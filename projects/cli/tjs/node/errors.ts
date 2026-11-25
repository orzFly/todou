// Node's shape for a failed system call, built from a tjs error.
//
// tjs throws `Error("ENOENT: no such file or directory")` with `code` set from
// uv_err_name(), and Node takes both halves of its message from the same
// libuv tables. What Node adds is the call and the path, so that the
// messages the CLI passes on read the same on both runtimes:
// "ENOENT: no such file or directory, open '/x'".

export type SystemError = Error & {
  code: string;
  syscall: string;
  path?: string;
  dest?: string;
};

export function systemError(
  error: unknown,
  syscall: string,
  path?: string,
  dest?: string,
): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (!(error instanceof Error) || typeof code !== "string") return error;
  const where =
    path === undefined
      ? ""
      : dest === undefined
        ? ` '${path}'`
        : ` '${path}' -> '${dest}'`;
  const wrapped = new Error(
    `${error.message}, ${syscall}${where}`,
  ) as SystemError;
  wrapped.code = code;
  wrapped.syscall = syscall;
  if (path !== undefined) wrapped.path = path;
  if (dest !== undefined) wrapped.dest = dest;
  return wrapped;
}

/** Runs one call, rethrowing its failure in Node's shape. */
export async function call<T>(
  syscall: string,
  path: string | undefined,
  run: () => Promise<T>,
  dest?: string,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw systemError(error, syscall, path, dest);
  }
}

/** An error tjs cannot raise itself, such as EISDIR from a refused unlink. */
export function makeSystemError(
  code: string,
  description: string,
  syscall: string,
  path?: string,
): SystemError {
  const error = new Error(`${code}: ${description}`) as Error & {
    code: string;
  };
  error.code = code;
  return systemError(error, syscall, path) as SystemError;
}
