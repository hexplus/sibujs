export interface ReactiveSignal {
  _subscribe?: (subscriber: () => void) => () => void;
}
