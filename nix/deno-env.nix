# How the wrapper in nix/todou-cli.nix treats each environment variable deno
# reads. Only `unset` names get `--unset`; everything else — TODOU_*, HOME,
# XDG_CONFIG_HOME, EDITOR, the harness variables — passes through untouched.
#
# Cleared: anything that changes program semantics, or sends credentials and
# keys somewhere else. Passed through: anything that only tunes runtime
# resources or debugging, which the operator has a legitimate reason to set. A
# bad value in that second group can stop the process from starting, but the
# error names the variable, so "a bad value breaks it" is not on its own a
# reason to clear one.
#
# Coverage boundary: this table only covers the variables `deno help` documents,
# plus the lower-case proxy spellings below. A variable deno reads without
# listing is invisible to it and to the drift test in nix/tests.nix.
{
  unset = [
    # A valid value sends a bearer token to the matching host while fetching
    # modules.
    "DENO_AUTH_TOKENS"
    # Rewrites source at load time.
    "DENO_PATCH_REACT_CVE"
    # Turns on Node compatibility mode, changing module resolution semantics.
    "DENO_COMPAT"
    # Changes how npm package exports conditions resolve.
    "DENO_CONDITIONS"
    # Turns off automatic package.json resolution.
    "DENO_NO_PACKAGE_JSON"
    # Changes transpile cache behaviour.
    "DENO_EMIT_CACHE_MODE"
    # Chooses whether the Web cache lives on disk or in memory.
    "DENO_CACHE_DB_MODE"
    # Cache directory.
    "DENO_DIR"
    # Output directory for `deno install`.
    "DENO_INSTALL_ROOT"
    # Debugging by category, but a bad value turns exit code 0 into 1 while the
    # version still prints on stdout. todou is called from scripts and agents,
    # where a rewritten exit code hands the caller the opposite conclusion.
    "DENO_COVERAGE_DIR"
    # Turns `deno run` into `deno serve` when the entrypoint exports
    # `default { fetch }`.
    "DENO_AUTO_SERVE"
    # Listen address for `deno serve`.
    "DENO_SERVE_ADDRESS"
    # Only meaningful when serving HTTP.
    "DENO_TRUST_PROXY_HEADERS"
    # Deno KV is unused here, so clearing costs nothing.
    "DENO_KV_DB_MODE"
    "DENO_KV_DEFAULT_PATH"
    "DENO_KV_PATH_PREFIX"
    # The wrapper passes --allow-all, so permission prompts never appear.
    "DENO_NO_PROMPT"
    "DENO_TRACE_PERMISSIONS"
    # The bundle has no npm resolution left to do; a bad registry could only
    # cause confusion.
    "NPM_CONFIG_REGISTRY"
  ];

  # A nix-installed deno cannot update itself, so the notice would be noise on
  # stderr. `deno run` has not been observed printing one; this is preventive
  # and free.
  set = {
    DENO_NO_UPDATE_CHECK = "1";
  };

  pass = [
    # V8 resource and debugging switches, such as raising the heap limit. A bad
    # value stops the process from starting with the V8 flag named in the error.
    "DENO_V8_FLAGS"
    # Makes V8's memory limit follow the cgroup, which containers need.
    "DENO_USE_CGROUPS"
    # Tries to release memory on SIGUSR2, the same operator concern as above.
    "DENO_USR2_MEMORY_TRIM"
    # Concurrency for `deno test --parallel`, a path the wrapper never reaches,
    # so either classification is inert; grouped with its neighbours.
    "DENO_JOBS"
    # Packet-capture debugging. It writes TLS session keys to a file the
    # operator names, which is the operator authorising their own process. A bad
    # path only adds a line on stderr and leaves the exit code at 0.
    "SSLKEYLOGFILE"
    # Enterprise CA use. It appends trust rather than replacing it — pointed at
    # /dev/null the handshake still succeeds — so passing it through can only
    # widen trust, never break the user's TLS verification.
    "DENO_CERT"
    # Chooses between the `system` and `mozilla` certificate stores. An
    # unrecognised value fails the request with an uncaught error, which is the
    # known cost of passing it through; the failure is early and explicit.
    "DENO_TLS_CA_STORE"
    # Proxy settings.
    "HTTP_PROXY"
    "HTTPS_PROXY"
    "NO_PROXY"
    # Makes node:http and node:https read the three above as well.
    "NODE_USE_ENV_PROXY"
    # Read by both deno and the CLI.
    "NO_COLOR"
    # Forcing colour through a pipe is a reasonable thing to want.
    "FORCE_COLOR"
  ];

  # deno honours these but does not list them, so the drift test in
  # nix/tests.nix compares against `pass` alone and pins these separately.
  passUndocumented = [
    "http_proxy"
    "https_proxy"
    "no_proxy"
  ];
}
