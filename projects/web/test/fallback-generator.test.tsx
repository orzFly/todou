import { act, cleanup, waitFor } from "@testing-library/react";
import { MePrefs } from "@todou/shared";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { AvatarEditor } from "../src/components/shared/avatar-editor.tsx";
import {
  ProjectIcon,
  projectIconFallback,
} from "../src/components/shared/project-icon.tsx";
import { UserAvatar } from "../src/components/shared/user-chip.tsx";
import { projectTint } from "../src/lib/project-tint.ts";
import { renderWithClient, testQueryClient } from "./render.tsx";

afterEach(cleanup);

const project = { slug: "todou", name: "todou", prefix: "TDU" };
const person = { login: "alice", display_name: "Alice Liddell" };

/** Mounts `ui` against a prefs cache the test can rewrite while it is up. */
function mount(ui: ReactElement, prefs?: Partial<MePrefs>) {
  const client = testQueryClient();
  if (prefs) {
    client.setQueryData(prefsQuery.queryKey, MePrefs.parse(prefs));
  }
  const view = renderWithClient(ui, client);
  const set = (next: Partial<MePrefs>) =>
    act(async () => {
      client.setQueryData(prefsQuery.queryKey, MePrefs.parse(next));
    });
  return { container: view.container, set };
}

/** What one fallback box draws, read off the DOM the generator left. */
function drawn(container: HTMLElement) {
  const fallback = container.querySelector<HTMLElement>(
    '[data-slot="avatar-fallback"]',
  );
  const glyph = fallback?.querySelector("[data-generator]");
  const text = glyph?.querySelector("[data-glyph-text]");
  const textClass = text?.parentElement?.className ?? "";
  return {
    generator: glyph?.getAttribute("data-generator"),
    label: glyph?.getAttribute("aria-label"),
    text: text?.textContent,
    white: textClass.includes("text-white"),
    weight: textClass.match(/\bfont-(medium|semibold)\b/)?.[1],
    stops: [...(glyph?.querySelectorAll("stop") ?? [])].map((stop) =>
      stop.getAttribute("stop-color"),
    ),
    rects: glyph?.querySelectorAll("rect").length,
    fallbackClass: fallback?.className ?? "",
  };
}

function expectMonochrome(glyph: ReturnType<typeof drawn>, text: string) {
  expect(glyph).toMatchObject({
    generator: "monochrome_text",
    text,
    label: text,
    white: false,
    weight: "medium",
    stops: [],
    rects: 0,
  });
  // The theme's square or circle is the box's own, under a background-free
  // glyph that takes the box's colour: the pre-T-544 scheme.
  expect(glyph.fallbackClass).toContain("bg-muted");
  expect(glyph.fallbackClass).toContain("text-muted-foreground");
}

describe("project icon generators (T-555)", () => {
  it("draws the slug's gradient under white text when set to colorful", () => {
    const { container } = mount(<ProjectIcon project={project} />, {
      project_icon_fallback: "colorful_text",
    });
    const { from, to } = projectTint("todou");
    expect(drawn(container)).toMatchObject({
      generator: "colorful_text",
      text: "TDU",
      white: true,
      weight: "semibold",
      stops: [from, to],
      rects: 1,
    });
  });

  it("draws theme-coloured text on the muted square when set to monochrome", () => {
    const { container } = mount(<ProjectIcon project={project} />, {
      project_icon_fallback: "monochrome_text",
    });
    expectMonochrome(drawn(container), "TDU");
  });

  it("is colorful for an account that never chose, and before prefs load", () => {
    for (const prefs of [{}, undefined]) {
      const { container } = mount(<ProjectIcon project={project} />, prefs);
      expect(drawn(container).generator).toBe("colorful_text");
      cleanup();
    }
  });

  it("follows the setting in the settings page's editor too", () => {
    const editor = (
      <AvatarEditor
        subject={{ name: project.name, imageUrl: null }}
        shape="square"
        fallback={projectIconFallback(project)}
        onUpload={() => {}}
        onRemove={() => {}}
        pending={false}
      />
    );
    const { container } = mount(editor, {
      project_icon_fallback: "monochrome_text",
    });
    expectMonochrome(drawn(container), "TDU");
  });

  it("redraws every icon on the page when the setting changes", async () => {
    const { container, set } = mount(
      <>
        <ProjectIcon project={project} />
        <ProjectIcon project={{ slug: "wide", name: "Wide", prefix: "WWW" }} />
      </>,
      { project_icon_fallback: "colorful_text" },
    );
    const generators = () =>
      [...container.querySelectorAll("[data-generator]")].map((glyph) =>
        glyph.getAttribute("data-generator"),
      );
    expect(generators()).toEqual(["colorful_text", "colorful_text"]);
    expect(container.querySelectorAll("stop")).toHaveLength(4);

    await set({ project_icon_fallback: "monochrome_text" });
    await waitFor(() =>
      expect(generators()).toEqual(["monochrome_text", "monochrome_text"]),
    );
    expect(container.querySelectorAll("stop, rect")).toHaveLength(0);

    await set({ project_icon_fallback: "colorful_text" });
    await waitFor(() =>
      expect(generators()).toEqual(["colorful_text", "colorful_text"]),
    );
    expect(container.querySelectorAll("stop")).toHaveLength(4);
  });
});

describe("user avatar generators (T-555)", () => {
  it("draws initials in the same scaled glyph, monochrome", () => {
    const { container } = mount(<UserAvatar user={person} />, {});
    expectMonochrome(drawn(container), "AL");
  });

  it("stays monochrome whatever projects are set to", async () => {
    const { container, set } = mount(
      <>
        <UserAvatar user={person} />
        <ProjectIcon project={project} />
      </>,
      { project_icon_fallback: "colorful_text" },
    );
    const generators = () =>
      [...container.querySelectorAll("[data-generator]")].map((glyph) =>
        glyph.getAttribute("data-generator"),
      );
    expect(generators()).toEqual(["monochrome_text", "colorful_text"]);
    await set({ project_icon_fallback: "monochrome_text" });
    await waitFor(() =>
      expect(generators()).toEqual(["monochrome_text", "monochrome_text"]),
    );
  });

  it("draws the profile page's editor with the same generator", () => {
    const { container } = mount(
      <AvatarEditor
        subject={{ name: person.display_name, imageUrl: null }}
        onUpload={() => {}}
        onRemove={() => {}}
        pending={false}
      />,
      {},
    );
    expectMonochrome(drawn(container), "AL");
  });
});
