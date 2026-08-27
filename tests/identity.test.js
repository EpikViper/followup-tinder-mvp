import test from "node:test";
import assert from "node:assert/strict";
import { canonicalLinkedinUrl, linkedinSlugName, normalizePersonName } from "../src/identity.js";

test("person names normalize accents, punctuation, spacing, and emoji", () => {
  assert.equal(normalizePersonName("  🔥 Tháïs   O’Connor  "), "thais o connor");
});

test("public LinkedIn slugs provide strong name aliases", () => {
  assert.equal(linkedinSlugName("https://linkedin.com/in/matt-prewitt3/"), "matt prewitt");
  assert.equal(linkedinSlugName("https://www.linkedin.com/in/rumen-marinov-00b458174"), "rumen marinov");
  assert.equal(linkedinSlugName("https://www.linkedin.com/in/matt-p-35531a151"), null);
});

test("opaque LinkedIn member URLs are not treated as person names", () => {
  assert.equal(linkedinSlugName("https://www.linkedin.com/in/ACoAABlDfzsBp-HiTDia-C7rx29NV9UpTuhhXuQ"), null);
  assert.equal(canonicalLinkedinUrl("linkedin.com/in/Matt-Prewitt3/"), "https://www.linkedin.com/in/matt-prewitt3");
});
