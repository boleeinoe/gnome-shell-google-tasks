import { describe, expect, it } from 'bun:test';
import { dropdownWidth, placeDropdown } from '../src/dropdownPlacement.js';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe('dropdown placement', () => {
  it('the list picker is as wide as its button, left edges lined up, right under it', () => {
    const button = { x: 300, y: 100, width: 380, height: 32 };
    const width = dropdownWidth(button.width, 200, 'stretch');
    const place = placeDropdown(button, width, 120, screen, 'stretch', 4);
    expect(place).toEqual({ x: 300, y: 136, width: 380, below: true });
  });

  it('the color picker keeps its width and lines its right edge up with the button', () => {
    const button = { x: 600, y: 300, width: 24, height: 24 };
    const width = dropdownWidth(button.width, 250, 'end');
    const place = placeDropdown(button, width, 160, screen, 'end', 4);
    expect(place.width).toBe(250);
    expect(place.x + place.width).toBe(button.x + button.width);
    expect(place.y).toBe(328);
  });

  it('flips above the button when there is no room below', () => {
    const button = { x: 600, y: 1000, width: 24, height: 24 };
    const place = placeDropdown(button, 250, 160, screen, 'end', 4);
    expect(place.below).toBe(false);
    expect(place.y + 160).toBe(button.y - 4);
  });

  it('stays below when it fits neither way', () => {
    const tiny = { x: 0, y: 0, width: 800, height: 200 };
    expect(placeDropdown({ x: 10, y: 80, width: 24, height: 24 }, 250, 400, tiny, 'end', 4).below).toBe(true);
  });

  it('is kept inside the work area horizontally', () => {
    expect(placeDropdown({ x: 100, y: 100, width: 24, height: 24 }, 250, 100, screen, 'end', 4).x).toBe(0);
    expect(placeDropdown({ x: 1800, y: 100, width: 380, height: 32 }, 380, 100, screen, 'stretch', 4).x).toBe(1920 - 380);
  });
});
