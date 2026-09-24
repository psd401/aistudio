// Mock for @radix-ui/react-slot.
//
// It needs its own module-mapper entry (Issue #1697). Every `@radix-ui/*`
// specifier used to map to tests/mocks/radix-ui-primitives.js, so the
// per-package `jest.mock('@radix-ui/react-<x>', …)` factories in jest.setup.js
// all registered against that one resolved path and clobbered each other —
// only the last (`react-scroll-area`) survived. Slot therefore resolved to
// `undefined`, and any test rendering a shadcn `<FormControl>` (which renders
// `<Slot>`) died with "Element type is invalid".
//
// Slot is not a rendered element: it merges its props onto its single child.
const React = require('react');

const Slot = React.forwardRef(({ children, ...slotProps }, ref) => {
  if (React.Children.count(children) === 1) {
    const child = React.Children.only(children);
    if (React.isValidElement(child)) {
      // Child props win so an explicit prop at the call site is never clobbered
      // by the slot's defaults — this matches Radix's own precedence.
      return React.cloneElement(child, { ...slotProps, ...child.props, ref });
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
