import { type JSX, splitProps } from "solid-js";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-3 py-0.5 text-xs font-bold font-display transition-colors",
  {
    variants: {
      variant: {
        default: "bg-[rgb(var(--color-primary))] text-white",
        secondary:
          "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] border border-[rgb(var(--color-border))]",
        success: "bg-[rgb(var(--color-success))]/20 text-[rgb(var(--color-success))]",
        accent: "bg-[rgb(var(--color-accent))]/20 text-[rgb(var(--color-accent))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export type BadgeProps = JSX.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export function Badge(props: BadgeProps) {
  const [local, rest] = splitProps(props, ["class", "variant"]);
  return (
    <span
      class={cn(badgeVariants({ variant: local.variant }), local.class)}
      {...rest}
    />
  );
}
