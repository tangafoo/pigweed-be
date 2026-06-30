import { describe, it, expect } from "bun:test";
import { pluralizeAnimal } from "../src/utils/animal-grammar";

// Pure function, no DB/auth. Guards the email copy against "gooses".
describe("pluralizeAnimal", () => {
  it("uses the irregular plural for goose", () => {
    expect(pluralizeAnimal("goose")).toBe("geese");
  });

  it("adds 's' to regular animals", () => {
    expect(pluralizeAnimal("chicken")).toBe("chickens");
    expect(pluralizeAnimal("dog")).toBe("dogs");
    expect(pluralizeAnimal("duck")).toBe("ducks");
    expect(pluralizeAnimal("cat")).toBe("cats");
    expect(pluralizeAnimal("lizard")).toBe("lizards");
  });

  it("is case-insensitive and returns lowercase", () => {
    expect(pluralizeAnimal("GOOSE")).toBe("geese");
    expect(pluralizeAnimal("Goose")).toBe("geese");
    expect(pluralizeAnimal("CHICKEN")).toBe("chickens");
  });
});
