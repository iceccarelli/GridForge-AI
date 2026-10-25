export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-24 pt-28 sm:px-6" role="status" aria-label="Loading the observatory">
      <div className="h-4 w-40 rounded bg-panel-2" />
      <div className="mt-4 h-10 w-full max-w-xl rounded bg-panel-2" />
      <div className="mt-10 h-[460px] rounded-xl border border-line bg-panel md:h-[700px] lg:h-[760px]" />
    </div>
  );
}
