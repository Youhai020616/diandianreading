import React, { useEffect, useId, useRef, useState } from "react";
import { IconChevronDown } from "./Icons";
import "./ActionMenu.css";

export interface ActionMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** When set, the first click asks for confirmation with this label and the second click runs the action. */
  confirmLabel?: string;
  onSelect(): void;
}

interface ActionMenuProps {
  items: ActionMenuItem[];
  /** Visible trigger text; omit for an icon-only trigger. */
  label?: string;
  icon?: React.ReactNode;
  ariaLabel: string;
  triggerClassName?: string;
  align?: "start" | "end";
}

/** Groups secondary actions behind one button so the primary action stays obvious. */
export const ActionMenu: React.FC<ActionMenuProps> = ({
  items, label, icon, ariaLabel, triggerClassName = "btn sm", align = "end",
}) => {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== "open") setArmed(null);
      else element.querySelector<HTMLButtonElement>("button:enabled")?.focus();
    };
    element.addEventListener("toggle", onToggle);
    return () => element.removeEventListener("toggle", onToggle);
  }, []);

  function run(item: ActionMenuItem) {
    if (item.confirmLabel && armed !== item.key) {
      setArmed(item.key);
      return;
    }
    menu.current?.hidePopover();
    item.onSelect();
  }

  return (
    <>
      <button type="button" className={triggerClassName} popoverTarget={menuId} aria-haspopup="menu"
        aria-label={ariaLabel} title={label ? undefined : ariaLabel}>
        {icon}
        {label && <span>{label}</span>}
        {label && <IconChevronDown size={12} />}
      </button>
      <div id={menuId} ref={menu} popover="auto" role="menu" aria-label={ariaLabel}
        className={`action-menu action-menu-${align}`}>
        {items.map(item => {
          const confirming = armed === item.key;
          return (
            <button key={item.key} type="button" role="menuitem" disabled={item.disabled}
              className={`action-menu-item${item.danger ? " danger" : ""}${confirming ? " confirming" : ""}`}
              onClick={() => run(item)}>
              {item.icon}
              <span>{confirming ? item.confirmLabel : item.label}</span>
            </button>
          );
        })}
      </div>
    </>
  );
};
