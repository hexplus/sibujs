// Server entry for the build-time pre-renderer (`prerender.server`): the same
// route table and head defaults the browser uses.
export { head, routes } from "./routes";
export const routerOptions = { trailingSlash: "ignore" as const };
// For a per-request sidecar (examples/static-backends/sidecar): the handler
// comes from this bundle, so it shares one copy of SibuJS with the routes.
export { createRenderHandler } from "sibujs/ssr";
