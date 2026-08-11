import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/system-schema.ts",
  out: "./drizzle/system",
});
