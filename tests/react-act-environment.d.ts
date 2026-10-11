// React only enables act() warnings when this flag is set. jsdom component tests
// opt in before rendering, so the flag must exist on globalThis for TypeScript.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

export {};
