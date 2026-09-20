import { TodouClient } from "@todou/shared";
import { deferred } from "./deferred.ts";
import { ResourceRuntime } from "./runtime.ts";
import { type RuntimePort, RuntimeSessionHost } from "./session.ts";
import { RuntimeWatch } from "./watch.ts";

// This module's imported graph is deliberately independent of the page API,
// React, QueryClient and DOM. Vite emits it as a real module worker asset.
const scope = globalThis as unknown as {
  location: Location;
  onconnect: ((event: MessageEvent) => void) | null;
};
const apiMount = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
let host: RuntimeSessionHost;
let watch: RuntimeWatch;
const client = new TodouClient({
  baseUrl: `${scope.location.origin}${apiMount.slice(0, -4)}`,
  batch: true,
  onCanonicalSlug: (requested, canonical) => {
    if (canonical !== null) host?.canonicalSlug(requested, canonical);
  },
});
const runtime = new ResourceRuntime({
  network: (resource, signal) => {
    if (resource.apiMount !== apiMount)
      return Promise.reject(new Error("Resource API mount mismatch"));
    const physical = deferred<void>();
    const promise = client
      .withContext({ signal, onTransportSettled: physical.resolve })
      .request("GET", resource.path, { query: resource.query });
    return { promise, transportSettled: physical.promise };
  },
  onError: (error) => {
    if ((error as { status?: number })?.status === 401) host?.unauthorized();
  },
});
host = new RuntimeSessionHost({
  runtime,
  apiMount,
  pageOrigin: scope.location.origin,
  buildId: __TODOU_VERSION__,
  onlineIdentity: (signal) => client.withContext({ signal }).me(),
  onDemand: (demand) => watch?.setDemand(demand),
});
watch = new RuntimeWatch({
  runtime,
  url: client.userEventsUrl({ inbox: true, metadata: "*" }),
  onFrame: (frame) => host.frame(frame),
  onUnauthorized: () => host.unauthorized(),
});
scope.onconnect = (event) => {
  for (const port of event.ports) host.attach(port as RuntimePort);
};
