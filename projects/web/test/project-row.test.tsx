import { describe, expect, it } from "vitest";
import {
  ProjectRow,
  type ProjectRowProject,
} from "../src/components/shared/project-row.tsx";
import { matchProject } from "../src/lib/project-match.ts";
import { render } from "./render.tsx";

const homelab: ProjectRowProject = {
  name: "Homelab",
  slug: "homelab",
  prefix: "CH",
};
/** Same project, before anyone claimed a prefix for it. */
const bare: ProjectRowProject = { ...homelab, prefix: null };

function row(project: ProjectRowProject, query: string | null) {
  const match = query === null ? null : matchProject(project, query);
  const { container } = render(
    <div>
      <ProjectRow project={project} match={match} />
    </div>,
  );
  return container;
}

/** The trailing spelling token — the last span of the row. */
function token(container: HTMLElement): string {
  const spans = container.querySelectorAll(":scope > div > span");
  return spans[spans.length - 1]?.textContent ?? "";
}

const marks = (container: HTMLElement) =>
  [...container.querySelectorAll("mark")].map((m) => m.textContent);

describe("a project row's trailing spelling token", () => {
  it("is the REF, written bare, where the project has one", () => {
    const text = token(row(homelab, null));
    expect(text).toBe("CH");
    // The hyphen belongs to a card number (`CH-12`), not to the project.
    expect(text).not.toContain("-");
  });

  it("is the slug where the project has no REF", () => {
    expect(token(row(bare, null))).toBe("homelab");
  });

  it("is there under an empty query, unpainted", () => {
    const container = row(homelab, null);
    expect(token(container)).toBe("CH");
    expect(marks(container)).toEqual([]);
  });
});

describe("what a project row paints, and where", () => {
  it("marks the REF in the token when the REF is why the row is here", () => {
    const container = row(homelab, "CH");
    expect(marks(container)).toEqual(["CH"]);
    expect(token(container)).toBe("CH");
  });

  it("spells the slug out after the name when the slug is the reason", () => {
    // A name that genuinely does not carry the query, so the hit can only be
    // the slug.
    const project = { name: "Casa", slug: "homelab", prefix: "CH" };
    const container = row(project, "mel");
    expect(container.textContent).toContain("homelab");
    expect(marks(container)).toEqual(["mel"]);
    // The segment explains why the row is here; the token still identifies
    // the project, and for this one that is the REF.
    expect(token(container)).toBe("CH");
  });

  it("adds no slug segment when the name is the reason", () => {
    const container = row(homelab, "omel");
    expect(marks(container)).toEqual(["omel"]);
    expect(token(container)).toBe("CH");
    // "Homelab" only, not "Homelab homelab".
    expect(container.textContent).toBe("HomelabCH");
  });

  it("marks the token itself rather than printing the slug twice", () => {
    // No REF, so the token already *is* the slug; a separate segment would
    // put the same word on the row twice.
    const container = row(bare, "mel");
    expect(marks(container)).toEqual(["mel"]);
    expect(container.textContent).toBe("Homelabhomelab");
  });
});
