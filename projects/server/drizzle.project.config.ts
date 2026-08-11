import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/project-schema.ts",
  out: "./drizzle/project",
});
