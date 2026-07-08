import { type AdapterConfig, componentAdapter } from "./componentAdapter";

/**
 * Chakra UI component adapter for SibuJS.
 * Requires Chakra UI CSS to be loaded in the page.
 */
const chakraConfig: AdapterConfig = {
  name: "chakra",
  prefix: "chakra",
  components: {
    Button: {
      tag: "button",
      baseClass: "chakra-button",
      variants: {
        solid: "chakra-button--solid",
        outline: "chakra-button--outline",
        ghost: "chakra-button--ghost",
        link: "chakra-button--link",
      },
      sizes: {
        xs: "chakra-button--xs",
        sm: "chakra-button--sm",
        md: "chakra-button--md",
        lg: "chakra-button--lg",
      },
      defaultProps: { type: "button" },
    },
    Input: {
      tag: "input",
      baseClass: "chakra-input",
      variants: {
        outline: "chakra-input--outline",
        filled: "chakra-input--filled",
        flushed: "chakra-input--flushed",
        unstyled: "chakra-input--unstyled",
      },
      sizes: {
        xs: "chakra-input--xs",
        sm: "chakra-input--sm",
        md: "chakra-input--md",
        lg: "chakra-input--lg",
      },
    },
    Card: {
      tag: "div",
      baseClass: "chakra-card",
      variants: {
        elevated: "chakra-card--elevated",
        outline: "chakra-card--outline",
        filled: "chakra-card--filled",
        unstyled: "chakra-card--unstyled",
      },
    },
    Modal: {
      tag: "div",
      baseClass: "chakra-modal__content",
    },
    Badge: {
      tag: "span",
      baseClass: "chakra-badge",
      variants: {
        solid: "chakra-badge--solid",
        subtle: "chakra-badge--subtle",
        outline: "chakra-badge--outline",
      },
    },
    Stack: {
      tag: "div",
      baseClass: "chakra-stack",
      variants: {
        horizontal: "chakra-stack--horizontal",
        vertical: "chakra-stack--vertical",
      },
    },
  },
};

export const chakraAdapter = componentAdapter(chakraConfig);
