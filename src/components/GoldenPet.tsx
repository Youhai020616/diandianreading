import React, { useEffect, useRef } from "react";
import keleSpriteUrl from "../assets/kele-pet.webp";

/**
 * 伴读小金毛（可乐 / 点点）精灵动画组件。
 * 源精灵图：8 列 x 8 行，格子比例 192:256（底部 208 为狗身，顶部 48 为跳跃预留头顶空间）。
 * 逐帧仅修改 DOM backgroundPosition，零 React 重渲染，支持 prefers-reduced-motion。
 */
const COLS = 8;
const ROWS = 8;
const CELL_W = 192;
const CELL_H = 256;
const BODY_H = 208;

export type GoldenPetState =
  | "idle"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "run-right"
  | "run-left";

const ANIMATIONS: Record<GoldenPetState, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  waving: { row: 1, durations: [140, 140, 140, 280] },
  jumping: { row: 2, durations: [140, 140, 140, 140, 280] },
  failed: { row: 3, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 4, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 5, durations: [120, 120, 120, 120, 120, 220] },
  "run-right": { row: 6, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "run-left": { row: 7, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
};

interface GoldenPetProps {
  state: GoldenPetState;
  repeat?: number;
  onEnd?: () => void;
  height?: number;
  className?: string;
}

export const GoldenPet: React.FC<GoldenPetProps> = ({
  state,
  repeat,
  onEnd,
  height = 96,
  className,
}) => {
  const spriteRef = useRef<HTMLDivElement | null>(null);
  const onEndRef = useRef(onEnd);

  useEffect(() => {
    onEndRef.current = onEnd;
  });

  useEffect(() => {
    const el = spriteRef.current;
    if (!el) return;
    const { row, durations } = ANIMATIONS[state];
    const paint = (frame: number) => {
      el.style.backgroundPosition = `${(frame / (COLS - 1)) * 100}% ${(row / (ROWS - 1)) * 100}%`;
    };
    paint(0);

    let timer: ReturnType<typeof setTimeout>;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (repeat !== undefined) {
        const total = durations.reduce((acc, ms) => acc + ms, 0) * repeat;
        timer = setTimeout(() => onEndRef.current?.(), total);
      }
      return () => clearTimeout(timer);
    }

    let frame = 0;
    let loops = 0;
    const tick = () => {
      timer = setTimeout(() => {
        frame += 1;
        if (frame >= durations.length) {
          frame = 0;
          loops += 1;
          if (repeat !== undefined && loops >= repeat) {
            onEndRef.current?.();
            return;
          }
        }
        paint(frame);
        tick();
      }, durations[frame] ?? 140);
    };
    tick();
    return () => clearTimeout(timer);
  }, [state, repeat]);

  const width = Math.round((height * CELL_W) / BODY_H);
  const spriteHeight = Math.round((height * CELL_H) / BODY_H);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        flexShrink: 0,
        userSelect: "none",
        width,
        height,
      }}
      aria-hidden="true"
    >
      <div
        ref={spriteRef}
        style={{
          pointerEvents: "none",
          position: "absolute",
          bottom: 0,
          left: 0,
          width: "100%",
          height: spriteHeight,
          backgroundImage: `url(${keleSpriteUrl})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${COLS * 100}% ${ROWS * 100}%`,
        }}
      />
    </div>
  );
};
