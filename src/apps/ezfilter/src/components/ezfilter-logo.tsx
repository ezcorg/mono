import { cn } from "../lib/cn";

interface EzfilterLogoProps {
  /** Tailwind text size class, e.g. "text-4xl" or "text-7xl" */
  size?: string;
  class?: string;
}

/**
 * The ezfilter wordmark with a brushstroke-style square border around "ez".
 * Reusable across the loading screen, setup wizard, and anywhere the brand appears.
 */
export function EzfilterLogo(props: EzfilterLogoProps) {
  const sizeClass = () => props.size ?? "text-4xl";

  return (
    <h1
      class={cn(
        "font-extrabold font-title tracking-tight leading-none",
        sizeClass(),
        props.class,
      )}
    >
      {/* "ez" with brushstroke box — padding creates the border gap, SVG fills the padded area */}
      <span class="relative inline-block px-[0.15em] py-[0.08em]">
        <svg
          class="absolute inset-0 w-full h-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M8 8 Q5 6 12 5 L88 7 Q96 7 93 9"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            opacity="0.7"
          />
          <path
            d="M93 9 Q95 12 94 88 Q94 95 91 93"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            opacity="0.6"
          />
          <path
            d="M91 93 Q88 96 12 94 Q6 94 8 91"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            opacity="0.7"
          />
          <path
            d="M8 91 Q5 88 6 12 Q6 6 8 8"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            opacity="0.6"
          />
        </svg>
        <span class="relative">ez</span>
      </span>
      {/* Small gap between "ez" and "filter" */}
      <span class="ml-[0.05em]">filter</span>
    </h1>
  );
}
