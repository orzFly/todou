import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { Attachment } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import {
  StagedFileTray,
  useStagedFiles,
} from "../src/components/issue/staged-files.tsx";
import { testQueryClient } from "./render.tsx";

type Staged = ReturnType<typeof useStagedFiles>;

const file = (name: string) => new File(["bytes"], name, { type: "image/png" });

/** A DataTransfer stand-in: happy-dom has no constructor for one. */
const carrying = (...files: File[]) => ({ files }) as unknown as DataTransfer;

function mount(): { hook: () => Staged } {
  let latest: Staged | null = null;
  function Harness() {
    const staged = useStagedFiles();
    latest = staged;
    return <StagedFileTray staged={staged.staged} onRemove={staged.remove} />;
  }
  render(
    <QueryClientProvider client={testQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  return { hook: () => latest as Staged };
}

describe("staging a file names it once (T-269)", () => {
  it("renames the clipboard default on paste", () => {
    const { hook } = mount();
    act(() => {
      hook().onPaste({
        clipboardData: carrying(file("image.png")),
        preventDefault: () => {},
      });
    });
    expect(hook().staged[0]?.file.name).toMatch(
      /^image-\d{8}-\d{6}-[0-9a-f]{4}\.png$/,
    );
  });

  it("leaves the same file alone when it is dropped", () => {
    const { hook } = mount();
    act(() => {
      hook().onDrop({
        dataTransfer: carrying(file("image.png")),
        preventDefault: () => {},
      });
    });
    expect(hook().staged[0]?.file.name).toBe("image.png");
  });

  it("leaves the same file alone when it comes from the file picker", () => {
    const { hook } = mount();
    act(() => {
      hook().stage([file("image.png")]);
    });
    expect(hook().staged[0]?.file.name).toBe("image.png");
  });

  it("leaves a pasted file that carries a real name alone", () => {
    const { hook } = mount();
    act(() => {
      hook().onPaste({
        clipboardData: carrying(file("report.png")),
        preventDefault: () => {},
      });
    });
    expect(hook().staged[0]?.file.name).toBe("report.png");
  });

  it("shows and links the name the server settled on, not the local one", async () => {
    const stored: Attachment = {
      id: 813,
      filename: "shot-813.png",
      content_type: "text/plain",
      size: 5,
      url: "/api/projects/p/attachments/813/download/shot-813.png",
      uploader: {
        id: 1,
        login: "me",
        display_name: "Me",
        kind: "human",
        avatar_url: null,
        owner: null,
      },
      created_at: "2026-09-05T00:00:00.000Z",
      aliases: [],
    };
    vi.spyOn(api, "uploadAttachment").mockResolvedValue(stored);

    const { hook } = mount();
    act(() => {
      hook().stage([new File(["bytes"], "shot.png", { type: "text/plain" })]);
    });
    let markers: string[] = [];
    await act(async () => {
      markers = await hook().uploadAll("p", 1);
    });

    expect(markers).toEqual([`[shot-813.png](${stored.url})`]);
    expect(screen.getByTitle("shot-813.png")).toBeTruthy();
    expect(screen.queryByTitle("shot.png")).toBeNull();
  });
});
