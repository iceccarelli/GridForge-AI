"use client";

// The presenter's own error state: no link, no button, no way out of the scene. The site-wide Observatory error page offers the
// qualifier and a retry, which must never appear in a recorded or streamed frame.
export default function PresenterError() {
  return (
    <div role="alert" className="fixed inset-0 z-[100] flex items-center justify-center bg-ink p-8 text-center text-ghost" data-presenter="error">
      <p className="max-w-xl text-lg">The presentation could not be shown.</p>
    </div>
  );
}
