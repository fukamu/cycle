import {
  cycleSchema,
  draftSchema,
  goalVersionSchema,
  saveFrameSchema,
} from "./schemas";

describe("text response schemas", () => {
  it("accepts 80 Goal code points, rejects 81/NUL, and normalizes line endings", () => {
    for (const schema of [
      draftSchema.shape.body,
      goalVersionSchema.shape.body,
    ]) {
      const maximum = "😀".repeat(80);
      expect(schema.safeParse(maximum).success).toBe(true);
      expect(schema.safeParse(`${maximum}😀`).success).toBe(false);
      expect(schema.safeParse("goal\0text").success).toBe(false);
      expect(schema.parse(" goal\r\ntext\r ")).toBe(" goal\ntext\n ");
    }
  });

  it("accepts 200 Frame code points, rejects 201/NUL, and normalizes line endings", () => {
    for (const schema of [
      cycleSchema.shape.plan,
      saveFrameSchema.shape.content,
    ]) {
      const maximum = "😀".repeat(200);
      expect(schema.safeParse(maximum).success).toBe(true);
      expect(schema.safeParse(`${maximum}😀`).success).toBe(false);
      expect(schema.safeParse("frame\0text").success).toBe(false);
      expect(schema.parse(" frame\r\ntext\r ")).toBe(" frame\ntext\n ");
    }
  });
});
