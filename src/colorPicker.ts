// The task color picker shown in a row's color popup. Laid out like the
// pickers of open-source design tools (Penpot, GTK's color chooser):
//
//   1. preset swatches first — one click, the common case — with a "+"
//      that opens the custom editor (GTK's "+", Penpot's color field);
//   2. the custom editor: a saturation/value field, a hue strip and a HEX
//      entry, for any color the presets don't cover;
//   3. opacity last, applying to whichever color is picked: a slider for
//      broad changes and a 0-100 entry for an exact value (Calcite's
//      "sliders for broad changes, inputs for precise ones"), plus "Auto"
//      to go back to following the block.
//
// Changes preview live through onChange; the caller decides when to save.

import type { ColorSpec, Hsv } from './colorSpec.js';
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import { clampPercent, colorSpecHex, hexToHsv, hsvToHex, hsvToRgb, normalizeHex } from './colorSpec.js';

export interface ColorPickerStrings {
  // Accessible names of the presets, by palette id ('none' included).
  swatches: Readonly<Record<string, string>>;
  custom: string;
  opacity: string;
  auto: string;
}

export interface ColorPickerOptions {
  // Preset ids in display order, 'none' first.
  palette: readonly string[];
  paletteHex: Readonly<Record<string, string>>;
  strings: ColorPickerStrings;
  // The color the row has now, or null for none.
  initial: ColorSpec | null;
  // Opacity, in percent, that "Auto" stands for.
  defaultOpacity: number;
  onChange: (spec: ColorSpec | null) => void;
  // Lets the caller give the entries the panel's usual clipboard handling.
  setupEntry?: (entry: St.Entry) => void;
}

const KEY_STEP = 0.02;
const HUE_KEY_STEP = 2;

export class ColorPicker {
  readonly actor: St.BoxLayout;
  // Set once the user changed anything, so merely opening and closing the
  // picker never writes a color (an inherited one, for instance).
  changed = false;

  private _options: ColorPickerOptions;
  // Palette id, '#rrggbb', or null for no color.
  private _color: string | null;
  // Explicit opacity, or undefined to follow the default.
  private _opacity: number | undefined;
  private _hsv: Hsv;
  private _syncing = false;

  private _swatches = new Map<string, St.Button>();
  private _customSwatch: St.Button;
  private _customDot: St.Widget;
  private _editorButton: St.Button;
  private _editor: St.BoxLayout;
  private _field: St.DrawingArea;
  private _hue: St.DrawingArea;
  private _hexEntry: St.Entry;
  private _opacityBox: St.BoxLayout;
  private _autoButton: St.Button;
  private _slider: Slider;
  private _opacityEntry: St.Entry;

  constructor(options: ColorPickerOptions) {
    this._options = options;
    this._color = options.initial?.color ?? null;
    this._opacity = options.initial?.opacity;
    const startHex = options.initial ? colorSpecHex(options.initial, options.paletteHex) : undefined;
    this._hsv = hexToHsv(startHex ?? options.paletteHex[options.palette.find(id => id !== 'none') ?? ''] ?? '#808080');

    this.actor = new St.BoxLayout({ style_class: 'google-tasks-color-picker', orientation: Clutter.Orientation.VERTICAL });

    // 1. Presets, the custom color in use (if any) and the editor toggle.
    const swatchRow = new St.BoxLayout({ style_class: 'google-tasks-color-swatches' });
    for (const id of options.palette) {
      const button = this._makeSwatch(new St.Widget({ style_class: `task-color-dot task-color-dot-${id}` }), options.strings.swatches[id] ?? id);
      button.connect('clicked', () => {
        this._color = id === 'none' ? null : id;
        if (this._color)
          this._hsv = hexToHsv(options.paletteHex[id]);
        this._commit();
      });
      this._swatches.set(id, button);
      swatchRow.add_child(button);
    }
    this._customDot = new St.Widget({ style_class: 'task-color-dot' });
    this._customSwatch = this._makeSwatch(this._customDot, options.strings.custom);
    this._customSwatch.connect('clicked', () => this._setEditorOpen(!this._editor.visible));
    swatchRow.add_child(this._customSwatch);

    this._editorButton = new St.Button({
      style_class: 'google-tasks-color-swatch google-tasks-color-add',
      can_focus: true,
      toggle_mode: true,
      accessible_name: options.strings.custom,
      child: new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 12 }),
    });
    this._editorButton.connect('clicked', () => this._setEditorOpen(this._editorButton.checked));
    swatchRow.add_child(this._editorButton);
    this.actor.add_child(swatchRow);

    // 2. Custom editor.
    this._editor = new St.BoxLayout({ style_class: 'google-tasks-color-editor', orientation: Clutter.Orientation.VERTICAL, visible: false });
    this._field = new St.DrawingArea({ style_class: 'google-tasks-color-field', reactive: true, can_focus: true });
    this._field.connect('repaint', () => this._paintField());
    this._makeDraggable(this._field, (fx, fy) => {
      this._hsv = { ...this._hsv, s: fx, v: 1 - fy };
      this._pickCustom();
    });
    this._field.connect('key-press-event', (_actor: any, event: Clutter.Event) => this._onFieldKey(event));
    this._editor.add_child(this._field);

    this._hue = new St.DrawingArea({ style_class: 'google-tasks-color-hue', reactive: true, can_focus: true });
    this._hue.connect('repaint', () => this._paintHue());
    this._makeDraggable(this._hue, (fx) => {
      this._hsv = { ...this._hsv, h: Math.min(359.9, fx * 360) };
      this._pickCustom();
    });
    this._hue.connect('key-press-event', (_actor: any, event: Clutter.Event) => this._onHueKey(event));
    this._editor.add_child(this._hue);

    const hexRow = new St.BoxLayout({ style_class: 'google-tasks-color-row' });
    hexRow.add_child(new St.Label({ text: 'HEX', style_class: 'google-tasks-color-caption', y_align: Clutter.ActorAlign.CENTER }));
    this._hexEntry = new St.Entry({ style_class: 'google-tasks-color-entry google-tasks-color-hex', can_focus: true, x_expand: true });
    // Entries apply on Enter and on losing focus — closing the menu takes
    // the focus too, so an unchanged value must not count as an edit (a
    // preset would silently turn into the same custom hex).
    this._connectEntry(this._hexEntry, () => {
      const hex = normalizeHex(this._hexEntry.get_text());
      if (hex && hex !== this._currentHex()) {
        this._hsv = hexToHsv(hex);
        this._color = hex;
        this._commit();
      }
      else {
        this._sync();
      }
    });
    hexRow.add_child(this._hexEntry);
    this._editor.add_child(hexRow);
    this.actor.add_child(this._editor);

    // 3. Opacity.
    this._opacityBox = new St.BoxLayout({ style_class: 'google-tasks-color-opacity', orientation: Clutter.Orientation.VERTICAL });
    const opacityHeader = new St.BoxLayout({ style_class: 'google-tasks-color-row' });
    opacityHeader.add_child(new St.Label({ text: options.strings.opacity, style_class: 'google-tasks-color-caption', x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
    this._autoButton = new St.Button({
      style_class: 'google-tasks-color-auto',
      label: options.strings.auto,
      can_focus: true,
      toggle_mode: true,
    });
    this._autoButton.connect('clicked', () => {
      this._opacity = this._autoButton.checked ? undefined : this._shownOpacity();
      this._commit();
    });
    opacityHeader.add_child(this._autoButton);
    this._opacityBox.add_child(opacityHeader);

    const opacityRow = new St.BoxLayout({ style_class: 'google-tasks-color-row' });
    this._slider = new Slider(this._shownOpacity() / 100);
    this._slider.x_expand = true;
    this._slider.y_align = Clutter.ActorAlign.CENTER;
    this._slider.accessible_name = options.strings.opacity;
    this._slider.connect('notify::value', () => {
      if (this._syncing)
        return;
      this._opacity = clampPercent(this._slider.value * 100);
      this._commit();
    });
    opacityRow.add_child(this._slider);
    this._opacityEntry = new St.Entry({ style_class: 'google-tasks-color-entry google-tasks-color-percent', can_focus: true });
    this._connectEntry(this._opacityEntry, () => {
      const text = this._opacityEntry.get_text().replace('%', '').trim();
      if (/^\d{1,3}$/.test(text) && clampPercent(Number(text)) !== this._shownOpacity()) {
        this._opacity = clampPercent(Number(text));
        this._commit();
      }
      else {
        this._sync();
      }
    });
    opacityRow.add_child(this._opacityEntry);
    opacityRow.add_child(new St.Label({ text: '%', style_class: 'google-tasks-color-caption', y_align: Clutter.ActorAlign.CENTER }));
    this._opacityBox.add_child(opacityRow);
    this.actor.add_child(this._opacityBox);

    this._setEditorOpen(this._color?.startsWith('#') ?? false);
    this._sync();
  }

  // The picked color, or null for none.
  get spec(): ColorSpec | null {
    if (!this._color)
      return null;
    return this._opacity === undefined ? { color: this._color } : { color: this._color, opacity: this._opacity };
  }

  // The hex the picked color paints with (or the editor's, with no color).
  private _currentHex(): string {
    const hex = this._color ? colorSpecHex({ color: this._color }, this._options.paletteHex) : undefined;
    return hex ?? hsvToHex(this._hsv);
  }

  private _shownOpacity(): number {
    return this._opacity ?? clampPercent(this._options.defaultOpacity);
  }

  private _makeSwatch(dot: St.Widget, name: string): St.Button {
    dot.y_align = Clutter.ActorAlign.CENTER;
    return new St.Button({
      style_class: 'google-tasks-color-swatch',
      can_focus: true,
      accessible_name: name,
      child: dot,
    });
  }

  private _setEditorOpen(open: boolean) {
    this._editor.visible = open;
    this._editorButton.checked = open;
  }

  // An edit in the field or hue strip: the color becomes a custom one.
  private _pickCustom() {
    this._color = hsvToHex(this._hsv);
    this._commit();
  }

  private _commit() {
    this.changed = true;
    this._sync();
    this._options.onChange(this.spec);
  }

  // Brings every control in line with the current state.
  private _sync() {
    this._syncing = true;
    try {
      for (const [id, button] of this._swatches)
        button.checked = (this._color ?? 'none') === id;

      const custom = this._color?.startsWith('#') ? this._color : null;
      this._customSwatch.visible = custom !== null;
      this._customSwatch.checked = custom !== null;
      this._customDot.set_style(custom ? `background-color: ${custom};` : null);

      if (!this._hexEntry.clutter_text.has_key_focus())
        this._hexEntry.set_text(this._currentHex().toUpperCase());
      this._field.queue_repaint();
      this._hue.queue_repaint();

      // Opacity only means something for a color.
      this._opacityBox.reactive = this._color !== null;
      this._opacityBox.opacity = this._color !== null ? 255 : 110;
      this._slider.reactive = this._color !== null;
      this._autoButton.checked = this._opacity === undefined;
      const shown = this._shownOpacity();
      this._slider.value = shown / 100;
      if (!this._opacityEntry.clutter_text.has_key_focus())
        this._opacityEntry.set_text(String(shown));
    }
    finally {
      this._syncing = false;
    }
  }

  private _connectEntry(entry: St.Entry, apply: () => void) {
    this._options.setupEntry?.(entry);
    const text = entry.clutter_text as any;
    text.connect('activate', () => apply());
    text.connect('key-focus-out', () => apply());
  }

  // Press, drag (with a grab, so leaving the area keeps tracking) and
  // release, reported as 0-1 fractions of the area.
  private _makeDraggable(area: St.DrawingArea, onPoint: (fx: number, fy: number) => void) {
    let grab: { dismiss: () => void } | null = null;
    const report = (event: Clutter.Event) => {
      const [stageX, stageY] = event.get_coords();
      const [ok, x, y] = area.transform_stage_point(stageX, stageY);
      const [width, height] = area.get_size();
      if (!ok || width <= 0 || height <= 0)
        return;
      onPoint(Math.max(0, Math.min(1, x / width)), Math.max(0, Math.min(1, y / height)));
    };
    const release = () => {
      grab?.dismiss();
      grab = null;
    };
    area.connect('button-press-event', (_actor: any, event: Clutter.Event) => {
      release();
      grab = (globalThis as any).global.stage.grab(area);
      area.grab_key_focus();
      report(event);
      return Clutter.EVENT_STOP;
    });
    area.connect('motion-event', (_actor: any, event: Clutter.Event) => {
      if (!grab)
        return Clutter.EVENT_PROPAGATE;
      report(event);
      return Clutter.EVENT_STOP;
    });
    area.connect('button-release-event', () => {
      const had = grab !== null;
      release();
      return had ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    });
    area.connect('destroy', release);
  }

  private _onFieldKey(event: Clutter.Event) {
    const step: Record<number, [number, number]> = {
      [Clutter.KEY_Left]: [-KEY_STEP, 0],
      [Clutter.KEY_Right]: [KEY_STEP, 0],
      [Clutter.KEY_Up]: [0, KEY_STEP],
      [Clutter.KEY_Down]: [0, -KEY_STEP],
    };
    const delta = step[event.get_key_symbol()];
    if (!delta)
      return Clutter.EVENT_PROPAGATE;
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    this._hsv = { ...this._hsv, s: clamp(this._hsv.s + delta[0]), v: clamp(this._hsv.v + delta[1]) };
    this._pickCustom();
    return Clutter.EVENT_STOP;
  }

  private _onHueKey(event: Clutter.Event) {
    const key = event.get_key_symbol();
    const delta = key === Clutter.KEY_Left ? -HUE_KEY_STEP : key === Clutter.KEY_Right ? HUE_KEY_STEP : 0;
    if (!delta)
      return Clutter.EVENT_PROPAGATE;
    this._hsv = { ...this._hsv, h: (this._hsv.h + delta + 360) % 360 };
    this._pickCustom();
    return Clutter.EVENT_STOP;
  }

  // Saturation left to right, value top to bottom, at the current hue.
  private _paintField() {
    const cr = this._field.get_context();
    const [width, height] = this._field.get_surface_size();
    const [r, g, b] = hsvToRgb({ h: this._hsv.h, s: 1, v: 1 });
    cr.setSourceRGBA(r, g, b, 1);
    cr.rectangle(0, 0, width, height);
    cr.fill();

    const white = new Cairo.LinearGradient(0, 0, width, 0);
    white.addColorStopRGBA(0, 1, 1, 1, 1);
    white.addColorStopRGBA(1, 1, 1, 1, 0);
    cr.setSource(white);
    cr.rectangle(0, 0, width, height);
    cr.fill();

    const black = new Cairo.LinearGradient(0, 0, 0, height);
    black.addColorStopRGBA(0, 0, 0, 0, 0);
    black.addColorStopRGBA(1, 0, 0, 0, 1);
    cr.setSource(black);
    cr.rectangle(0, 0, width, height);
    cr.fill();

    this._paintRing(cr, this._hsv.s * width, (1 - this._hsv.v) * height);
    cr.$dispose();
  }

  private _paintHue() {
    const cr = this._hue.get_context();
    const [width, height] = this._hue.get_surface_size();
    const strip = new Cairo.LinearGradient(0, 0, width, 0);
    for (let step = 0; step <= 6; step++) {
      const [r, g, b] = hsvToRgb({ h: step * 60, s: 1, v: 1 });
      strip.addColorStopRGBA(step / 6, r, g, b, 1);
    }
    cr.setSource(strip);
    cr.rectangle(0, 0, width, height);
    cr.fill();

    this._paintRing(cr, (this._hsv.h / 360) * width, height / 2);
    cr.$dispose();
  }

  // A white ring with a dark outline: visible on any color.
  private _paintRing(cr: any, x: number, y: number) {
    cr.setLineWidth(3);
    cr.setSourceRGBA(0, 0, 0, 0.45);
    cr.arc(x, y, 6, 0, 2 * Math.PI);
    cr.stroke();
    cr.setLineWidth(2);
    cr.setSourceRGBA(1, 1, 1, 1);
    cr.arc(x, y, 6, 0, 2 * Math.PI);
    cr.stroke();
  }
}
