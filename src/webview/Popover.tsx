import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export function Popover({
  open,
  onClose,
  align = "left",
  wide,
  trigger,
  children,
}: {
  open: boolean;
  onClose: () => void;
  align?: "left" | "right";
  wide?: boolean;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) {
      return;
    }
    const rect = wrapRef.current.getBoundingClientRect();
    const width = wide ? Math.max(280, rect.width) : Math.max(220, rect.width);
    let left = align === "right" ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setStyle({
      position: "fixed",
      left,
      width,
      bottom: window.innerHeight - rect.top + 4,
      top: "auto",
      maxHeight: Math.min(280, Math.max(80, rect.top - 8)),
      zIndex: 100,
    });
  }, [open, align, wide]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className="menu-wrap" ref={wrapRef}>
      {trigger}
      {open ? (
        <div ref={menuRef} className={`menu ${wide ? "wide" : ""}`} style={style}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
