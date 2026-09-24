// Mock for @radix-ui/react-slot.
//
// It needs its own module-mapper entry (Issue #1697): as a jest.mock() factory
// in jest.setup.js it did not take effect, because the `^@radix-ui/(.*)$`
// catch-all maps every unlisted Radix specifier to the single shared file
// tests/mocks/radix-ui-primitives.js and those factories interfere. `Slot`
// resolved to `undefined`, and any test rendering a shadcn `<FormControl>`
// (which renders `<Slot>`) died with "Element type is invalid". See the
// comment above the Radix block in jest.setup.js.
//
// Slot is not a rendered element: it merges its props onto its single child.
const React = require('react');

function assignRef(ref, value) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref && typeof ref === 'object') {
    ref.current = value;
  }
}

/**
 * Real Radix COMPOSES the slot's ref with the child's own ref
 * (`composeRefs(forwardedRef, childrenRef)`); it does not replace it. The mock
 * must too, or it silently breaks the child's ref — which is exactly how
 * react-hook-form's `field.ref` reaches an input inside `<FormControl>`. With a
 * replacing mock, `form.setFocus("name")` was a no-op in jsdom while working
 * fine in a browser, so a test could not tell the two apart (Issue #1697).
 */
function composeRefs(...refs) {
  const present = refs.filter(ref => ref !== null && ref !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return node => {
    for (const ref of present) assignRef(ref, node);
  };
}

const Slot = React.forwardRef(({ children, ...slotProps }, ref) => {
  if (React.Children.count(children) === 1) {
    const child = React.Children.only(children);
    if (React.isValidElement(child)) {
      // Child props win so an explicit prop at the call site is never clobbered
      // by the slot's defaults — this matches Radix's own precedence. React 19
      // passes `ref` as an ordinary prop, so read it from props as well as from
      // the legacy `child.ref` before composing.
      const childRef = child.props?.ref ?? child.ref;
      const composed = composeRefs(ref, childRef);
      const merged = { ...slotProps, ...child.props };
      if (composed !== undefined) merged.ref = composed;
      return React.cloneElement(child, merged);
    }
  }
  return React.createElement('div', { ...slotProps, ref }, children);
});
Slot.displayName = 'Slot';

const SlotClone = React.forwardRef(({ children, ...props }, ref) =>
  React.createElement('span', { ...props, ref }, children)
);
SlotClone.displayName = 'SlotClone';

const createSlot = (name) => ({
  __scopedNameSlot: Symbol(name),
  Provider: ({ children }) => children,
  Slot,
  SlotClone,
});

module.exports = { Slot, SlotClone, createSlot };
module.exports.default = module.exports;
