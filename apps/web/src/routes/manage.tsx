import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";
import { ManagementPage } from "../management/ManagementPage";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/manage",
  component: ManagementPage,
});
