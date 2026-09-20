import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initializeRuntime, queryClient } from "@/api/queries.ts";
import { router } from "@/router.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  // Select the read adapter and stream owner together before any observer
  // mounts. The runtime resolves this even when the worker needs fallback.
  void initializeRuntime().then(() => {
    createRoot(root).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
}
