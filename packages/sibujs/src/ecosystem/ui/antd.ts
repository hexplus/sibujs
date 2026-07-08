import { type AdapterConfig, componentAdapter } from "./componentAdapter";

/**
 * Ant Design component adapter for SibuJS.
 * Requires Ant Design CSS to be loaded in the page.
 */
const antdConfig: AdapterConfig = {
  name: "antd",
  prefix: "ant",
  components: {
    Button: {
      tag: "button",
      baseClass: "ant-btn",
      variants: {
        primary: "ant-btn-primary",
        dashed: "ant-btn-dashed",
        text: "ant-btn-text",
        link: "ant-btn-link",
        default: "ant-btn-default",
        danger: "ant-btn-dangerous",
      },
      sizes: {
        sm: "ant-btn-sm",
        lg: "ant-btn-lg",
      },
      defaultProps: { type: "button" },
    },
    Input: {
      tag: "input",
      baseClass: "ant-input",
      sizes: {
        sm: "ant-input-sm",
        lg: "ant-input-lg",
      },
    },
    Card: {
      tag: "div",
      baseClass: "ant-card",
      variants: {
        bordered: "ant-card-bordered",
      },
    },
    Modal: {
      tag: "div",
      baseClass: "ant-modal",
    },
    Tag: {
      tag: "span",
      baseClass: "ant-tag",
      variants: {
        success: "ant-tag-success",
        error: "ant-tag-error",
        warning: "ant-tag-warning",
        processing: "ant-tag-processing",
      },
    },
    Badge: {
      tag: "span",
      baseClass: "ant-badge",
    },
    Avatar: {
      tag: "span",
      baseClass: "ant-avatar",
      sizes: {
        sm: "ant-avatar-sm",
        lg: "ant-avatar-lg",
      },
    },
  },
};

export const antdAdapter = componentAdapter(antdConfig);
