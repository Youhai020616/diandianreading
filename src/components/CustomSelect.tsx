import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "./Icons";

export interface CustomSelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

interface CustomSelectProps<T extends string = string> {
  value: T;
  options: Array<CustomSelectOption<T>>;
  onChange: (next: T) => void;
  placeholder?: string;
  size?: "md" | "sm";
  disabled?: boolean;
  style?: React.CSSProperties;
  ariaLabel?: string;
}

interface PopoverCoords {
  top: number;
  left: number;
  width: number;
  openUp: boolean;
}

export function CustomSelect<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = "请选择…",
  size = "md",
  disabled = false,
  style,
  ariaLabel,
}: CustomSelectProps<T>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const estimatedMenuHeight = Math.min(280, options.length * 44 + 16);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow;
    setCoords({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 160) - 8)),
      top: openUp ? rect.top - 6 : rect.bottom + 6,
      width: Math.max(rect.width, 128),
      openUp,
    });
  }, [options.length]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const idx = options.findIndex((o) => o.value === value);
    setHighlightIdx(idx >= 0 ? idx : 0);
  }, [open, updatePosition, options, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (options.length === 0 ? -1 : (i + 1) % options.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (options.length === 0 ? -1 : (i - 1 + options.length) % options.length));
      } else if (e.key === "Enter" && highlightIdx >= 0 && options[highlightIdx]) {
        e.preventDefault();
        onChange(options[highlightIdx].value);
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScrollOrResize = () => updatePosition();

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, options, highlightIdx, onChange, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`cselect-trigger ${size === "sm" ? "sm" : ""} ${open ? "open" : ""}`}
        style={style}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
      >
        {selected?.icon && <span className="cselect-icon">{selected.icon}</span>}
        <span className={`cselect-value ${selected ? "" : "placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="cselect-chevron">
          <IconChevronDown size={14} />
        </span>
      </button>

      {open && coords && createPortal(
        <div
          ref={menuRef}
          className={`cselect-menu ${coords.openUp ? "open-up" : ""}`}
          role="listbox"
          style={{
            left: coords.left,
            top: coords.top,
            minWidth: coords.width,
          }}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isHighlighted = idx === highlightIdx;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`cselect-option ${isSelected ? "selected" : ""} ${isHighlighted ? "highlighted" : ""}`}
                onMouseEnter={() => setHighlightIdx(idx)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                {opt.icon && <span className="cselect-icon">{opt.icon}</span>}
                <div className="cselect-option-text">
                  <span className="cselect-option-label">{opt.label}</span>
                  {opt.description && <span className="cselect-option-desc">{opt.description}</span>}
                </div>
                <span className="cselect-option-check">
                  {isSelected && <IconCheck size={13} />}
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
