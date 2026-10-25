import { notFound } from "next/navigation";

// Any path under /observatory/presenter other than the scene itself is this bare not-found page, not the site's 404 (which links home).
export default function PresenterUnknown() {
  notFound();
}
