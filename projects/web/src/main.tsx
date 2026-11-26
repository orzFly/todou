// First, so the app's stylesheet is in <head> before the theme store
// appends its rule: the two tie on specificity and the later one wins.
import "./styles.css";
import { ThemeProvider } from "@orz/ui/theme";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "@/api/queries.ts";
import { themeStore } from "@/lib/theme-store.ts";
import { router } from "@/router.tsx";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider store={themeStore}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
