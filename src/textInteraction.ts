// Clipboard, keyboard editing and clickable links for the extension's UI.
//
// None of this comes for free inside a GNOME Shell popup: ClutterText has no
// clipboard key bindings and no edit history, and nothing turns a URL in a task
// title into something clickable. The extension calls enableEntryClipboard() on
// its entries and setupRichLabel() on its labels; everything else lives here.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// GNOME Shell's `global` singleton. Reached through globalThis so this module
// doesn't need an ambient declaration that could clash with @girs types.
const shellGlobal = (globalThis as unknown as { global?: any }).global;

export interface TextStrings {
    copy: string;
    cut: string;
    paste: string;
    selectAll: string;
    openLink: string;
    copyLink: string;
}

export interface ContextMenuItem {
    label: string;
    action: () => void;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

export function copyToClipboard(text: string): void {
    if (!text)
        return;
    const clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    // Also feed the PRIMARY selection, so middle-click paste works the same way
    // it does from any other text on the desktop.
    clipboard.set_text(St.ClipboardType.PRIMARY, text);
}

export function readClipboard(onText: (text: string) => void): void {
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard: any, text: string | null) => {
        if (text)
            onText(text);
    });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
//
// Cyrillic symbols are listed alongside the Latin ones on purpose: with a
// Russian layout active Ctrl+C arrives as Cyrillic_es, not as `c`, so a
// Latin-only check would break the shortcuts for half the supported locales.
// ---------------------------------------------------------------------------

const KEY_COPY = new Set<number>([
    Clutter.KEY_c, Clutter.KEY_C,
    Clutter.KEY_Cyrillic_es ?? 0x6d3, Clutter.KEY_Cyrillic_ES ?? 0x6f3,
    Clutter.KEY_Copy ?? 0x1008ff57,
]);
const KEY_CUT = new Set<number>([
    Clutter.KEY_x, Clutter.KEY_X,
    Clutter.KEY_Cyrillic_che ?? 0x6de, Clutter.KEY_Cyrillic_CHE ?? 0x6fe,
    Clutter.KEY_Cut ?? 0x1008ff58,
]);
const KEY_PASTE = new Set<number>([
    Clutter.KEY_v, Clutter.KEY_V,
    Clutter.KEY_Cyrillic_em ?? 0x6cd, Clutter.KEY_Cyrillic_EM ?? 0x6ed,
    Clutter.KEY_Paste ?? 0x1008ff65,
]);
const KEY_SELECT_ALL = new Set<number>([
    Clutter.KEY_a, Clutter.KEY_A,
    Clutter.KEY_Cyrillic_ef ?? 0x6c6, Clutter.KEY_Cyrillic_EF ?? 0x6e6,
]);
const KEY_UNDO = new Set<number>([
    Clutter.KEY_z, Clutter.KEY_Z,
    Clutter.KEY_Cyrillic_ya ?? 0x6d1, Clutter.KEY_Cyrillic_YA ?? 0x6f1,
    Clutter.KEY_Undo ?? 0x1008ff1a,
]);
const KEY_REDO = new Set<number>([
    Clutter.KEY_y, Clutter.KEY_Y,
    Clutter.KEY_Cyrillic_en ?? 0x6ce, Clutter.KEY_Cyrillic_EN ?? 0x6ee,
    Clutter.KEY_Redo ?? 0x1008ff1b,
]);

function hasCtrl(state: number): boolean {
    return (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
}

function hasShift(state: number): boolean {
    return (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
}

// ---------------------------------------------------------------------------
// Link detection
// ---------------------------------------------------------------------------

export interface LinkRange {
    /** JS string indices, for slicing when building markup. */
    jsStart: number;
    jsEnd: number;
    /** UTF-8 byte offsets, for hit-testing against the Pango layout. */
    byteStart: number;
    byteEnd: number;
    /** The launchable URI (scheme added for bare `www.` / e-mail matches). */
    uri: string;
    /** The text as it appears in the label. */
    text: string;
}

const LINK_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;

// Trailing characters that are almost always sentence punctuation rather than
// part of the address — "see https://example.com/page." shouldn't swallow the
// full stop, and a link inside brackets shouldn't swallow the closing one.
function trimTrailingPunctuation(match: string): string {
    let end = match.length;
    while (end > 0) {
        const ch = match[end - 1];
        if ('.,;:!?"\'`'.includes(ch)) {
            end--;
            continue;
        }
        if (ch === ')' && (match.slice(0, end).match(/\(/g)?.length ?? 0) >= (match.slice(0, end).match(/\)/g)?.length ?? 0)) {
            break;
        }
        if (')]}>'.includes(ch)) {
            end--;
            continue;
        }
        break;
    }
    return match.slice(0, end);
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
    return encoder.encode(text).length;
}

export function toUri(raw: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw))
        return raw;
    if (/^www\./i.test(raw))
        return `https://${raw}`;
    if (raw.includes('@'))
        return `mailto:${raw}`;
    return `https://${raw}`;
}

export function findLinks(text: string): LinkRange[] {
    if (!text)
        return [];

    const links: LinkRange[] = [];
    LINK_RE.lastIndex = 0;

    let match: RegExpExecArray | null = LINK_RE.exec(text);
    while (match !== null) {
        const current = match;
        match = null;
        const trimmed = trimTrailingPunctuation(current[0]);
        if (trimmed.length < 4) {
            match = LINK_RE.exec(text);
            continue;
        }

        const jsStart = current.index;
        const jsEnd = jsStart + trimmed.length;
        const byteStart = byteLength(text.slice(0, jsStart));

        links.push({
            jsStart,
            jsEnd,
            byteStart,
            byteEnd: byteStart + byteLength(trimmed),
            uri: toUri(trimmed),
            text: trimmed,
        });

        match = LINK_RE.exec(text);
    }

    return links;
}

export const DEFAULT_LINK_COLOR = '#78aeed';

// Links are marked by color alone, deliberately: Pango reserves vertical space
// for an underline in the line's logical extents, so `underline="single"` made
// every row holding a link taller than the rows around it. The pointer cursor
// on hover carries the rest of the affordance.
export function buildLinkMarkup(text: string, links: LinkRange[], color: string = DEFAULT_LINK_COLOR): string {
    let out = '';
    let cursor = 0;

    for (const link of links) {
        out += GLib.markup_escape_text(text.slice(cursor, link.jsStart), -1);
        out += `<span foreground="${color}">`;
        out += GLib.markup_escape_text(text.slice(link.jsStart, link.jsEnd), -1);
        out += '</span>';
        cursor = link.jsEnd;
    }

    out += GLib.markup_escape_text(text.slice(cursor), -1);
    return out;
}

export function openUri(uri: string): void {
    try {
        const context = shellGlobal?.create_app_launch_context?.(0, -1) ?? null;
        Gio.AppInfo.launch_default_for_uri(uri, context);
    }
    catch (e) {
        console.error(`Google Tasks: failed to open ${uri}: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }

    // The link opens behind the still-open date menu otherwise.
    try {
        (Main.panel as any).closeCalendar?.();
    }
    catch {
        // Not fatal — the browser is already launching.
    }
}

// ---------------------------------------------------------------------------
// Context menu
//
// One menu exists at a time, created on demand and destroyed on an idle
// callback *after* it has finished closing: destroying a PopupMenu mid-
// animation is what produces "has been already disposed" crashes.
// ---------------------------------------------------------------------------

let openContextMenu: PopupMenu.PopupMenu | null = null;
let onContextMenuClosed: (() => void) | null = null;

// Lets a render loop that deferred while this menu was open (see hasOpenMenu()
// callers) know it can retry, the same way PopupMenu-based menus already do.
export function setOnContextMenuClosed(callback: (() => void) | null): void {
    onContextMenuClosed = callback;
}

export function isContextMenuOpen(): boolean {
    return openContextMenu !== null;
}

export function closeContextMenu(): void {
    if (!openContextMenu)
        return;
    const menu = openContextMenu;
    openContextMenu = null;
    menu.close(BoxPointer.PopupAnimation.NONE);
    onContextMenuClosed?.();
}

export function showContextMenu(sourceActor: Clutter.Actor, items: ContextMenuItem[]): void {
    if (items.length === 0)
        return;

    closeContextMenu();

    const menu = new PopupMenu.PopupMenu(sourceActor as any, 0.0, St.Side.TOP);
    menu.actor.add_style_class_name('google-tasks-context-menu');
    Main.uiGroup.add_child(menu.actor);
    menu.actor.hide();

    const manager = new PopupMenu.PopupMenuManager(sourceActor as any);
    manager.addMenu(menu);

    for (const spec of items) {
        const item = new PopupMenu.PopupMenuItem(spec.label);
        item.connect('activate', () => {
            spec.action();
        });
        menu.addMenuItem(item);
    }

    let disposed = false;
    let sourceDestroyId = 0;

    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        if (openContextMenu === menu) {
            openContextMenu = null;
            onContextMenuClosed?.();
        }
        if (sourceDestroyId)
            sourceActor.disconnect(sourceDestroyId);
        menu.close(BoxPointer.PopupAnimation.NONE);
        // Detach from the manager first: it installs a grab helper on the source
        // actor, and dropping the menu without telling it leaves that behind.
        manager.removeMenu(menu);
        menu.destroy();
    };

    sourceDestroyId = sourceActor.connect('destroy', () => dispose());

    menu.connect('open-state-changed', (_menu: any, isOpen: boolean) => {
        if (isOpen || disposed)
            return false;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            dispose();
            return GLib.SOURCE_REMOVE;
        });
        return false;
    });

    openContextMenu = menu;
    menu.open(BoxPointer.PopupAnimation.FULL);
}

// ---------------------------------------------------------------------------
// Entries: clipboard shortcuts + right-click menu
// ---------------------------------------------------------------------------

function entrySelection(clutterText: any): string {
    const selection = clutterText.get_selection();
    return selection ?? '';
}

function insertIntoEntry(clutterText: any, text: string, singleLine: boolean): void {
    const cleaned = singleLine
        ? text.replace(/\r/g, '').replace(/\s*\n\s*/g, ' ')
        : text.replace(/\r/g, '');
    if (!cleaned)
        return;

    if (entrySelection(clutterText))
        clutterText.delete_selection();

    clutterText.insert_text(cleaned, clutterText.get_cursor_position());
}

export interface EntryClipboardOptions {
    getStrings: () => TextStrings;
    /** Entries in this UI are single-line: pasted newlines collapse to spaces. */
    singleLine?: boolean;
    /** Called when Escape is pressed in the entry — typically closes the form. */
    onEscape?: () => void;
}

// GTK's blink period, halved: each tick flips the caret, so a full on/off
// cycle lands near the 1.2s the rest of the desktop uses.
const CARET_BLINK_INTERVAL_MS = 530;

// ClutterText draws a static caret — the blinking in other text fields comes
// from the toolkit above it, and St.Entry provides none. The timer runs only
// while the field has key focus, and restarts on every caret move so the caret
// stays solid while typing.
function enableBlinkingCaret(entry: St.Entry): void {
    const clutterText = entry.clutter_text as any;
    let timerId = 0;

    const stop = (visible: boolean) => {
        if (timerId) {
            GLib.source_remove(timerId);
            timerId = 0;
        }
        clutterText.set_cursor_visible(visible);
    };

    const start = () => {
        stop(true);
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CARET_BLINK_INTERVAL_MS, () => {
            // ClutterText paints the selection only while the cursor is
            // visible, so blinking the cursor over a selection blinks the
            // highlight with it. While something is selected the caret simply
            // stays on and the selection stays put.
            if (clutterText.get_selection()) {
                clutterText.set_cursor_visible(true);
                return GLib.SOURCE_CONTINUE;
            }
            clutterText.set_cursor_visible(!clutterText.get_cursor_visible());
            return GLib.SOURCE_CONTINUE;
        });
    };

    clutterText.connect('key-focus-in', () => {
        start();
        return false;
    });
    clutterText.connect('key-focus-out', () => {
        stop(false);
        return false;
    });
    clutterText.connect('cursor-changed', () => {
        if (timerId)
            start();
        return false;
    });
    entry.connect('destroy', () => {
        stop(false);
        return false;
    });

    if (clutterText.has_key_focus?.())
        start();
}

// ClutterText keeps no edit history, so Ctrl+Z needs one kept here. Entries
// hold single lines, so whole-text snapshots are cheap; keystrokes within
// COALESCE_MS collapse into one step, so undo moves by word, not by letter.
const UNDO_COALESCE_MS = 400;
const UNDO_DEPTH = 100;

interface EditState {
    text: string;
    cursor: number;
}

function enableUndoHistory(entry: St.Entry): { undo: () => void; redo: () => void } {
    const clutterText = entry.clutter_text as any;

    const undoStack: EditState[] = [];
    const redoStack: EditState[] = [];
    let committed: EditState = { text: entry.get_text(), cursor: -1 };
    let lastPushMs = 0;
    let applying = false;

    clutterText.connect('text-changed', () => {
        if (applying)
            return false;

        const now = GLib.get_monotonic_time() / 1000;
        if (now - lastPushMs > UNDO_COALESCE_MS || undoStack.length === 0) {
            undoStack.push(committed);
            if (undoStack.length > UNDO_DEPTH)
                undoStack.shift();
            lastPushMs = now;
        }

        committed = { text: entry.get_text(), cursor: clutterText.get_cursor_position() };
        redoStack.length = 0;
        return false;
    });

    const restore = (state: EditState) => {
        applying = true;
        entry.set_text(state.text);
        clutterText.set_selection(state.cursor, state.cursor);
        applying = false;
        committed = state;
        lastPushMs = 0;
    };

    return {
        undo: () => {
            const previous = undoStack.pop();
            if (!previous)
                return;
            redoStack.push(committed);
            restore(previous);
        },
        redo: () => {
            const next = redoStack.pop();
            if (!next)
                return;
            undoStack.push(committed);
            restore(next);
        },
    };
}

// ClutterText moves by word but does not delete by word, so Ctrl+Backspace and
// Ctrl+Delete compute the range themselves.
function deleteWord(clutterText: any, forward: boolean): void {
    const text: string = clutterText.get_text() ?? '';
    const cursor: number = clutterText.get_cursor_position();
    const position = cursor < 0 ? text.length : cursor;

    let target = position;
    if (forward) {
        while (target < text.length && /\s/.test(text[target]))
            target++;
        while (target < text.length && !/\s/.test(text[target]))
            target++;
    }
    else {
        while (target > 0 && /\s/.test(text[target - 1]))
            target--;
        while (target > 0 && !/\s/.test(text[target - 1]))
            target--;
    }

    if (target !== position)
        clutterText.delete_text(Math.min(target, position), Math.max(target, position));
}

export function enableEntryClipboard(entry: St.Entry, options: EntryClipboardOptions): void {
    const clutterText = entry.clutter_text as any;
    const singleLine = options.singleLine ?? true;

    // Clipboard reads are asynchronous: the entry can be destroyed (form
    // closed/saved) before the callback fires, and inserting into a disposed
    // ClutterText throws.
    let destroyed = false;
    entry.connect('destroy', () => {
        destroyed = true;
    });

    clutterText.set_selectable(true);

    // Collapse any selection when the field takes focus. ClutterText can arrive
    // focused with its selection bound still at 0 and the caret at the end,
    // which renders as the whole text selected — and hides the caret, since
    // Clutter draws one or the other.
    clutterText.connect('key-focus-in', () => {
        const position = clutterText.get_cursor_position();
        clutterText.set_selection(position, position);
        return false;
    });

    enableBlinkingCaret(entry);
    const history = enableUndoHistory(entry);

    const copySelection = (cut: boolean): boolean => {
        const selected = entrySelection(clutterText);
        if (!selected)
            return false;
        copyToClipboard(selected);
        if (cut)
            clutterText.delete_selection();
        return true;
    };

    const paste = () => readClipboard((text) => {
        if (destroyed)
            return;
        insertIntoEntry(clutterText, text, singleLine);
    });

    clutterText.connect('key-press-event', (_actor: any, event: any) => {
        const state = event.get_state();
        const symbol = event.get_key_symbol();
        const ctrl = hasCtrl(state);
        const shift = hasShift(state);

        if (ctrl && KEY_COPY.has(symbol)) {
            copySelection(false);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && KEY_CUT.has(symbol)) {
            copySelection(true);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && KEY_PASTE.has(symbol)) {
            paste();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && KEY_SELECT_ALL.has(symbol)) {
            clutterText.set_selection(0, -1);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && KEY_UNDO.has(symbol)) {
            // Ctrl+Shift+Z is redo on this desktop, same as Ctrl+Y.
            if (shift)
                history.redo();
            else
                history.undo();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && KEY_REDO.has(symbol)) {
            history.redo();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (symbol === Clutter.KEY_BackSpace || symbol === Clutter.KEY_Delete)) {
            if (entrySelection(clutterText))
                clutterText.delete_selection();
            else
                deleteWord(clutterText, symbol === Clutter.KEY_Delete);
            return Clutter.EVENT_STOP;
        }
        // The other half of the classic pair: Ctrl+Insert / Shift+Insert.
        if (symbol === Clutter.KEY_Insert || symbol === Clutter.KEY_KP_Insert) {
            if (ctrl) {
                copySelection(false);
                return Clutter.EVENT_STOP;
            }
            if (shift) {
                paste();
                return Clutter.EVENT_STOP;
            }
        }
        if (symbol === Clutter.KEY_Escape && options.onEscape) {
            options.onEscape();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    });

    entry.connect('button-press-event', (_actor: any, event: any) => {
        if (event.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;

        const strings = options.getStrings();
        const hasSelection = entrySelection(clutterText).length > 0;
        const items: ContextMenuItem[] = [];

        if (hasSelection) {
            items.push({ label: strings.copy, action: () => copySelection(false) });
            items.push({ label: strings.cut, action: () => copySelection(true) });
        }
        items.push({
            label: strings.paste,
            action: () => {
                entry.grab_key_focus();
                paste();
            },
        });
        if (entry.get_text().length > 0) {
            items.push({
                label: strings.selectAll,
                action: () => {
                    entry.grab_key_focus();
                    clutterText.set_selection(0, -1);
                },
            });
        }

        showContextMenu(entry, items);
        return Clutter.EVENT_STOP;
    });

    // Middle-click pastes the PRIMARY selection, as everywhere else on X11/Wayland.
    entry.connect('button-release-event', (_actor: any, event: any) => {
        if (event.get_button() !== Clutter.BUTTON_MIDDLE)
            return Clutter.EVENT_PROPAGATE;
        entry.grab_key_focus();
        St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, (_clipboard: any, text: string | null) => {
            if (destroyed || !text)
                return;
            insertIntoEntry(clutterText, text, singleLine);
        });
        return Clutter.EVENT_STOP;
    });
}

// ---------------------------------------------------------------------------
// Labels: selectable text, Ctrl+C, clickable links, right-click menu
// ---------------------------------------------------------------------------

// St.Entry takes its selection colors from the theme; St.Label does not. The
// values are read back from the label's own theme node rather than built in JS,
// because the color type moved from Clutter to Cogl between shell versions and
// the theme node hands over whichever one this version expects. See the
// selection-background-color rules in stylesheet.css.
function applySelectionColorsFromTheme(label: St.Label): void {
    const clutterText = label.clutter_text as any;

    const apply = () => {
        try {
            const node = (label as any).get_theme_node?.();
            if (!node)
                return;

            const [hasBackground, background] = node.lookup_color('selection-background-color', false);
            if (hasBackground)
                clutterText.selection_color = background;

            const [hasForeground, foreground] = node.lookup_color('selected-color', false);
            if (hasForeground)
                clutterText.selected_text_color = foreground;
        }
        catch {
            // Purely cosmetic — selection still works with the defaults.
        }
    };

    label.connect('style-changed', () => {
        apply();
        return false;
    });
    apply();
}

export interface RichLabelOptions {
    getStrings: () => TextStrings;
    /**
     * Plain text of the label — markup is generated from this. Omit it for a
     * label whose text is reassigned later: the current text is then read back
     * from the label itself (link markup is only built for static text).
     */
    text?: string;
    enableLinks?: boolean;
    linkColor?: string;
    /** Extra entries appended to the right-click menu. */
    extraMenuItems?: () => ContextMenuItem[];
}

export interface RichLabelHandle {
    /** Currently selected text, or the whole label when nothing is selected. */
    getSelectedOrAll: () => string;
    links: LinkRange[];
}

function linkAtStagePoint(label: St.Label, links: LinkRange[], stageX: number, stageY: number): LinkRange | null {
    if (links.length === 0)
        return null;

    const clutterText = label.clutter_text as any;
    const [ok, x, y] = clutterText.transform_stage_point(stageX, stageY);
    if (!ok)
        return null;

    // Pango's own hit test, rather than coords_to_position(): it reports whether
    // the point actually landed inside a glyph run, so clicking the empty space
    // to the right of a line that ends in a URL doesn't launch a browser.
    let inside = false;
    let index = -1;
    try {
        const layout = clutterText.get_layout();
        const result = layout.xy_to_index(Math.round(x * Pango.SCALE), Math.round(y * Pango.SCALE));
        inside = result[0];
        index = result[1];
    }
    catch {
        return null;
    }

    if (!inside || index < 0)
        return null;

    return links.find(link => index >= link.byteStart && index < link.byteEnd) ?? null;
}

// Colors the link runs without touching the label's text. Pango markup would
// mean replacing the text and letting an attribute list drive the layout's
// measurements; parsing the markup separately and handing over only the
// attributes keeps get_text() plain and the geometry untouched.
//
// The attributes are re-applied on every style change because St.Label sets its
// own attribute list from the theme (that's how it implements underline and
// line-through), and doing so replaces whatever was there — which is why the
// link color silently disappeared as soon as the row got its style.
function applyLinkAttributes(label: St.Label, text: string, links: LinkRange[], color: string): void {
    const clutterText = label.clutter_text as any;
    const inner = buildLinkMarkup(text, links, color);

    let applying = false;
    const apply = () => {
        if (applying)
            return;
        applying = true;

        try {
            // The base color is spelled out around the whole string rather than
            // left to the label: once ClutterText is painting from an attribute
            // list, the runs without a foreground attribute of their own come
            // out black instead of taking the label's own color.
            const base = foregroundHex(label);
            const markup = base ? `<span foreground="${base}">${inner}</span>` : inner;
            const [parsed, attributes] = Pango.parse_markup(markup, -1, '\u0001');
            if (parsed)
                clutterText.set_attributes(attributes);
        }
        catch {
            // Styling only — never let it break the row.
        }

        applying = false;
    };

    // connect_after, not connect: St.Label sets its own attribute list from the
    // class closure of this same signal, and a plain handler runs before that —
    // so the link color was applied and then immediately overwritten.
    label.connect_after('style-changed', () => {
        apply();
        return false;
    });
    apply();
}

// The label's own text color, as #rrggbb. Clutter.Color stores components as
// bytes and Cogl.Color (GNOME 48+) as floats, so both are accepted.
function foregroundHex(label: St.Label): string | null {
    try {
        const color = (label as any).get_theme_node?.()?.get_foreground_color?.();
        if (!color)
            return null;

        const parts = [color.red, color.green, color.blue];
        if (parts.some(part => typeof part !== 'number'))
            return null;

        const gtype = (color as any).constructor?.$gtype?.name ?? '';
        const scale = gtype.startsWith('Cogl') || parts.every(part => part <= 1) ? 255 : 1;

        return `#${parts
            .map(part => Math.max(0, Math.min(255, Math.round(part * scale))).toString(16).padStart(2, '0'))
            .join('')}`;
    }
    catch {
        return null;
    }
}

export function setupRichLabel(label: St.Label, options: RichLabelOptions): RichLabelHandle {
    const clutterText = label.clutter_text as any;
    const staticText = options.text;
    const currentText = (): string => staticText ?? label.get_text() ?? '';
    const text = currentText();
    // Link markup is only meaningful for text that won't be reassigned later.
    const links = options.enableLinks === false || staticText === undefined
        ? []
        : findLinks(text);

    if (links.length > 0)
        applyLinkAttributes(label, text, links, options.linkColor ?? DEFAULT_LINK_COLOR);

    label.reactive = true;
    label.track_hover = true;
    clutterText.reactive = true;
    clutterText.cursor_visible = false;
    // Not selectable: ClutterText only paints a selection on text it considers
    // editable, and editable text stops ellipsizing (see below). A selection
    // that exists but is never drawn is worse than none, so copying goes
    // through Ctrl+C and the right-click menu, both on the whole label.
    clutterText.selectable = false;
    // Editable text in Clutter stops ellipsizing — every character has to be
    // reachable by the caret — which costs the trailing "…" and lets long
    // descriptions spill out of their row.
    clutterText.editable = false;
    applySelectionColorsFromTheme(label);

    const getSelectedOrAll = (): string => currentText();

    const buildMenu = (link: LinkRange | null): ContextMenuItem[] => {
        const strings = options.getStrings();
        const items: ContextMenuItem[] = [];

        if (link) {
            items.push({ label: strings.openLink, action: () => openUri(link.uri) });
            items.push({ label: strings.copyLink, action: () => copyToClipboard(link.text) });
        }
        if (currentText().length > 0)
            items.push({ label: strings.copy, action: () => copyToClipboard(getSelectedOrAll()) });

        return items.concat(options.extraMenuItems?.() ?? []);
    };

    clutterText.connect('key-press-event', (_actor: any, event: any) => {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = hasCtrl(state);

        if (ctrl && (KEY_COPY.has(symbol) || symbol === Clutter.KEY_Insert)) {
            copyToClipboard(getSelectedOrAll());
            return Clutter.EVENT_STOP;
        }

        // Dropping anything that would edit the text keeps the label read-only.
        // Escape, Tab and the arrows pass through so the popup stays navigable.
        const wouldEdit = symbol === Clutter.KEY_BackSpace
            || symbol === Clutter.KEY_Delete
            || symbol === Clutter.KEY_Return
            || symbol === Clutter.KEY_KP_Enter
            || (!ctrl && Clutter.keysym_to_unicode(symbol) !== 0);
        if (wouldEdit)
            return Clutter.EVENT_STOP;
        if (ctrl && (KEY_PASTE.has(symbol) || KEY_CUT.has(symbol)))
            return Clutter.EVENT_STOP;

        return Clutter.EVENT_PROPAGATE;
    });

    // Only button-press is handled. Intercepting button-release breaks
    // ClutterText's implicit pointer grab, which it releases there.
    clutterText.connect('button-press-event', (_actor: any, event: any) => {
        const button = event.get_button();
        const [x, y] = event.get_coords();

        if (button === Clutter.BUTTON_SECONDARY) {
            showContextMenu(label, buildMenu(linkAtStagePoint(label, links, x, y)));
            return Clutter.EVENT_STOP;
        }

        if (button === Clutter.BUTTON_PRIMARY) {
            const link = linkAtStagePoint(label, links, x, y);
            if (link) {
                // On press, not release: ClutterText stops the release event to
                // finish its own drag handling, so a release handler never runs.
                openUri(link.uri);
                return Clutter.EVENT_STOP;
            }
        }

        // Key focus is what makes Ctrl+C reach the handler above.
        clutterText.grab_key_focus();
        return Clutter.EVENT_PROPAGATE;
    });

    return { getSelectedOrAll, links };
}