import { Switch as KSwitch } from "@kobalte/core/switch";
import { type JSX, splitProps } from "solid-js";
import { cn } from "../../lib/cn";

interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  class?: string;
  disabled?: boolean;
}

export function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, [
    "checked",
    "onChange",
    "label",
    "class",
    "disabled",
  ]);

  return (
    <KSwitch
      class={cn("inline-flex items-center gap-2", local.class)}
      checked={local.checked}
      onChange={local.onChange}
      disabled={local.disabled}
    >
      <KSwitch.Input />
      <KSwitch.Control
        class={cn(
          "inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200",
          "bg-[rgb(var(--color-border))] data-[checked]:bg-[rgb(var(--color-primary))]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-primary))] focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <KSwitch.Thumb
          class={cn(
            "pointer-events-none block h-5 w-5 rounded-full bg-white shadow-md ring-0 transition-transform duration-200",
            "data-[checked]:translate-x-5 translate-x-0"
          )}
        />
      </KSwitch.Control>
      {local.label && (
        <KSwitch.Label class="text-sm font-display font-medium select-none">
          {local.label}
        </KSwitch.Label>
      )}
    </KSwitch>
  );
}
