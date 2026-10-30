import { button, div, form, h1, input, label, signal } from "sibujs";

export const Quote = () => {
  const [sent, setSent] = signal(false);
  return div({ class: "page quote" }, [
    h1("Get a quote"),
    form({ on: { submit: (e: Event) => {
        e.preventDefault();
        setSent(true);
      },
    } }, [
      label({ for: "vehicle" }, "Vehicle"),
      input({ id: "vehicle", name: "vehicle" }),
      button({ type: "submit" }, "Send"),
    ]),
    div({ class: "status" }, () => (sent() ? "Thanks! We will reply within 24 hours." : "")),
  ]);
};
