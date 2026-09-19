import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { parse } from "@babel/parser";
import type * as t from "@babel/types";

export type Source = { file: string; text: string };
export type Site = {
  id: string;
  file: string;
  line: number;
  kind: "switch" | "mapping" | "read";
  guarded: boolean;
  evidence: string;
};

type Entry = { node: t.Node; parents: t.Node[]; source: Source };
type Binding = Entry & { name: string; scope: t.Node };
type Mapping = Entry & { name: string; record: boolean };

export function readSources(root: string): Source[] {
  function walk(directory: string): string[] {
    return readdirSync(join(root, directory), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const file = `${directory}/${entry.name}`;
        return entry.isDirectory()
          ? walk(file)
          : /\.tsx?$/.test(file) && !file.endsWith(".d.ts")
            ? [file]
            : [];
      });
  }
  return ["shared", "web", "cli", "server"].flatMap((project) =>
    walk(`projects/${project}/src`).map((file) => ({
      file,
      text: readFileSync(join(root, file), "utf8"),
    })),
  );
}

function isNode(value: unknown): value is t.Node {
  return value !== null && typeof value === "object" && "type" in value;
}

function walk(
  node: t.Node,
  visit: (entry: Entry) => void,
  source: Source,
  parents: t.Node[] = [],
): void {
  visit({ node, parents, source });
  for (const [key, value] of Object.entries(node)) {
    if (
      [
        "loc",
        "comments",
        "tokens",
        "leadingComments",
        "trailingComments",
        "innerComments",
      ].includes(key)
    )
      continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child)) walk(child, visit, source, [node, ...parents]);
    }
  }
}

function unwrap(node: t.Node): t.Node {
  while (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression" ||
    node.type === "ParenthesizedExpression"
  )
    node = node.expression;
  return node;
}

function text(entry: Entry, node = entry.node): string {
  return entry.source.text
    .slice(node.start ?? 0, node.end ?? 0)
    .replace(/\s+/g, " ")
    .trim();
}

function scope(parents: t.Node[]): t.Node {
  const found = parents.find(
    (node) =>
      node.type === "Program" ||
      node.type === "BlockStatement" ||
      /Function|Method/.test(node.type),
  );
  if (!found) throw new Error("AST binding has no lexical scope");
  return found;
}

function containsRecord(node: t.Node | null | undefined): boolean {
  if (!node) return false;
  if (
    node.type === "TSTypeReference" &&
    node.typeName.type === "Identifier" &&
    node.typeName.name === "Record"
  )
    return true;
  return Object.values(node).some((value) =>
    (Array.isArray(value) ? value : [value]).some(
      (child) => isNode(child) && containsRecord(child),
    ),
  );
}

function fixedObject(node: t.Node): node is t.ObjectExpression {
  return (
    node.type === "ObjectExpression" &&
    node.properties.some(
      (property) =>
        property.type !== "SpreadElement" &&
        (!property.computed ||
          property.key.type === "StringLiteral" ||
          property.key.type === "NumericLiteral"),
    )
  );
}

/** Syntax census, not a taint/type checker. Provenance lives in DECLARED. */
export function scanSources(sources: Source[]): Site[] {
  const entries: Entry[] = [];
  const bindings: Binding[] = [];
  const modules = new Map<string, t.Program>();
  const byNode = new Map<t.Node, Entry>();
  for (const source of sources) {
    const ast = parse(source.text, {
      sourceType: "module",
      plugins: [
        "typescript",
        ...(source.file.endsWith(".tsx") ? ["jsx" as const] : []),
      ],
    });
    modules.set(source.file, ast.program);
    walk(
      ast.program,
      (entry) => {
        entries.push(entry);
        byNode.set(entry.node, entry);
        const { node, parents } = entry;
        if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
          bindings.push({
            ...entry,
            name: node.id.name,
            scope: scope(parents),
          });
        if (node.type === "ImportSpecifier")
          bindings.push({
            ...entry,
            name: node.local.name,
            scope: ast.program,
          });
        // Parameters shadow module-level maps; never attribute their reads to that map.
        if (/Function|Method/.test(node.type) && "params" in node) {
          for (const parameter of node.params) {
            if (parameter.type === "Identifier")
              bindings.push({
                ...entry,
                node: parameter,
                name: parameter.name,
                scope: node,
              });
          }
        }
      },
      source,
    );
  }
  // Preserve Array.find's first-binding behavior, including duplicate names.
  // Scope nodes belong to a single source file, so their identity also scopes
  // the file: a lookup never needs to search bindings from unrelated modules.
  const byScope = new Map<t.Node, Map<string, Binding>>();
  const byDeclaration = new Map<t.Node, Binding>();
  for (const binding of bindings) {
    let names = byScope.get(binding.scope);
    if (!names) {
      names = new Map();
      byScope.set(binding.scope, names);
    }
    if (!names.has(binding.name)) names.set(binding.name, binding);
    if (!byDeclaration.has(binding.node))
      byDeclaration.set(binding.node, binding);
  }

  function findBinding(name: string, entry: Entry): Binding | undefined {
    for (const parent of [entry.node, ...entry.parents]) {
      const found = byScope.get(parent)?.get(name);
      if (found) return found;
    }
    return undefined;
  }

  function resolveModule(from: string, specifier: string): string | undefined {
    const base =
      specifier === "@todou/shared"
        ? "projects/shared/src/index.ts"
        : specifier.startsWith("@/")
          ? `projects/web/src/${specifier.slice(2)}`
          : specifier.startsWith(".")
            ? normalize(join(dirname(from), specifier))
            : undefined;
    if (!base) return undefined;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (file) => modules.has(file),
    );
  }

  function findExport(
    file: string,
    name: string,
    seen: Set<string>,
  ): Binding | undefined {
    const key = `${file}:${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const program = modules.get(file);
    if (!program) return undefined;
    for (const statement of program.body) {
      if (statement.type === "ExportAllDeclaration") {
        const target = resolveModule(file, statement.source.value);
        const result = target && findExport(target, name, seen);
        if (result) return result;
      }
      if (statement.type !== "ExportNamedDeclaration") continue;
      if (statement.declaration?.type === "VariableDeclaration") {
        const declaration = statement.declaration.declarations.find(
          (declaration) =>
            declaration.id.type === "Identifier" &&
            declaration.id.name === name,
        );
        if (declaration) return byDeclaration.get(declaration);
      }
      for (const specifier of statement.specifiers) {
        if (
          specifier.type !== "ExportSpecifier" ||
          (specifier.exported.type === "Identifier"
            ? specifier.exported.name
            : specifier.exported.value) !== name
        )
          continue;
        const local = specifier.local.name;
        if (statement.source) {
          const target = resolveModule(file, statement.source.value);
          if (target) return findExport(target, local, seen);
        } else {
          return byScope.get(program)?.get(local);
        }
      }
    }
    return undefined;
  }

  // Cache only complete top-level traversals. A recursive miss may depend on
  // the current cycle-detection set and must not poison another import's lookup.
  const exportedResults = new Map<string, Binding | undefined>();
  function exported(file: string, name: string): Binding | undefined {
    const key = `${file}:${name}`;
    if (exportedResults.has(key)) return exportedResults.get(key);
    const result = findExport(file, name, new Set());
    exportedResults.set(key, result);
    return result;
  }

  function resolve(
    node: t.Node,
    entry: Entry,
    seen = new Set<t.Node>(),
  ): Entry | undefined {
    node = unwrap(node);
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (fixedObject(node)) return byNode.get(node);
    if (node.type !== "Identifier") return undefined;
    const binding = findBinding(node.name, entry);
    if (!binding) return undefined;
    if (binding.node.type === "VariableDeclarator" && binding.node.init)
      return resolve(binding.node.init, binding, seen);
    if (binding.node.type === "ImportSpecifier") {
      const declaration = binding.parents.find(
        (parent) => parent.type === "ImportDeclaration",
      );
      if (declaration?.type !== "ImportDeclaration") return undefined;
      const file = resolveModule(binding.source.file, declaration.source.value);
      const imported = binding.node.imported;
      const target = file
        ? exported(
            file,
            imported.type === "Identifier" ? imported.name : imported.value,
          )
        : undefined;
      if (target?.node.type === "VariableDeclarator" && target.node.init)
        return resolve(target.node.init, target, seen);
    }
    return undefined;
  }

  const mappings = new Map<t.Node, Mapping>();
  function mapping(object: Entry): Mapping {
    const existing = mappings.get(object.node);
    if (existing) return existing;
    const declaration = object.parents.find(
      (parent) =>
        parent.type === "VariableDeclarator" &&
        parent.init &&
        unwrap(parent.init) === object.node,
    );
    const name =
      declaration?.type === "VariableDeclarator" &&
      declaration.id.type === "Identifier"
        ? declaration.id.name
        : `<inline:${text(object).slice(0, 100)}>`;
    const record =
      (declaration?.type === "VariableDeclarator" &&
        declaration.id.type === "Identifier" &&
        containsRecord(declaration.id.typeAnnotation)) ||
      object.parents
        .slice(0, 2)
        .some(
          (parent) =>
            (parent.type === "TSAsExpression" ||
              parent.type === "TSSatisfiesExpression") &&
            containsRecord(parent.typeAnnotation),
        );
    const result = { ...object, name, record };
    mappings.set(object.node, result);
    return result;
  }
  for (const entry of entries) {
    if (!fixedObject(entry.node)) continue;
    const parent = entry.parents.find(
      (node) =>
        node.type === "VariableDeclarator" &&
        node.init &&
        unwrap(node.init) === entry.node,
    );
    if (
      (parent?.type === "VariableDeclarator" &&
        parent.id.type === "Identifier" &&
        containsRecord(parent.id.typeAnnotation)) ||
      entry.parents.some(
        (node) =>
          (node.type === "TSAsExpression" ||
            node.type === "TSSatisfiesExpression") &&
          unwrap(node) === entry.node &&
          containsRecord(node.typeAnnotation),
      )
    )
      mapping(entry);
  }

  const sites: Site[] = [];
  const counts = new Map<string, number>();
  const used = new Set<t.Node>();
  function add(
    entry: Entry,
    kind: Site["kind"],
    label: string,
    guarded: boolean,
    evidence: string,
  ): void {
    const base = `${entry.source.file} :: ${kind} ${label}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    sites.push({
      id: `${base} #${count}`,
      file: entry.source.file,
      line: entry.node.loc?.start.line ?? 0,
      kind,
      guarded,
      evidence,
    });
  }

  function trustedLookup(entry: Entry): boolean {
    const node = entry.node;
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "Identifier" ||
      (node.arguments.length !== 3 && node.arguments.length !== 4)
    )
      return false;
    const binding = findBinding(node.callee.name, entry);
    if (binding?.node.type !== "ImportSpecifier") return false;
    const imported = binding.node.imported;
    const declaration = binding.parents.find(
      (parent) => parent.type === "ImportDeclaration",
    );
    return (
      (imported.type === "Identifier" ? imported.name : imported.value) ===
        "enumLookup" &&
      declaration?.type === "ImportDeclaration" &&
      (declaration.source.value === "@todou/shared" ||
        resolveModule(entry.source.file, declaration.source.value) ===
          "projects/shared/src/enum-fallback.ts") &&
      node.arguments.every(
        (argument) =>
          argument.type !== "SpreadElement" &&
          argument.type !== "ArgumentPlaceholder",
      )
    );
  }

  function ownCheck(
    node: t.Node,
    object: t.Node,
    property: t.Node,
    entry: Entry,
  ): boolean {
    node = unwrap(node);
    if (
      node.type !== "CallExpression" ||
      node.callee.type !== "MemberExpression" ||
      node.callee.computed ||
      node.callee.object.type !== "Identifier" ||
      node.callee.object.name !== "Object" ||
      node.callee.property.type !== "Identifier" ||
      node.callee.property.name !== "hasOwn"
    )
      return false;
    const [map, key] = node.arguments;
    return (
      !!map &&
      !!key &&
      text(entry, map) === text(entry, object) &&
      text(entry, key) === text(entry, property)
    );
  }

  function literalDomain(test: t.Node, key: t.Node, entry: Entry): boolean {
    if (test.type === "LogicalExpression" && test.operator === "||")
      return (
        literalDomain(test.left, key, entry) &&
        literalDomain(test.right, key, entry)
      );
    return (
      test.type === "BinaryExpression" &&
      test.operator === "===" &&
      text(entry, test.left) === text(entry, key) &&
      (test.right.type === "StringLiteral" ||
        test.right.type === "NumericLiteral")
    );
  }

  function guardedRead(
    entry: Entry,
    node: t.MemberExpression | t.OptionalMemberExpression,
  ): string | undefined {
    if (
      node.property.type === "StringLiteral" ||
      node.property.type === "NumericLiteral"
    )
      return "literal key";
    let child: t.Node = node;
    for (const parent of entry.parents) {
      if (
        parent.type === "TSAsExpression" ||
        parent.type === "TSNonNullExpression" ||
        parent.type === "ParenthesizedExpression"
      ) {
        child = parent;
        continue;
      }
      if (
        parent.type === "LogicalExpression" &&
        parent.left === child &&
        (parent.operator === "??" || parent.operator === "||")
      )
        return `${parent.operator} fallback on this read`;
      break;
    }
    child = node;
    for (const parent of entry.parents) {
      if (/Function|Method/.test(parent.type)) break;
      if (
        parent.type === "ConditionalExpression" &&
        parent.consequent === child &&
        ownCheck(parent.test, node.object, node.property, entry)
      )
        return "matching Object.hasOwn conditional";
      if (
        parent.type === "IfStatement" &&
        parent.consequent === child &&
        ownCheck(parent.test, node.object, node.property, entry)
      )
        return "matching Object.hasOwn branch";
      if (
        parent.type === "IfStatement" &&
        parent.consequent === child &&
        literalDomain(parent.test, node.property, entry)
      )
        return "explicit literal-domain branch";
      child = parent;
    }
    return undefined;
  }

  for (const entry of entries) {
    const node = entry.node;
    if (node.type === "SwitchStatement") {
      const branch = node.cases.find((branch) => branch.test === null);
      add(
        entry,
        "switch",
        text(entry, node.discriminant),
        !!branch?.consequent.length,
        branch
          ? "explicit default branch"
          : "no default; requires provenance declaration",
      );
    }
    if (trustedLookup(entry) && node.type === "CallExpression") {
      const argument = node.arguments[0];
      const object = argument && resolve(argument, entry);
      if (object) {
        mapping(object);
        used.add(object.node);
      }
    }
    if (
      (node.type !== "MemberExpression" &&
        node.type !== "OptionalMemberExpression") ||
      !node.computed
    )
      continue;
    const object = resolve(node.object, entry);
    if (!object) continue;
    const owner = mapping(object);
    used.add(owner.node);
    const parent = entry.parents[0];
    if (
      parent?.type === "AssignmentExpression" &&
      parent.left === node &&
      parent.operator === "="
    )
      continue;
    const protection = guardedRead(entry, node);
    add(
      entry,
      "read",
      text(entry),
      !!protection,
      `${owner.source.file}:${owner.name}; ${protection ?? "unprotected read"}`,
    );
  }
  for (const owner of mappings.values()) {
    add(
      owner,
      "mapping",
      owner.name,
      used.has(owner.node),
      used.has(owner.node)
        ? "consumers inventoried individually (or explicit enumLookup consumer)"
        : "fixed-key Record without a resolved lookup; declare its non-dispatch purpose",
    );
  }
  return sites.sort((a, b) => a.id.localeCompare(b.id));
}

/** Both directions matter: exceptions expire when the unsafe shape disappears. */
export function declarationErrors(
  sites: Site[],
  declared: Readonly<Record<string, string>>,
): string[] {
  const unsafe = new Set(
    sites.filter((site) => !site.guarded).map((site) => site.id),
  );
  return [
    ...sites
      .filter((site) => !site.guarded && !Object.hasOwn(declared, site.id))
      .map((site) => `UNDECLARED ${site.id} (${site.line}): ${site.evidence}`),
    ...Object.keys(declared)
      .filter((id) => !unsafe.has(id))
      .map((id) => `STALE declaration: ${id}`),
    ...Object.entries(declared)
      .filter(([, reason]) => reason.trim().length < 30)
      .map(([id]) => `Missing provenance: ${id}`),
  ];
}
