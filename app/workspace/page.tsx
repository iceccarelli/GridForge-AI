import type { Metadata } from "next";
import { WorkspaceClient } from "./WorkspaceClient";

export const metadata: Metadata = {
  title: "Workspace",
  description:
    "The Time to Power engineering workspace: scope a hall, see what binds first, the headroom " +
    "ladder and time to power, every number traced to a real GridForge engine call.",
  robots: { index: false, follow: false },
};

export default function WorkspacePage() {
  return <WorkspaceClient />;
}
