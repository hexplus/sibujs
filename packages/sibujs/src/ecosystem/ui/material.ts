import { type AdapterConfig, componentAdapter } from "./componentAdapter";

/**
 * Material Design component adapter for SibuJS.
 *
 * Provides SibuJS component wrappers that apply Material Design Web
 * CSS classes. Requires `@material/web` or `material-components-web`
 * CSS to be loaded in the page.
 */
const materialConfig: AdapterConfig = {
  name: "material",
  prefix: "mdc",
  components: {
    Button: {
      tag: "button",
      baseClass: "mdc-button",
      variants: {
        raised: "mdc-button--raised",
        outlined: "mdc-button--outlined",
        text: "mdc-button--text",
        unelevated: "mdc-button--unelevated",
      },
      sizes: {
        sm: "mdc-button--dense",
      },
      defaultProps: { type: "button" },
    },
    Input: {
      tag: "div",
      baseClass: "mdc-text-field",
      variants: {
        outlined: "mdc-text-field--outlined",
        filled: "mdc-text-field--filled",
      },
    },
    Card: {
      tag: "div",
      baseClass: "mdc-card",
      variants: {
        outlined: "mdc-card--outlined",
        elevated: "mdc-card--elevated",
      },
    },
    Modal: {
      tag: "div",
      baseClass: "mdc-dialog",
      variants: {
        fullscreen: "mdc-dialog--fullscreen",
      },
    },
    Chip: {
      tag: "span",
      baseClass: "mdc-chip",
      variants: {
        outlined: "mdc-chip--outlined",
      },
    },
    List: {
      tag: "ul",
      baseClass: "mdc-list",
      variants: {
        dense: "mdc-list--dense",
      },
    },
    ListItem: {
      tag: "li",
      baseClass: "mdc-list-item",
    },
  },
};

export const materialAdapter = componentAdapter(materialConfig);
