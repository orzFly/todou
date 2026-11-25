# txiki.js, the runtime the single-file `todou` executables are assembled on
# (T-792). nixpkgs carries no txiki and upstream publishes no Linux build, so
# it is cross-compiled here with zig: one host produces every target, and the
# release CI, the docker image and the nix package all take their runtimes from
# this one definition.
#
# Upgrading txiki is this file alone: `version`, the submodule commits the new
# tag pins (`git ls-tree <tag> deps/`, plus mbedtls' own `framework`), and the
# hashes. For those, set each to "" and run
# `nix build path:./.nix#tjs-runtimes --keep-going`: every fetch then fails
# with its real hash after `got:`. Then check the run-main patch still
# applies, and whether it is still needed at all (see its header).
{ lib
, stdenvNoCC
, fetchFromGitHub
, runCommand
, writeShellScript
, writeText
, zig
, cmake
, ninja
, esbuild
, gitMinimal
, file
}:

let
  version = "26.11.0";

  # One fetch per submodule rather than `fetchSubmodules = true`, which would
  # recurse into quickjs' test262 checkout: several hundred MB that no build
  # step reads. wamr is left out with WASM off; nothing outside
  # `if(BUILD_WITH_WASM)` refers to it.
  deps = {
    libuv = fetchFromGitHub {
      owner = "libuv";
      repo = "libuv";
      rev = "dd9f081cc55a4d83e2a976848d074f28ee5f34eb";
      hash = "sha256-OrY4M0tAusF4hl1IjM54b2sZ413hVKTX50rO9+Z4Tn4=";
    };
    libwebsockets = fetchFromGitHub {
      owner = "warmcat";
      repo = "libwebsockets";
      rev = "ac23cae706b99bcc7ffff343cfac58efcdc6dbc1";
      hash = "sha256-4J398LnqyBTMzPdu4Y+Amb1BXGpLBvC2xMfWj7AmtG8=";
    };
    mbedtls = fetchFromGitHub {
      owner = "Mbed-TLS";
      repo = "mbedtls";
      rev = "068ff080b369adfac81509f9b57b2afabaf82dc5";
      hash = "sha256-gTl1U6tPHTEl8JrKNPbggvkNzXRJqjk14QtIdvpfDV8=";
    };
    "mbedtls/framework" = fetchFromGitHub {
      owner = "Mbed-TLS";
      repo = "mbedtls-framework";
      rev = "dde0c4a0e448a0552f18817dcea633bb851fd288";
      hash = "sha256-gHaPbnu2HXnSk52DR438mFt4kCb8MAsHebbNKTflwXQ=";
    };
    mimalloc = fetchFromGitHub {
      owner = "microsoft";
      repo = "mimalloc";
      rev = "a5969c54000f44cd45968e830f6482592373cb0e";
      hash = "sha256-/Ugu1SDxNGfd+mF3HlH7DKUmSfbnJNYoyQeuD0C7xuQ=";
    };
    quickjs = fetchFromGitHub {
      owner = "quickjs-ng";
      repo = "quickjs";
      rev = "7b5f588e0f9b643e2996f291bfc861abeaceddc2";
      hash = "sha256-WYMKqY+Rnzo0dFhMaboSijVzlgBhN8hnHqSQTXwdiN0=";
    };
  };

  # Names are the artifact names; `file` is what the format check expects
  # `file -b` to say, matched as an extended regular expression.
  targets = {
    linux-amd64 = {
      triple = "x86_64-linux-musl";
      system = "Linux";
      processor = "x86_64";
      file = "^ELF 64-bit LSB executable, x86-64, .*, statically linked";
    };
    linux-arm64 = {
      triple = "aarch64-linux-musl";
      system = "Linux";
      processor = "aarch64";
      file = "^ELF 64-bit LSB executable, ARM aarch64, .*, statically linked";
    };
    # mimalloc's macOS build includes CommonCrypto headers, which zig does not
    # ship.
    macos-arm64 = {
      triple = "aarch64-macos";
      system = "Darwin";
      processor = "arm64";
      file = "^Mach-O 64-bit arm64 executable";
      extraCmakeFlags = [ "-DBUILD_WITH_MIMALLOC=OFF" ];
    };
    macos-amd64 = {
      triple = "x86_64-macos";
      system = "Darwin";
      processor = "x86_64";
      file = "^Mach-O 64-bit x86_64 executable";
      extraCmakeFlags = [ "-DBUILD_WITH_MIMALLOC=OFF" ];
    };
    # Empty rather than unset: lws' configure check finds MinGW's pthread.h,
    # and the code it then enables does not build against zig's MinGW.
    windows-amd64 = {
      triple = "x86_64-windows-gnu";
      system = "Windows";
      processor = "AMD64";
      file = "^PE32\\+ executable .*\\(console\\), x86-64";
      extraCmakeFlags = [ "-DLWS_HAVE_PTHREAD_H=" ];
    };
    windows-arm64 = {
      triple = "aarch64-windows-gnu";
      system = "Windows";
      processor = "ARM64";
      file = "^PE32\\+ executable .*\\(console\\), ARM64";
      extraCmakeFlags = [ "-DLWS_HAVE_PTHREAD_H=" ];
    };
  };

  exeSuffix = t: lib.optionalString (t.system == "Windows") ".exe";
  fileName = name: t: "tjs-${name}${exeSuffix t}";

  hostTargetName = {
    x86_64-linux = "linux-amd64";
    aarch64-linux = "linux-arm64";
    aarch64-darwin = "macos-arm64";
    x86_64-darwin = "macos-amd64";
  }.${stdenvNoCC.hostPlatform.system}
    or (throw "txiki: no target for ${stdenvNoCC.hostPlatform.system}");
  hostTarget = targets.${hostTargetName};

  # `-mcpu=baseline` so an x64 and an arm64 host emit the same instructions for
  # a given target: the docker image is built on both, and the two have to
  # serve byte-identical executables (T-570).
  #
  # txiki's CMakeLists gives every WIN32 build two link flags in their MSVC
  # spelling. zig's MinGW wants `/STACK:` in GNU form, and offers the
  # WaitOnAddress family as api-ms-win-core-synch-l1-2-0 rather than the
  # `synchronization` import library libuv asks for. Neither flag appears on
  # other targets, so one wrapper serves all six.
  zigCompiler = tool: triple: writeShellScript "zig-${tool}-${triple}" ''
    for a in "$@"; do
      shift
      case "$a" in
        /STACK:*) set -- "$@" "-Wl,--stack,''${a#/STACK:}" ;;
        -lsynchronization) set -- "$@" -lapi-ms-win-core-synch-l1-2-0 ;;
        *) set -- "$@" "$a" ;;
      esac
    done
    exec ${zig}/bin/zig ${tool} -target ${triple} -mcpu=baseline "$@"
  '';

  zigArchiver = tool: writeShellScript "zig-${tool}" ''
    exec ${zig}/bin/zig ${tool} "$@"
  '';

  # The FIND_ROOT_PATH modes keep cmake from settling on a library or header
  # of the build host's.
  toolchainFile = name: t: writeText "txiki-${name}.cmake" ''
    set(CMAKE_SYSTEM_NAME ${t.system})
    set(CMAKE_SYSTEM_PROCESSOR ${t.processor})
    set(CMAKE_C_COMPILER ${zigCompiler "cc" t.triple})
    set(CMAKE_CXX_COMPILER ${zigCompiler "c++" t.triple})
    set(CMAKE_AR ${zigArchiver "ar"})
    set(CMAKE_RANLIB ${zigArchiver "ranlib"})
    set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
    set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
    set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
    set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
  '';

  zigCacheEnv = ''
    export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
    export ZIG_LOCAL_CACHE_DIR="$TMPDIR/zig-cache"
  '';

  # Upstream's source with our run-main patch, and run-main's bytecode
  # regenerated to carry it. Every target builds from this one tree.
  src = stdenvNoCC.mkDerivation {
    pname = "txiki-src";
    inherit version;

    src = fetchFromGitHub {
      owner = "saghul";
      repo = "txiki.js";
      rev = "v${version}";
      hash = "sha256-Q9yEJRzYZi02lJLetHEY7yTGRn1i1PBk+jnaHdXxVvY=";
    };

    postUnpack = lib.concatStrings (lib.mapAttrsToList
      (path: dep: ''
        rm -rf "$sourceRoot/deps/${path}"
        cp -r ${dep} "$sourceRoot/deps/${path}"
        chmod -R u+w "$sourceRoot/deps/${path}"
      '')
      deps);

    patches = [ ./patches/txiki-standalone-home.patch ];

    # Replaced whole rather than patched, so an upstream edit to this file
    # cannot make the patch stop applying. It is the only part of run-main that
    # imports an npm package (@jsr/std__tar); without it, regenerating
    # run-main needs nothing beyond esbuild and tjsc. It backs `tjs bundle`,
    # which the todou build does not use: it calls esbuild directly.
    postPatch = ''
      cat > src/js/run-main/bundle.js <<'EOF'
      export async function bundle() {
          throw new Error('tjs bundle is not available in this build');
      }
      EOF
    '';

    nativeBuildInputs = [ cmake ninja esbuild gitMinimal ];
    dontUseCmakeConfigure = true;

    # tjsc is configured on a copy so that this output stays upstream's tree
    # plus the two changes above: configuring writes src/version.h and applies
    # txiki's own mbedtls/lws patches in place, and each target does that
    # itself. The esbuild flags are txiki's Makefile's for run-main. tjsc
    # derives the C symbol from the input's file name, so it has to be called
    # run-main.js.
    buildPhase = ''
      runHook preBuild
      ${zigCacheEnv}
      cp -r . "$TMPDIR/tjsc-src"
      cmake -S "$TMPDIR/tjsc-src" -B "$TMPDIR/tjsc-build" -G Ninja \
        -DCMAKE_TOOLCHAIN_FILE=${toolchainFile hostTargetName hostTarget} \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_WITH_FFI=OFF -DBUILD_WITH_WASM=OFF -DBUILD_WITH_MIMALLOC=OFF
      cmake --build "$TMPDIR/tjsc-build" --target tjsc

      mkdir "$TMPDIR/run-main"
      esbuild src/js/run-main/index.js \
        --bundle \
        --outfile="$TMPDIR/run-main/run-main.js" \
        --external:'tjs:*' \
        --minify --keep-names \
        --target=esnext --platform=neutral --format=esm --main-fields=main,module
      (cd "$TMPDIR/run-main" && "$TMPDIR/tjsc-build/tjsc" -m -s \
        -o "$OLDPWD/src/bundles/c/core/run-main.c" \
        -n "tjs:internal/run-main" \
        -p tjs__ \
        run-main.js)
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };

  # One target's build, as a build-phase script rather than a derivation:
  # `nix build .#tjs-runtimes --rebuild` re-runs only the derivation it is
  # given, so the six compiles have to live inside it for that check to cover
  # them.
  #
  # The build directory sits inside the source root so that one prefix map
  # covers both trees' __FILE__ strings; it is called `out` rather than `build`
  # because the sandbox's build root is /build, and the absence of that string
  # is what the install check looks for. `-s` rather than BUILD_WITH_STRIP:
  # cmake's strip step would call `zig objcopy`, which cannot strip.
  mkRuntime = { name, triple, system, processor, extraCmakeFlags ? [ ], ... }@t: dest: {
    inherit name;
    script = ''
      echo "==> txiki ${version} for ${name} (${triple})"
      flags="-Wno-date-time -ffile-prefix-map=$PWD=txiki.js"
      cmake -S . -B "out/${name}" -G Ninja \
        -DCMAKE_TOOLCHAIN_FILE=${toolchainFile name t} \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_WITH_FFI=OFF -DBUILD_WITH_WASM=OFF -DBUILD_WITH_SQLITE=ON \
        -DBUILD_WITH_GC_SECTIONS=ON -DMI_NO_OPT_ARCH=ON \
        "-DCMAKE_C_FLAGS=$flags" "-DCMAKE_CXX_FLAGS=$flags" \
        -DCMAKE_EXE_LINKER_FLAGS=-s \
        ${lib.escapeShellArgs extraCmakeFlags}
      cmake --build "out/${name}" --target tjs-cli
      install -Dm755 "out/${name}/tjs${exeSuffix t}" "${dest}"
    '';
  };

  # The builds run side by side: most of each one's time is cmake's configure
  # checks, which are serial, and zig's cache is safe to share between them.
  # Each log is printed whole once its build has finished.
  mkRuntimes = { pname, builds, meta, passthru ? { } }: stdenvNoCC.mkDerivation {
    inherit pname version src meta passthru;
    # git because txiki's configure step applies its own mbedtls and lws
    # patches with `git apply`.
    nativeBuildInputs = [ cmake ninja gitMinimal ];
    dontUseCmakeConfigure = true;

    buildPhase = ''
      runHook preBuild
      ${zigCacheEnv}
      pids=()
      ${lib.concatMapStrings (b: ''
        (
          set -e
          ${b.script}
        ) > "$TMPDIR/${b.name}.log" 2>&1 &
        pids+=("$!:${b.name}")
      '') builds}
      failed=
      for entry in "''${pids[@]}"; do
        name=''${entry#*:}
        status=0
        wait "''${entry%%:*}" || status=$?
        cat "$TMPDIR/$name.log"
        if [ "$status" != 0 ]; then
          failed="$failed $name"
        fi
      done
      if [ -n "$failed" ]; then
        echo "failed:$failed" >&2
        exit 1
      fi
      runHook postBuild
    '';

    dontInstall = true;

    # A path under the build root left in an executable means the prefix map
    # missed a file, and the bytes then depend on where the build ran.
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      for f in $(find "$out" -type f); do
        n=$(grep -a -c "$NIX_BUILD_TOP" "$f" || true)
        if [ "$n" != 0 ]; then
          echo "$f: $n lines contain $NIX_BUILD_TOP" >&2
          exit 1
        fi
      done
      runHook postInstallCheck
    '';

    # Nothing to fix up for the build host: none of these run against its
    # libraries, and strip would rewrite foreign-format executables.
    dontFixup = true;
  };

  runtimes = mkRuntimes {
    pname = "tjs-runtimes";
    builds = lib.mapAttrsToList
      (name: t: mkRuntime (t // { inherit name; }) "$out/${fileName name t}")
      targets;
    meta = {
      description = "txiki.js runtimes for every todou CLI target, cross-compiled with zig";
      homepage = "https://github.com/saghul/txiki.js";
      license = lib.licenses.mit;
      platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
    };
    passthru.tests = tests;
  };

  host = mkRuntimes {
    pname = "tjs";
    builds = [ (mkRuntime (hostTarget // { name = hostTargetName; }) "$out/bin/tjs") ];
    meta = {
      description = "txiki.js for this host, built the same way as tjs-runtimes";
      homepage = "https://github.com/saghul/txiki.js";
      license = lib.licenses.mit;
      mainProgram = "tjs";
      platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
    };
  };

  # The program a todou executable is, in miniature: the network and sqlite
  # paths that could touch TJS_HOME, compiled the way the CLI is.
  standaloneProbe = writeText "probe.js" ''
    import { Database } from 'tjs:sqlite';

    const server = tjs.serve({ port: 0, listenIp: '127.0.0.1', fetch: () => new Response('pong') });
    const body = await (await fetch(`http://127.0.0.1:''${server.port}/`)).text();
    await server.close();

    const db = new Database(':memory:');
    const [ row ] = db.prepare('select 40 + 2 as n').all();
    db.close();

    if (body !== 'pong' || row.n !== 42) {
        console.error(`probe got body=''${body} n=''${row.n}`);
        tjs.exit(1);
    }
    console.log('ok');
  '';

  tests = {
    version = runCommand "tjs-test-version" { } ''
      export HOME="$PWD/home" && mkdir -p "$HOME"
      got=$(${host}/bin/tjs --version)
      if [ "$got" != "v${version}" ]; then
        echo "tjs --version printed '$got', want 'v${version}'" >&2
        exit 1
      fi
      got=$(${host}/bin/tjs eval 'console.log(JSON.stringify(tjs.engine.features))')
      if [ "$got" != '{"wasm":false,"sqlite":true}' ]; then
        echo "tjs.engine.features is $got" >&2
        exit 1
      fi
      touch $out
    '';

    formats = runCommand "tjs-test-formats" { nativeBuildInputs = [ file ]; } (''
      failed=0
    '' + lib.concatStrings (lib.mapAttrsToList
      (name: t: ''
        got=$(file -b ${runtimes}/${fileName name t})
        echo "${fileName name t}: $got"
        if ! printf '%s\n' "$got" | grep -qE ${lib.escapeShellArg t.file}; then
          echo "  does not match ${lib.escapeShellArg t.file}" >&2
          failed=1
        fi
      '')
      targets) + ''
      [ "$failed" = 0 ]
      touch $out
    '');

    # The devshell's tjs and the one packed into the executables come from two
    # derivations; this is what says they are the same bytes.
    host-matches-runtimes = runCommand "tjs-test-host-matches-runtimes" { } ''
      cmp ${host}/bin/tjs ${runtimes}/${fileName hostTargetName hostTarget}
      touch $out
    '';

    # `tjs compile` itself goes through the CLI path, which creates its home
    # as before, so it gets a HOME of its own. That it does create one there
    # is asserted too: it shows the emptiness check below can fail.
    standalone-home = runCommand "tjs-test-standalone-home" { } ''
      mkdir compile-home run-home
      cp ${standaloneProbe} probe.js
      HOME="$PWD/compile-home" ${host}/bin/tjs compile probe.js probe
      if [ ! -d compile-home/.tjs ]; then
        echo "tjs compile no longer creates ~/.tjs; the check below proves nothing" >&2
        exit 1
      fi
      got=$(HOME="$PWD/run-home" ./probe)
      if [ "$got" != ok ]; then
        echo "probe printed '$got'" >&2
        exit 1
      fi
      if [ -n "$(ls -A run-home)" ]; then
        echo "the standalone probe left this in HOME:" >&2
        ls -lA run-home >&2
        exit 1
      fi
      touch $out
    '';
  };
in
{
  inherit src runtimes host tests;
}
