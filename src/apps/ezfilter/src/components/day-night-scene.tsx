export function DayNightScene() {
  return (
    <div
      class="pointer-events-none fixed inset-0 overflow-hidden z-0 select-none"
      style={{ width: "100vw", height: "100vh" }}
    >
      <img
        src="/cozy.svg"
        alt=""
        aria-hidden="true"
        style={{ width: "100vw", height: "100vh", "object-fit": "cover" }}
        draggable={false}
      />
      {/* Top scrim — dims the upper portion where text/headers sit */}
      <div
        class="absolute inset-0"
        style={{
          background:
            "linear-gradient(to bottom, rgb(var(--color-bg) / 0.7) 0%, rgb(var(--color-bg) / 0.45) 30%, transparent 55%)",
        }}
      />
      {/* Left edge scrim — dims behind the navbar area */}
      <div
        class="absolute inset-y-0 left-0 w-24 hidden sm:block"
        style={{
          background:
            "linear-gradient(to right, rgb(var(--color-bg) / 0.5), transparent)",
        }}
      />
    </div>
  );
}
