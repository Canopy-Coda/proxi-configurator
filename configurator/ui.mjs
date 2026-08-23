//
// ui.mjs — tiny DOM helpers. h(tag, props, ...children) builds elements;
// class strings ride the tag ("div.a.b"). No vdom: views rebuild whole
// subtrees on state change, but the render loop applies them through
// morphChildren() below, which keeps existing DOM nodes in place when tag +
// data-key match. Node identity survives re-renders, so the OS cursor,
// :hover state, scroll position, and focus are never reset by a render —
// full-tree replaceChildren() made the cursor flicker on every store notify
// (worst with a device streaming CC over Web MIDI).
//
// The contract views must hold up their end of:
// - UI state (open panels, picked options, slider positions) lives in the
//   STORE, never in DOM nodes or per-render closures. Morph keeps the
//   first-render DOM but swaps in each render's listeners — a listener that
//   closes over its own render's nodes mutates a discarded tree, and any
//   store notify re-syncs attributes/values from the fresh render, wiping
//   imperative DOM tweaks (the 2026-07-13 unopenable-bind-sections bug).
// - Imperative DOM is allowed only where morph never runs mid-gesture (drag
//   previews), and even there handlers must resolve nodes at event time
//   (e.currentTarget/closest) and self-heal on the next event.
//

export function h(tag, props = {}, ...children) {
  // second arg may be a child (Node/string/array) rather than props
  if (props instanceof Node || typeof props === "string" || typeof props === "number" || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) {
      el.addEventListener(k.slice(2), v);
      (el.__on ??= []).push([k.slice(2), v]); // morph swaps these on retained nodes
    }
    else if (k in el && k !== "list" && k !== "form") {
      try { el[k] = v; } catch { el.setAttribute(k, v); }
    } else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...[children].flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

// ── DOM morph ───────────────────────────────────────────────────────────────
// Reconcile parent's live children against a freshly h()-built list. A live
// node is kept (and patched) when node type, tag, and data-key all match;
// otherwise it is replaced. Listeners registered through h() are swapped via
// the __on registry; listeners added imperatively (drag handlers) survive.

const sameShape = (o, n) =>
  o.nodeType === n.nodeType &&
  (o.nodeType !== Node.ELEMENT_NODE ||
    (o.nodeName === n.nodeName && (o.dataset.key ?? null) === (n.dataset.key ?? null)));

// Form state lives in properties, not attributes — sync it explicitly.
const FORM_PROPS = { INPUT: ["value", "checked"], TEXTAREA: ["value"], SELECT: ["value"], OPTION: ["selected"] };

function morphNode(o, n) {
  if (o.nodeType === Node.TEXT_NODE) {
    if (o.data !== n.data) o.data = n.data;
    return;
  }
  for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of [...n.attributes]) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  for (const p of FORM_PROPS[o.nodeName] ?? []) if (o[p] !== n[p]) o[p] = n[p];
  for (const [t, f] of o.__on ?? []) o.removeEventListener(t, f);
  for (const [t, f] of n.__on ?? []) o.addEventListener(t, f);
  o.__on = n.__on;
  morphChildren(o, [...n.childNodes]);
}

export function morphChildren(parent, newKids) {
  newKids = [newKids].flat(Infinity).filter((c) => c != null && c !== false);
  const old = [...parent.childNodes];
  for (let i = 0; i < newKids.length; i++) {
    const n = typeof newKids[i] === "string" || typeof newKids[i] === "number"
      ? document.createTextNode(newKids[i]) : newKids[i];
    const o = old[i];
    if (!o) parent.append(n);
    else if (!sameShape(o, n)) o.replaceWith(n);
    else morphNode(o, n);
  }
  while (parent.childNodes.length > newKids.length) parent.lastChild.remove();
}

// ── Segmented control ──────────────────────────────────────────────────────
// The app's standard exclusive-choice control. options: [{value, label}];
// `cls` adds a variant class on the wrapper (e.g. "cust-seg").
export function segmented(options, value, onPick, cls = "") {
  return h("div.segmented", { class: cls },
    options.map((o) => h("button.seg", {
      class: o.value === value ? "on" : "",
      onclick: () => o.value !== value && onPick(o.value),
    }, o.label)));
}

// ── Stacked hidden-page divider (design_handoff_bank_switching §5) ─────────
// The violet rule between the MAIN and HIDDEN glasses — shared by the
// LAYOUTS plate and the DEVICE live mirror so the gesture copy can never
// drift between the two.
export const stackDivider = () =>
  h("div.stack-divider",
    h("span.sd-line"),
    h("span.sd-label", {}, "HIDDEN PAGE · SHOWN WHILE SW2+SW3 ARE HELD"),
    h("span.sd-line"));

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  f.append(...[children].flat(Infinity).filter((c) => c != null && c !== false));
  return f;
};

// Focus preservation across re-renders: elements opt in with
// data-focus-key; after a render, restoreFocus() puts the caret back.
export function captureFocus() {
  const el = document.activeElement;
  if (!el?.dataset?.focusKey) return null;
  return {
    key: el.dataset.focusKey,
    start: el.selectionStart, end: el.selectionEnd,
  };
}
export function restoreFocus(saved) {
  if (!saved) return;
  const el = document.querySelector(`[data-focus-key="${CSS.escape(saved.key)}"]`);
  if (!el) return;
  el.focus();
  if (saved.start != null && el.setSelectionRange) {
    try { el.setSelectionRange(saved.start, saved.end); } catch { /* number inputs */ }
  }
}
