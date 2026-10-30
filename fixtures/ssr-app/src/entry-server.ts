// Server entry for the build-time pre-renderer (`prerender.server`): the same
// route table and head defaults the browser uses.
export { head, routes } from "./routes";
export const routerOptions = { trailingSlash: "ignore" as const };
