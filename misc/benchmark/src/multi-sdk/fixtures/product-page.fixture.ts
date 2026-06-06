// core/src/benchmarks/multi-sdk/fixtures/product-page.fixture.ts

import { retrofit } from "./retrofit";

export const productPage = retrofit("product-page", {
  expected: {
    vector: {
      render: "static",
      state: "ui-affordance",
      writes: "commit",
      writeTrigger: "click",
      realtime: "none",
      fetch: "none",
      layout: "single",
    tooling: "none",
    },
    riskTier: "medium",
    provenance: {
      render: "contract",
      state: "prompt",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "default",
    tooling: "default",
    },
  },
  evalGoals: [
    "Product detail renders from props.product (image, title, price, rating, stock badge)",
    "Tab state via useState — description / specifications / reviews",
    "Quantity state via useState with increment/decrement",
    "addToCart invoked with correct {productId, quantity} on click",
    "Add to Cart disabled when out of stock",
  ],
  whyNotReducible:
    "Render + single small-payload commit action. display subShape=commit case. " +
    "Distinct from forms (payload is 2 keys, not ≥3) and from collection (no arr<obj> entity list).",
});

export default productPage;
