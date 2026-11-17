// Parses the diagrams given as a JSON array in argv[2] through the source
// loader, the path `node src/index.ts` takes, and prints the results as JSON.
import { loadDiagramParser } from "../../src/mermaid/parser.ts";

const sources = JSON.parse(process.argv[2] ?? "[]") as string[];
const parse = await loadDiagramParser();
process.stdout.write(JSON.stringify(await parse(sources)));
