// No link back to the site: this is rendered inside a recorded or streamed frame.
export default function PresenterNotFound() {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink p-8 text-center text-ghost" data-presenter="not-found">
      <p className="max-w-xl text-lg">There is nothing at this address.</p>
    </div>
  );
}
