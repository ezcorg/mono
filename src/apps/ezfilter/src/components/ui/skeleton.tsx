import { type JSX, splitProps } from "solid-js";
import { cn } from "../../lib/cn";

export function Skeleton(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={cn(
        "animate-pulse rounded-2xl bg-[rgb(var(--color-border))]",
        local.class
      )}
      {...rest}
    />
  );
}
