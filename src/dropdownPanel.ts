// A dropdown that opens right at the control it belongs to, with a short
// reveal animation: the task-list picker (as wide as the header button,
// left edges lined up) and the color picker (right edge lined up with the
// color button). Takes its modal grab the way PopupMenuManager does — on the
// panel's own actor — so a click outside or Escape closes it; placed and
// animated here rather than by a BoxPointer, whose arrow margins put popups
// dozens of pixels off their control.

import type { DropdownAlign } from './dropdownPlacement.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { dropdownWidth, placeDropdown } from './dropdownPlacement.js';

export interface DropdownPanelOptions {
  anchor: St.Widget;
  align: DropdownAlign;
  styleClass: string;
  // Runs once the content is shown (styled, still transparent), right
  // before it is measured: the last moment to adjust its size.
  onBeforeOpen?: () => void;
  // What gets keyboard focus on open; default: the first focusable child.
  focus?: () => Clutter.Actor | null;
  onOpenChanged?: (open: boolean) => void;
}

const GAP_PX = 4;
const OPEN_MS = 180;
export const DROPDOWN_CLOSE_MS = 120;

export class DropdownPanel {
  // Clips the content while it unrolls; lives in Main.uiGroup, over the
  // calendar popup.
  readonly actor: St.Widget;
  // The visible panel: background, padding and whatever is put in it.
  readonly content: St.BoxLayout;
  isOpen = false;

  private _options: DropdownPanelOptions;
  // The modal grab while open. It has to be on this.actor: a grab delivers
  // pointer events only to the grabbed actor's subtree, and the panel lives
  // in Main.uiGroup, outside the section — grabbing the section left the
  // items with no hover and no clicks.
  private _grab: Clutter.Grab | null = null;
  private _mappedId = 0;
  private _animating = false;
  private _below = true;
  private _width = 0;
  private _destroyed = false;

  constructor(options: DropdownPanelOptions) {
    this._options = options;
    this.actor = new St.Widget({
      layout_manager: new Clutter.FixedLayout(),
      clip_to_allocation: true,
      reactive: true,
      visible: false,
    });
    this.content = new St.BoxLayout({ style_class: options.styleClass, orientation: Clutter.Orientation.VERTICAL });
    this.actor.add_child(this.content);
    Main.uiGroup.add_child(this.actor);
    // Arrow keys and Tab move between the panel's controls.
    (globalThis as any).global.focus_manager.add_group(this.content);

    // While grabbed, a press outside the panel is delivered here too: it
    // closes the panel (and goes no further, so pressing the control that
    // opened it doesn't reopen it). Escape closes it as well.
    this.actor.connect('captured-event', (_actor: Clutter.Actor, event: Clutter.Event) => {
      if (!this.isOpen)
        return Clutter.EVENT_PROPAGATE;
      const type = event.type();
      if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
        const target = (globalThis as any).global.stage.get_event_actor(event) as Clutter.Actor | null;
        if (!target || !this.actor.contains(target)) {
          this.close();
          return Clutter.EVENT_STOP;
        }
      }
      else if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
        this.close();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // The calendar popup it hangs from was closed: go with it.
    this._mappedId = options.anchor.connect('notify::mapped', () => {
      if (!options.anchor.mapped)
        this.close(false);
    });
    options.anchor.connect('destroy', () => {
      this._mappedId = 0;
    });

    // Content that changes size while open (the color editor unfolding)
    // is kept in place, flipped above the control if it no longer fits.
    this.content.connect('notify::height', () => {
      if (this.isOpen && !this._animating)
        this._place();
    });
  }

  toggle() {
    if (this.isOpen)
      this.close();
    else
      this.open();
  }

  open() {
    if (this.isOpen || this._destroyed || !this._options.anchor.mapped)
      return;

    this.actor.remove_all_transitions();
    this.actor.set_height(-1);
    this.actor.opacity = 0;
    this.actor.show();
    Main.uiGroup.set_child_above_sibling(this.actor, null);
    this._options.onBeforeOpen?.();

    const [, , anchorWidth] = this._anchorRect();
    this.content.set_width(-1);
    const width = dropdownWidth(anchorWidth, this.content.get_preferred_width(-1)[1], this._options.align);
    this._width = width;
    this.content.set_width(width);
    const { y, height } = this._place();

    this._grab = Main.pushModal(this.actor, { actionMode: Shell.ActionMode.POPUP });
    this.isOpen = true;
    const focus = this._options.focus?.();
    if (focus)
      focus.grab_key_focus();
    else
      this.content.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);

    // Unrolls from the control: downward, or upward when flipped above it.
    this._animating = true;
    this.actor.set_height(0);
    if (!this._below)
      this.actor.y = y + height;
    this.actor.ease({
      height,
      y,
      opacity: 255,
      duration: OPEN_MS,
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      onComplete: () => {
        this._animating = false;
        // Back to natural height, so later size changes reflow.
        if (this.isOpen)
          this.actor.set_height(-1);
      },
    });
    this._options.onOpenChanged?.(true);
  }

  close(animate = true) {
    if (!this.isOpen)
      return;
    this.isOpen = false;
    // Gives key focus back to where it was before opening.
    if (this._grab) {
      Main.popModal(this._grab);
      this._grab = null;
    }
    // May destroy this panel (a re-render tearing its row down).
    this._options.onOpenChanged?.(false);
    if (this._destroyed)
      return;

    this.actor.remove_all_transitions();
    this._animating = false;
    if (!animate) {
      this.actor.hide();
      this.actor.set_height(-1);
      return;
    }
    const height = this.actor.height;
    this.actor.set_height(height);
    this.actor.ease({
      height: 0,
      y: this._below ? this.actor.y : this.actor.y + height,
      opacity: 0,
      duration: DROPDOWN_CLOSE_MS,
      mode: Clutter.AnimationMode.EASE_IN_CUBIC,
      onComplete: () => {
        this.actor.hide();
        this.actor.set_height(-1);
      },
    });
  }

  destroy() {
    if (this._destroyed)
      return;
    this.close(false);
    if (this._destroyed)
      return;
    this._destroyed = true;
    if (this._mappedId)
      this._options.anchor.disconnect(this._mappedId);
    this._mappedId = 0;
    this.actor.remove_all_transitions();
    this.actor.destroy();
  }

  // The anchor in stage coordinates (Main.uiGroup sits at the stage origin).
  private _anchorRect(): [number, number, number, number] {
    const [x, y] = this._options.anchor.get_transformed_position();
    const [width, height] = this._options.anchor.get_transformed_size();
    return [x, y, width, height];
  }

  // Positions the panel for the content's current size; returns where.
  private _place(): { y: number; height: number } {
    const [ax, ay, aw, ah] = this._anchorRect();
    const width = this._width;
    const height = Math.ceil(this.content.get_preferred_height(width)[1]);
    const monitor = Main.layoutManager.findIndexForActor(this._options.anchor);
    const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
    const scale = St.ThemeContext.get_for_stage((globalThis as any).global.stage).scale_factor;
    const place = placeDropdown(
      { x: ax, y: ay, width: aw, height: ah },
      width,
      height,
      { x: area.x, y: area.y, width: area.width, height: area.height },
      this._options.align,
      GAP_PX * scale,
    );
    this._below = place.below;
    this.actor.set_position(place.x, place.y);
    this.actor.set_width(width);
    return { y: place.y, height };
  }
}
