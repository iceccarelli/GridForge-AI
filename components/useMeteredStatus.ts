"use client";

import { useEffect, useState } from "react";
import { getMeteredStatus } from "@/lib/payg-client";

/** "closed" only when the server says free keys and pay-as-you-go are not open here yet; "unknown" until it answers or if it cannot. */
export function useMeteredStatus(): "open" | "closed" | "unknown" {
  const [status, setStatus] = useState<"open" | "closed" | "unknown">("unknown");
  useEffect(() => {
    let live = true;
    void getMeteredStatus().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);
  return status;
}
