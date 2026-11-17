export type DiagramResult =
  | { ok: true }
  | { ok: false; message: string; line: number | null };

export type DiagramParser = (sources: string[]) => Promise<DiagramResult[]>;
