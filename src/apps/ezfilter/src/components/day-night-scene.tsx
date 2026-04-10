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
    </div>
  );
}
