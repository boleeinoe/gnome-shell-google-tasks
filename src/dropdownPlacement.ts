// Where a dropdown goes relative to the control that opens it. Pure, so it
// runs under `bun test`; dropdownPanel.ts applies it.

export interface Rect { x: number; y: number; width: number; height: number }

// 'stretch': as wide as the anchor, left edges lined up (the task-list
// picker under its header button). 'end': its natural width, right edges
// lined up (the color picker under its color button).
export type DropdownAlign = 'stretch' | 'end';

export interface DropdownPlacement {
  x: number;
  y: number;
  width: number;
  // Opens downward from the anchor (false: flipped above it, no room below).
  below: boolean;
}

export function dropdownWidth(anchorWidth: number, naturalWidth: number, align: DropdownAlign): number {
  return Math.round(align === 'stretch' ? anchorWidth : naturalWidth);
}

export function placeDropdown(anchor: Rect, width: number, height: number, area: Rect, align: DropdownAlign, gap: number): DropdownPlacement {
  let x = align === 'stretch' ? anchor.x : anchor.x + anchor.width - width;
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  const belowY = anchor.y + anchor.height + gap;
  const aboveY = anchor.y - gap - height;
  // Below when it fits, or when above doesn't fit either.
  const below = belowY + height <= area.y + area.height || aboveY < area.y;
  return { x: Math.round(x), y: Math.round(below ? belowY : aboveY), width: Math.round(width), below };
}
