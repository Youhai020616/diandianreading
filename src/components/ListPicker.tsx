import React, { useEffect, useId, useRef, useState } from "react";
import { IconCheck, IconChevronDown, IconSearch } from "./Icons";
import "./ListPicker.css";

export interface ListPickerItem {
  id: string;
  title: string;
  meta: string;
  /** Extra text matched by the search box, such as author or tags. */
  keywords?: string;
}

interface ListPickerProps {
  items: ListPickerItem[];
  activeId: string | null;
  label: string;
  icon: React.ReactNode;
  searchPlaceholder: string;
  onSelect(id: string): void;
}

const SEARCH_THRESHOLD = 6;

/** Compact switcher for a growing collection: the page keeps its content, the full list lives in a popover. */
export const ListPicker: React.FC<ListPickerProps> = ({ items, activeId, label, icon, searchPlaceholder, onSelect }) => {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const searchable = items.length >= SEARCH_THRESHOLD;
  const term = query.trim().toLowerCase();
  const visible = term
    ? items.filter(item => `${item.title}\n${item.meta}\n${item.keywords ?? ""}`.toLowerCase().includes(term))
    : items;

  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== "open") {
        setQuery("");
        return;
      }
      if (search.current) search.current.focus();
      else element.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    };
    element.addEventListener("toggle", onToggle);
    return () => element.removeEventListener("toggle", onToggle);
  }, []);

  function choose(id: string) {
    menu.current?.hidePopover();
    if (id !== activeId) onSelect(id);
  }

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    if (!options.length) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown"
      ? (current + 1) % options.length
      : current <= 0 ? options.length - 1 : current - 1;
    options[next]!.focus();
  }

  return (
    <>
      <button type="button" className="list-picker-trigger" popoverTarget={menuId} aria-haspopup="listbox" title={`切换：${label}`}>
        {icon}
        <span>{label}</span>
        <span className="list-picker-count">{items.length}</span>
        <IconChevronDown size={13} />
      </button>
      <div id={menuId} ref={menu} popover="auto" className="list-picker-menu" onKeyDown={moveFocus}>
        {searchable && (
          <div className="list-picker-search">
            <IconSearch size={13} />
            <input
              ref={search}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && visible[0]) {
                  e.preventDefault();
                  choose(visible[0].id);
                }
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </div>
        )}
        <div className="list-picker-list" role="listbox" aria-label={label}>
          {visible.map(item => {
            const active = item.id === activeId;
            return (
              <button key={item.id} type="button" role="option" aria-selected={active}
                className={`list-picker-option${active ? " active" : ""}`} onClick={() => choose(item.id)} title={item.title}>
                <span className="list-picker-option-text">
                  <span className="list-picker-option-title">{item.title}</span>
                  {item.meta && <span className="list-picker-option-meta">{item.meta}</span>}
                </span>
                {active && <IconCheck size={14} />}
              </button>
            );
          })}
          {!visible.length && <div className="list-picker-empty">没有匹配的结果</div>}
        </div>
      </div>
    </>
  );
};
