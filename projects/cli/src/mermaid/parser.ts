import { loadPayload } from "#mermaid-loader";
import type { DiagramParser } from "./types.ts";

let loading: Promise<DiagramParser> | undefined;

/**
 * mermaid's parser, loaded on first use and kept for the process. Costs
 * about 300 ms from the embedded payload and 450 ms from source, which is
 * why nothing calls this unless a body actually holds a diagram.
 */
export function loadDiagramParser(): Promise<DiagramParser> {
  loading ??= loadPayload();
  return loading;
}
